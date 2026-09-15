/**
 * The BLE OTA transfer, as a state machine over an abstract transport.
 *
 * The transport is an interface rather than a concrete BLE client for one
 * reason: this is the only part of the app that can get the protocol subtly
 * wrong, and against a fake transport it can be tested exhaustively in node.
 * The react-native-ble-plx adapter lives in ../ble/transport.ts.
 *
 * Mirrors `Daemon._one_upload()` in the desktop app's backend, including the
 * decisions that look odd until you know why - see the comments.
 */
import { Gate, waitAny } from '../lib/gate';
import {
  DEFAULT_WINDOW,
  DONE_TIMEOUT_MS,
  READY_TIMEOUT_MS,
  STALL_TIMEOUT_MS,
  StatusEvent,
  decodeStatus,
  encodeAbort,
  encodeEnd,
  encodeStart,
} from './protocol';

export interface OtaIo {
  /** Write to the control characteristic, always with a response. */
  writeCtrl(bytes: Uint8Array): Promise<void>;
  /** Write one firmware chunk to the data characteristic. */
  writeData(bytes: Uint8Array, withResponse: boolean): Promise<void>;
  /** Largest payload a single write may carry, from the negotiated MTU. */
  readonly chunkSize: number;
}

export type Phase =
  | 'idle'
  | 'erasing'
  | 'uploading'
  | 'finalizing'
  | 'done';

export interface Progress {
  sent: number;
  total: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
}

export interface OtaEvents {
  onPhase?: (phase: Phase, text?: string) => void;
  onProgress?: (p: Progress) => void;
  /** Bytes the board says it has committed to flash - not the same as sent. */
  onDeviceProgress?: (committed: number) => void;
  onLog?: (msg: string, level?: 'info' | 'warn' | 'error') => void;
}

export interface OtaOptions {
  /**
   * Write-without-response, metered against the device's committed-bytes
   * notifications. Several packets ride each connection interval instead of one
   * round trip per chunk, which is the single biggest lever on BLE OTA time.
   * Turn it off if a board proves flaky and every packet should be acked.
   */
  fast?: boolean;
  /** In-flight bytes allowed before waiting. Must stay under OTA_STREAM_BYTES. */
  window?: number;
  /** Injectable clock, so tests do not depend on wall time. */
  now?: () => number;
  progressIntervalMs?: number;
}

export interface OtaOutcome {
  ok: boolean;
  error?: string;
  hint?: string;
  cancelled?: boolean;
}

export class OtaSession {
  private readonly ready = new Gate();
  private readonly finished = new Gate();
  private readonly progressed = new Gate();
  private readonly cancelled = new Gate();

  private committed = 0;
  private deviceOk = false;
  private deviceError: string | null = null;
  private deviceHint: string | null = null;

  private readonly fast: boolean;
  private readonly window: number;
  private readonly now: () => number;
  private readonly progressIntervalMs: number;

  constructor(
    private readonly io: OtaIo,
    private readonly firmware: Uint8Array,
    private readonly events: OtaEvents = {},
    options: OtaOptions = {}
  ) {
    this.fast = options.fast ?? true;
    this.window = options.window ?? DEFAULT_WINDOW;
    this.now = options.now ?? (() => Date.now());
    this.progressIntervalMs = options.progressIntervalMs ?? 120;
  }

  /** Feed one STAT notification in. The transport calls this. */
  pushStatus(data: Uint8Array): void {
    const ev = decodeStatus(data);
    if (!ev) return;
    this.handle(ev);
  }

  private handle(ev: StatusEvent): void {
    switch (ev.kind) {
      case 'ready':
        this.ready.set();
        break;
      case 'progress':
        this.committed = ev.committed;
        this.progressed.set();
        this.events.onDeviceProgress?.(ev.committed);
        break;
      case 'done':
        this.deviceOk = true;
        this.finished.set();
        break;
      case 'error':
        this.deviceError = `${ev.title} (device code 0x${ev.code
          .toString(16)
          .padStart(2, '0')
          .toUpperCase()})`;
        this.deviceHint = ev.hint;
        this.finished.set();
        break;
      default:
        break;
    }
  }

  cancel(): void {
    this.cancelled.set();
  }

  /** True once the device has reported a failure we should stop for. */
  private get failed(): boolean {
    return this.finished.isSet && !this.deviceOk;
  }

  private log(msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.events.onLog?.(msg, level);
  }

  private phase(p: Phase, text?: string): void {
    this.events.onPhase?.(p, text);
  }

  async run(): Promise<OtaOutcome> {
    const total = this.firmware.length;
    const chunk = this.io.chunkSize;

    this.phase('erasing', 'the board is erasing the target slot');
    this.log(
      `starting: ${total} bytes, ${chunk} per write` +
        (this.fast ? ' (write-without-response)' : '')
    );

    await this.io.writeCtrl(encodeStart(total));

    const startResult = await waitAny(
      [this.ready, this.finished],
      READY_TIMEOUT_MS
    );
    if (this.failed) {
      // A rejected START is reported the instant it arrives - waiting out the
      // full READY timeout first would show the wrong phase for half a minute.
      return this.abortOutcome(this.deviceError ?? 'the board rejected START');
    }
    if (startResult === 0) {
      this.log('board reported READY');
    } else {
      // Not fatal on its own: some builds start accepting data without ever
      // sending READY, so streaming and letting END adjudicate is better than
      // failing a transfer that would have worked.
      this.log('no READY within 30 s; streaming anyway', 'warn');
    }

    this.phase('uploading');
    const t0 = this.now();
    let lastEmit = 0;

    for (let off = 0; off < total; off += chunk) {
      if (this.cancelled.isSet) return this.userCancelled();
      if (this.failed) {
        return this.abortOutcome(this.deviceError ?? 'the board aborted');
      }

      // Flow control. Nothing acknowledges individual packets in fast mode, so
      // never let more than `window` bytes be outstanding against what the
      // board has confirmed committing.
      while (this.fast && off - this.committed >= this.window) {
        this.progressed.clear();
        if (off - this.committed < this.window) break; // notify landed in the gap
        if (this.cancelled.isSet) return this.userCancelled();
        if (this.failed) {
          return this.abortOutcome(this.deviceError ?? 'the board aborted');
        }
        const woke = await waitAny(
          [this.progressed, this.finished, this.cancelled],
          STALL_TIMEOUT_MS
        );
        if (this.failed) {
          return this.abortOutcome(this.deviceError ?? 'the board aborted');
        }
        if (this.cancelled.isSet) return this.userCancelled();
        if (woke < 0) {
          return {
            ok: false,
            error:
              `The board stopped acknowledging after ` +
              `${this.committed.toLocaleString()} of ${total.toLocaleString()} bytes.`,
            hint:
              'Move the phone closer, or retry with reliable mode if this ' +
              'keeps happening.',
          };
        }
      }

      await this.io.writeData(
        this.firmware.subarray(off, Math.min(off + chunk, total)),
        !this.fast
      );

      const sent = Math.min(off + chunk, total);
      const now = this.now();
      if (now - lastEmit >= this.progressIntervalMs || sent === total) {
        lastEmit = now;
        const dt = Math.max((now - t0) / 1000, 1e-6);
        const bps = sent / dt;
        this.events.onProgress?.({
          sent,
          total,
          bytesPerSecond: bps,
          etaSeconds: bps > 0 ? (total - sent) / bps : null,
        });
      }
    }

    this.phase('finalizing', 'the board is verifying the signature');
    const elapsed = Math.max((this.now() - t0) / 1000, 1e-6);
    this.log(
      `streamed ${total.toLocaleString()} bytes in ${elapsed.toFixed(1)}s ` +
        `(${(total / elapsed / 1024).toFixed(1)} KB/s)`
    );

    await this.io.writeCtrl(encodeEnd());

    if (!(await this.finished.wait(DONE_TIMEOUT_MS))) {
      // The board reboots the moment it accepts the image, so a missing DONE is
      // ambiguous rather than fatal - reporting failure here would be a lie.
      this.log('no DONE notification - the board may have rebooted first', 'warn');
      this.phase('done');
      return {
        ok: true,
        hint:
          'No explicit DONE arrived. The board most likely rebooted into the ' +
          'new image already; check that it comes back advertising.',
      };
    }

    if (!this.deviceOk) {
      return {
        ok: false,
        error: this.deviceError ?? 'the board reported an error',
        hint: this.deviceHint ?? undefined,
      };
    }

    this.phase('done');
    return { ok: true };
  }

  private async userCancelled(): Promise<OtaOutcome> {
    this.log('cancelled - telling the board to abort', 'warn');
    try {
      await this.io.writeCtrl(encodeAbort());
    } catch {
      // The link may already be gone; the board times the session out anyway.
    }
    this.phase('idle');
    return { ok: false, cancelled: true, error: 'Cancelled.' };
  }

  private abortOutcome(error: string): OtaOutcome {
    this.phase('idle');
    return { ok: false, error, hint: this.deviceHint ?? undefined };
  }
}
