/**
 * Writing the board's settings, as a state machine over an abstract transport.
 *
 * Same shape and the same reasoning as `session.ts`: the CFG characteristic is
 * `WRITE_ENC` exactly like CTRL and DATA, so this is the same connect-and-bond
 * dance as an upload, and the part that can be silently wrong is kept testable
 * against a fake board. Mirrors `Daemon._config_session()` in the desktop app.
 *
 * The order matters and is deliberate: read what is stored *before* writing.
 * It is what puts "it currently reports X" in the log, and it is how a board
 * running firmware too old to have the characteristic is diagnosed before
 * anything has been sent to it.
 */
import { Gate, waitAny } from '../lib/gate';
import {
  BoardConfig,
  CFG_ACK_TIMEOUT_MS,
  CFG_UNSUPPORTED,
  CFG_UNSUPPORTED_HINT,
  ConfigError,
  StoredConfig,
  decodeConfigTlv,
  encodeConfigTlv,
  summarizeStored,
} from './config';
import { decodeStatus } from './protocol';

export interface CfgIo {
  /** Read the CFG characteristic. Throws MissingCharacteristic on old firmware. */
  readCfg(): Promise<Uint8Array>;
  /** Write the CFG characteristic, always with a response. */
  writeCfg(bytes: Uint8Array): Promise<void>;
  /** Largest payload one write carries, from the negotiated MTU. */
  readonly chunkSize: number;
}

/**
 * The board has no ff05 at all - a capability fact, not a fault.
 *
 * The transport adapter raises this so that nothing below it has to know how
 * react-native-ble-plx spells "characteristic not found".
 */
export class MissingCharacteristicError extends Error {}

export interface CfgEvents {
  onLog?: (msg: string, level?: 'info' | 'warn' | 'error') => void;
  /** What the board reported holding, before this write changed anything. */
  onStored?: (stored: StoredConfig) => void;
}

export interface CfgOutcome {
  ok: boolean;
  error?: string;
  hint?: string;
  /** What the board held before the write, when it could be read. */
  stored?: StoredConfig;
  /** The firmware predates the settings characteristic. */
  unsupported?: boolean;
}

export interface CfgOptions {
  /** Injectable so tests do not sit out the real 15 seconds. */
  ackTimeoutMs?: number;
}

export class ConfigSession {
  private readonly acked = new Gate();
  private readonly failed = new Gate();
  private readonly dropped = new Gate();

  private deviceError: string | null = null;
  private deviceHint: string | null = null;
  private readonly ackTimeoutMs: number;

  constructor(
    private readonly io: CfgIo,
    private readonly events: CfgEvents = {},
    options: CfgOptions = {}
  ) {
    this.ackTimeoutMs = options.ackTimeoutMs ?? CFG_ACK_TIMEOUT_MS;
  }

  /** Feed one STAT notification in. The transport calls this. */
  pushStatus(data: Uint8Array): void {
    const ev = decodeStatus(data);
    if (!ev) return;
    if (ev.kind === 'cfg') {
      this.acked.set();
    } else if (ev.kind === 'error') {
      this.deviceError = `${ev.title} (device code 0x${ev.code
        .toString(16)
        .padStart(2, '0')
        .toUpperCase()})`;
      this.deviceHint = ev.hint;
      this.failed.set();
    }
  }

  /**
   * Tell the session the link went away.
   *
   * Once the acknowledgement is in hand this is the board doing as it was told -
   * it restarts about 0.7 s later. Before the acknowledgement it is a failure,
   * and saying so immediately beats sitting out the full timeout first.
   */
  noteDisconnected(): void {
    this.dropped.set();
  }

  private log(msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.events.onLog?.(msg, level);
  }

  /** Read what the board is holding. Never sends anything. */
  async read(): Promise<CfgOutcome> {
    try {
      const stored = decodeConfigTlv(await this.io.readCfg());
      this.log(`board currently has: ${summarizeStored(stored)}`);
      this.events.onStored?.(stored);
      return { ok: true, stored };
    } catch (e) {
      if (e instanceof MissingCharacteristicError) {
        return {
          ok: false,
          unsupported: true,
          error: CFG_UNSUPPORTED,
          hint: CFG_UNSUPPORTED_HINT,
        };
      }
      throw e;
    }
  }

  /**
   * Store settings on the board, optionally asking it to restart.
   *
   * `restart` is the caller's decision, not this one's: on its own a settings
   * change needs a reboot to take effect, but when firmware follows in the same
   * visit the upload's own reboot applies both and a second one is waste.
   */
  async apply(cfg: BoardConfig, restart: boolean): Promise<CfgOutcome> {
    let tlv: Uint8Array;
    try {
      tlv = encodeConfigTlv(cfg, restart);
    } catch (e) {
      if (e instanceof ConfigError) {
        return { ok: false, error: e.message };
      }
      throw e;
    }

    // Read first - see the header comment. A board too old to have the
    // characteristic is caught here, before anything has been written.
    let stored: StoredConfig | undefined;
    try {
      const before = await this.read();
      if (before.unsupported) return before;
      stored = before.stored;
    } catch (e) {
      // Any other read failure is not a reason to refuse the write; it only
      // costs the "it currently reports X" line.
      this.log(
        `could not read the current settings: ${
          e instanceof Error ? e.message : String(e)
        }`,
        'warn'
      );
    }

    // 129 bytes is the longest payload the format can produce, against 20 on a
    // link whose MTU never grew. The stacks split a longer write into a queued
    // prepare/execute and the firmware reassembles it, so this is a note rather
    // than a refusal - but it is the first thing to look at if a write fails.
    if (tlv.length > this.io.chunkSize) {
      this.log(
        `the link carries ${this.io.chunkSize} bytes per write against a ` +
          `${tlv.length}-byte payload; it will be split`,
        'warn'
      );
    }

    this.log(
      `writing settings${restart ? ' (the board will restart)' : ''}`
    );
    try {
      await this.io.writeCfg(tlv);
    } catch (e) {
      if (e instanceof MissingCharacteristicError) {
        return {
          ok: false,
          unsupported: true,
          error: CFG_UNSUPPORTED,
          hint: CFG_UNSUPPORTED_HINT,
          stored,
        };
      }
      throw e;
    }

    const woke = await waitAny(
      [this.acked, this.failed, this.dropped],
      this.ackTimeoutMs
    );
    if (this.acked.isSet) {
      this.log('settings stored on the board');
      return { ok: true, stored };
    }
    if (this.failed.isSet) {
      return {
        ok: false,
        error: this.deviceError ?? 'the board rejected the settings',
        hint: this.deviceHint ?? undefined,
        stored,
      };
    }
    if (woke >= 0) {
      // The link went away before the acknowledgement. The write may well have
      // landed, so the honest answer names both possibilities.
      return {
        ok: false,
        error: 'The link dropped before the board confirmed the settings.',
        hint:
          'The write may still have been stored. Scan again and read the ' +
          'settings back to see whether it took.',
        stored,
      };
    }
    return {
      ok: false,
      error: 'The board never confirmed the settings write.',
      hint:
        'The write reached it but no acknowledgement came back. Read the ' +
        'settings again to see whether they took.',
      stored,
    };
  }
}
