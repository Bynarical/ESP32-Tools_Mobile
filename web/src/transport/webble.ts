/**
 * Web Bluetooth bound to the OTA protocol - the browser's answer to
 * `src/ble/transport.ts`, implementing the same `OtaIo` and `CfgIo` so the
 * shared state machines run here unchanged.
 *
 * Three things differ from react-native-ble-plx, and all three are the API's
 * doing rather than ours:
 *
 *   - **There is no scan.** `requestDevice()` opens the browser's own chooser
 *     and returns the one device the user picked. A page cannot enumerate
 *     what is nearby, by design, so the board list in the mobile app has no
 *     equivalent here.
 *   - **There is no MTU.** Nothing exposes the negotiated value, so the write
 *     size cannot be derived the way `chunkForMtu()` derives it. This starts
 *     optimistic and backs off on the first over-long write - see `writeData`.
 *   - **There is no pairing API.** The firmware marks CTRL and DATA
 *     `BLE_GATT_CHR_F_WRITE_ENC`, so the link has to be bonded before it takes
 *     a byte. Android's stack bonds on its own when an encrypted
 *     characteristic is touched; desktop Chrome generally does not, and the
 *     board has to be paired in the operating system first. `describeWebBleError`
 *     says so when the board refuses.
 */
import {
  CFG_UUID,
  CTRL_UUID,
  DATA_UUID,
  DEFAULT_DEVICE_NAME,
  STAT_UUID,
  SVC_UUID,
} from '../../../src/ota/protocol';
import { type CfgIo, MissingCharacteristicError } from '../../../src/ota/configSession';
import type { OtaIo } from '../../../src/ota/session';

// ------------------------------------------------------------------ typings
// Declared here rather than pulled from @types/web-bluetooth: this is the
// whole surface the app uses, and it keeps the dependency list at one package.

interface BluetoothCharacteristic extends EventTarget {
  readonly uuid: string;
  value?: DataView;
  writeValueWithResponse(v: ArrayBufferView): Promise<void>;
  writeValueWithoutResponse(v: ArrayBufferView): Promise<void>;
  readValue(): Promise<DataView>;
  startNotifications(): Promise<BluetoothCharacteristic>;
  stopNotifications(): Promise<BluetoothCharacteristic>;
}

interface BluetoothService {
  getCharacteristic(uuid: string): Promise<BluetoothCharacteristic>;
}

interface BluetoothServer {
  readonly connected: boolean;
  connect(): Promise<BluetoothServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<BluetoothService>;
}

export interface BluetoothDeviceLike extends EventTarget {
  readonly id: string;
  readonly name?: string;
  readonly gatt?: BluetoothServer;
}

interface RequestDeviceOptions {
  filters?: Array<{ services?: string[]; name?: string; namePrefix?: string }>;
  optionalServices?: string[];
  acceptAllDevices?: boolean;
}

interface BluetoothApi {
  requestDevice(options: RequestDeviceOptions): Promise<BluetoothDeviceLike>;
  getAvailability?(): Promise<boolean>;
}

const bluetooth = (): BluetoothApi => {
  const api = (navigator as Navigator & { bluetooth?: BluetoothApi }).bluetooth;
  if (!api) throw new Error('This browser has no Web Bluetooth.');
  return api;
};

export const hasWebBluetooth = (): boolean =>
  typeof (navigator as Navigator & { bluetooth?: unknown }).bluetooth === 'object';

/** Whether a radio is actually present, when the browser will say. */
export async function radioAvailable(): Promise<boolean | null> {
  try {
    const api = bluetooth();
    return api.getAvailability ? await api.getAvailability() : null;
  } catch {
    return null;
  }
}

/**
 * Open the browser's device chooser.
 *
 * Two shapes, for the same reason the mobile app scans unfiltered: matching on
 * the service UUID alone misses a board whose advertising packet truncated it,
 * and matching on the name alone misses a renamed board. `anyDevice` is the
 * escape hatch for a board that shows up as neither.
 */
export function pickBoard(anyDevice = false): Promise<BluetoothDeviceLike> {
  const options: RequestDeviceOptions = anyDevice
    ? { acceptAllDevices: true, optionalServices: [SVC_UUID] }
    : {
        filters: [{ services: [SVC_UUID] }, { name: DEFAULT_DEVICE_NAME }],
        optionalServices: [SVC_UUID],
      };
  return bluetooth().requestDevice(options);
}

/**
 * The largest write to try first.
 *
 * 512 is the ceiling on a GATT attribute value, and Chrome on Android
 * negotiates an MTU that carries it. Anything smaller is discovered the hard
 * way, once, by `writeData`.
 */
const OPTIMISTIC_CHUNK = 512;
const MIN_CHUNK = 20;

/** Does this error mean "that write was longer than the link allows"? */
function isTooLong(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name ?? '';
  const text = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    name === 'NotSupportedError' ||
    text.includes('longer than') ||
    text.includes('value length') ||
    text.includes('exceeds') ||
    text.includes('too long') ||
    text.includes('invalid attribute length')
  );
}

function asCfgError(e: unknown): unknown {
  const name = (e as { name?: string } | null)?.name ?? '';
  const text = (e instanceof Error ? e.message : String(e)).toLowerCase();
  if (name === 'NotFoundError' || text.includes('no valid characteristic') ||
      text.includes('not found')) {
    return new MissingCharacteristicError(
      'the board has no settings characteristic'
    );
  }
  return e;
}

const bytesOf = (v: DataView): Uint8Array =>
  new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();

/** A connected board over Web Bluetooth. */
export class WebBoardLink implements OtaIo, CfgIo {
  private chunk = OPTIMISTIC_CHUNK;

  private constructor(
    private readonly device: BluetoothDeviceLike,
    private readonly service: BluetoothService,
    private readonly ctrl: BluetoothCharacteristic,
    private readonly data: BluetoothCharacteristic,
    private readonly stat: BluetoothCharacteristic,
    private readonly onStatusBound: (e: Event) => void
  ) {}

  /**
   * The current write size.
   *
   * A getter, not a fixed field: the session reads it each time round the
   * loop, so a backed-off value takes effect for the rest of the transfer
   * rather than only for the packet that discovered the limit.
   */
  get chunkSize(): number {
    return this.chunk;
  }

  get deviceName(): string {
    return this.device.name ?? 'the board';
  }

  static async connect(
    device: BluetoothDeviceLike,
    onStatus: (bytes: Uint8Array) => void,
    onDisconnect?: () => void
  ): Promise<WebBoardLink> {
    if (!device.gatt) throw new Error('That device exposes no GATT server.');

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SVC_UUID);
    const [ctrl, data, stat] = await Promise.all([
      service.getCharacteristic(CTRL_UUID),
      service.getCharacteristic(DATA_UUID),
      service.getCharacteristic(STAT_UUID),
    ]);

    const handler = (e: Event) => {
      const c = e.target as BluetoothCharacteristic;
      if (c.value) onStatus(bytesOf(c.value));
    };
    stat.addEventListener('characteristicvaluechanged', handler);
    await stat.startNotifications();

    if (onDisconnect) {
      device.addEventListener('gattserverdisconnected', () => onDisconnect(), {
        once: true,
      });
    }

    return new WebBoardLink(device, service, ctrl, data, stat, handler);
  }

  async writeCtrl(bytes: Uint8Array): Promise<void> {
    await this.ctrl.writeValueWithResponse(bytes);
  }

  /**
   * Write one firmware chunk, discovering the link's real limit if we guessed
   * high.
   *
   * Nothing in Web Bluetooth reports the MTU, so the first over-long write is
   * the only way to learn it. Rather than fail the transfer, halve the size,
   * resend the same payload in pieces, and keep the smaller size from then on.
   * Worst case this costs a handful of extra round trips once.
   */
  async writeData(bytes: Uint8Array, withResponse: boolean): Promise<void> {
    try {
      await this.raw(bytes, withResponse);
      return;
    } catch (e) {
      if (!isTooLong(e) || this.chunk <= MIN_CHUNK) throw e;
      this.chunk = Math.max(MIN_CHUNK, this.chunk >> 1);
    }
    for (let off = 0; off < bytes.length; off += this.chunk) {
      await this.raw(bytes.subarray(off, off + this.chunk), withResponse);
    }
  }

  private raw(bytes: Uint8Array, withResponse: boolean): Promise<void> {
    return withResponse
      ? this.data.writeValueWithResponse(bytes)
      : this.data.writeValueWithoutResponse(bytes);
  }

  async readCfg(): Promise<Uint8Array> {
    try {
      const cfg = await this.service.getCharacteristic(CFG_UUID);
      return bytesOf(await cfg.readValue());
    } catch (e) {
      throw asCfgError(e);
    }
  }

  async writeCfg(bytes: Uint8Array): Promise<void> {
    try {
      const cfg = await this.service.getCharacteristic(CFG_UUID);
      await cfg.writeValueWithResponse(bytes);
    } catch (e) {
      throw asCfgError(e);
    }
  }

  async close(): Promise<void> {
    try {
      this.stat.removeEventListener('characteristicvaluechanged', this.onStatusBound);
      await this.stat.stopNotifications();
    } catch {
      // The link is already gone; there is nothing to unsubscribe from.
    }
    try {
      this.device.gatt?.disconnect();
    } catch {
      // Already disconnected.
    }
  }
}

/**
 * Turn a Web Bluetooth error into something worth showing a user.
 *
 * Mirrors `describeBleError` in the mobile adapter, with the one failure that
 * is unique to the browser: an encrypted characteristic refused because the
 * page has no way to ask for a bond.
 */
export function describeWebBleError(e: unknown): {
  message: string;
  hint?: string;
} {
  const name = (e as { name?: string } | null)?.name ?? '';
  const raw = e instanceof Error ? e.message : String(e);
  const low = raw.toLowerCase();

  if (name === 'NotFoundError' && low.includes('user')) {
    return { message: 'No board was chosen.' };
  }
  if (name === 'SecurityError' || low.includes('not authorized') ||
      low.includes('insufficient authentication') ||
      low.includes('not permitted')) {
    return {
      message: 'The board refused the write because the link is not bonded.',
      hint:
        'The firmware encrypts its control and data characteristics, and Web ' +
        'Bluetooth has no pairing API, so the browser cannot bond on its own. ' +
        'Pair the board in your system Bluetooth settings first, then choose ' +
        'it again here. On Android the system usually prompts by itself - ' +
        'accept it.',
    };
  }
  if (low.includes('disconnected') || low.includes('gatt server is disconnected')) {
    return {
      message: 'The Bluetooth link dropped.',
      hint:
        'Stay close to the board during an upload. It keeps its current ' +
        'firmware until the transfer is accepted, so retrying is safe.',
    };
  }
  if (name === 'NetworkError') {
    return {
      message: 'The browser could not connect to the board.',
      hint: 'Confirm it is powered and advertising, then choose it again.',
    };
  }
  if (low.includes('globally disabled') || low.includes('bluetooth adapter')) {
    return { message: 'Bluetooth is turned off.', hint: 'Turn Bluetooth on.' };
  }
  return { message: raw };
}
