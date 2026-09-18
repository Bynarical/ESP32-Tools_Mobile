/**
 * The ESP32-C3 BLE OTA wire protocol.
 *
 * Ported from the desktop app's backend (`backend/otad/protocol.py` and
 * `bleota.py` in ESP32-Tools), which is the reference implementation, and from
 * the `notify_error()` call sites in the firmware's `main/ble_ota_main.c`. Both
 * sides must agree byte for byte, so the opcodes and the error table are
 * transcribed rather than reinvented. Kept in step with ESP32-Tools 1.4.5.
 *
 * Deliberately free of React Native imports: everything here is testable in
 * plain node, which is the only way to check a protocol without a board.
 */
import { readU32LE, writeU32LE } from '../lib/bytes';

// The service the firmware advertises, and the five characteristics on it.
export const SVC_UUID = '0000ff00-8a3e-4b2c-9d1f-6e5a4c3b2a10';
export const CTRL_UUID = '0000ff01-8a3e-4b2c-9d1f-6e5a4c3b2a10';
export const DATA_UUID = '0000ff02-8a3e-4b2c-9d1f-6e5a4c3b2a10';
export const STAT_UUID = '0000ff03-8a3e-4b2c-9d1f-6e5a4c3b2a10';
export const WIFI_UUID = '0000ff04-8a3e-4b2c-9d1f-6e5a4c3b2a10';
export const CFG_UUID = '0000ff05-8a3e-4b2c-9d1f-6e5a4c3b2a10';

/** Default advertised name, overridable per board via the settings char. */
export const DEFAULT_DEVICE_NAME = 'ESP32C3-OTA';

// Control opcodes, written to CTRL with a response.
export const CMD_START = 0x01;
export const CMD_END = 0x03;
export const CMD_ABORT = 0x04;

// Status events, notified on STAT.
export const EV_READY = 0x01;
export const EV_PROGRESS = 0x02;
export const EV_DONE = 0x03;
export const EV_CFG = 0x04;
export const EV_ERROR = 0xe0;

/**
 * Bytes allowed in flight before we wait for the device to confirm.
 *
 * Write-without-response means nothing acknowledges an individual packet, so
 * the sender meters itself against the committed-bytes notifications instead.
 * This must stay below the firmware's receive buffer (OTA_STREAM_BYTES) or the
 * device overruns and answers 0x21.
 */
export const DEFAULT_WINDOW = 16384;

export const READY_TIMEOUT_MS = 30_000;
export const DONE_TIMEOUT_MS = 25_000;
/** How long the device may go without confirming progress before we give up. */
export const STALL_TIMEOUT_MS = 15_000;

/**
 * How long a connection may take to come up. The desktop backend measured a
 * link that stalls once at about 26 s before its stack retries, so 20 s made a
 * recoverable stall a hard failure; 45 s survives one.
 */
export const CONNECT_TIMEOUT_MS = 45_000;

/**
 * How the desktop backend treats a failed attempt, mirrored here.
 *
 * An upload that fails on the link - a drop, a stall, a connect that never
 * came up - is tried again, twice, two seconds apart; the board keeps its
 * current firmware until END is accepted, so starting over is safe. A verdict
 * from the board about the *image* is final: retrying reproduces it exactly.
 * A settings write gets three attempts for the same reasons.
 */
export const UPLOAD_RETRIES = 2;
export const RETRY_DELAY_MS = 2_000;
export const SETTINGS_ATTEMPTS = 3;

/**
 * Device errors that are a property of the image, not of the link.
 * No spare partition, a slot the image does not fit, a rejected image.
 */
export const FATAL_DEVICE_CODES: readonly number[] = [0x02, 0x03, 0x11];

export const isFatalDeviceCode = (code: number | undefined | null): boolean =>
  code != null && FATAL_DEVICE_CODES.includes(code);

/**
 * Settings that could not be stored before an upload because the board's
 * firmware predates the characteristic are stored after it, once the board
 * has rebooted into the image that adds it. Long enough for a reboot and a
 * fresh round of advertising; polled every few seconds.
 */
export const DEFERRED_CONFIG_TIMEOUT_MS = 120_000;
export const DEFERRED_CONFIG_POLL_MS = 5_000;

export function encodeStart(totalBytes: number): Uint8Array {
  const out = new Uint8Array(5);
  out[0] = CMD_START;
  out.set(writeU32LE(totalBytes), 1);
  return out;
}

export const encodeEnd = (): Uint8Array => new Uint8Array([CMD_END]);
export const encodeAbort = (): Uint8Array => new Uint8Array([CMD_ABORT]);

export type StatusEvent =
  | { kind: 'ready' }
  | { kind: 'progress'; committed: number }
  | { kind: 'done' }
  | { kind: 'cfg' }
  | { kind: 'error'; code: number; title: string; hint: string }
  | { kind: 'unknown'; opcode: number };

/** Decode one STAT notification. Returns null for an empty payload. */
export function decodeStatus(data: Uint8Array): StatusEvent | null {
  if (!data || data.length === 0) return null;
  const op = data[0];
  switch (op) {
    case EV_READY:
      return { kind: 'ready' };
    case EV_PROGRESS:
      // A short progress packet is not usable; treat it as noise rather than
      // reading past the end and inventing a committed count.
      if (data.length < 5) return { kind: 'unknown', opcode: op };
      return { kind: 'progress', committed: readU32LE(data, 1) };
    case EV_DONE:
      return { kind: 'done' };
    case EV_CFG:
      return { kind: 'cfg' };
    case EV_ERROR: {
      const code = data.length > 1 ? data[1] : 0;
      const { title, hint } = describeDeviceError(code);
      return { kind: 'error', code, title, hint };
    }
    default:
      return { kind: 'unknown', opcode: op };
  }
}

/**
 * What the board means by each error code, and what to do about it. Mirrors the
 * desktop app's table so the two front ends give the same advice - these codes
 * are the difference between "it failed" and "the board still verifies
 * signatures". Ported from `DEVICE_ERRORS` in ESP32-Tools' `protocol.py`.
 */
export const DEVICE_ERRORS: Record<number, { title: string; hint: string }> = {
  0x01: {
    title: 'Malformed START command',
    hint: 'The device got a START shorter than 5 bytes - protocol mismatch.',
  },
  0x02: {
    title: 'No spare OTA partition',
    hint:
      'The running firmware was flashed onto a non-OTA layout. Provision the ' +
      'board over USB with the desktop app first.',
  },
  0x03: {
    title: 'Could not erase the target slot',
    hint:
      'Usually the image is larger than the ota_0/ota_1 partition. Two slots ' +
      'are the mechanism - the image has to fit in one.',
  },
  0x04: {
    title: 'Device is out of memory',
    hint: 'The board could not allocate its OTA buffer. Reset it and retry.',
  },
  0x10: {
    title: 'END without START',
    hint: 'The device was not in an OTA session. Retry the upload.',
  },
  0x11: {
    title: 'Image rejected at finalize',
    hint:
      'The current toolchain builds with signature verification off, so the ' +
      'usual cause is a board still running firmware from before that change: ' +
      'it verifies the next update and rejects an unsigned one. Flash that ' +
      'board over USB once with the desktop app and it takes unsigned updates ' +
      'from then on. Otherwise the image is truncated or corrupt - check its ' +
      'size against the file.',
  },
  0x12: {
    title: 'Could not set the boot partition',
    hint: 'otadata may be corrupt; re-provision over USB.',
  },
  0x13: {
    title: 'Incomplete image',
    hint:
      'The device committed fewer bytes than announced, so packets were lost ' +
      'in flight. Lower the flow-control window, or switch to reliable mode.',
  },
  0x20: {
    title: 'Flash write failed',
    hint:
      'Try again; if it repeats, the flash may be worn or the image oversized.',
  },
  0x21: {
    title: 'Device receive buffer overrun',
    hint:
      'Firmware was pushed faster than it could be written to flash. Lower the ' +
      'flow-control window, or switch to reliable mode.',
  },
  0x30: {
    title: 'Malformed settings payload',
    hint: 'A protocol mismatch between this app and the board firmware.',
  },
  0x31: {
    title: 'A setting is too long',
    hint:
      'Limits are 26 bytes for the name, 32 for the SSID, 63 for the password ' +
      '- UTF-8 bytes, so CJK characters count as three each.',
  },
  0x32: {
    title: 'Unknown setting',
    hint: 'The board firmware is older than this app. Upload a current image.',
  },
  0x33: {
    title: 'Could not store the settings',
    hint: 'The NVS write failed. Re-provisioning over USB rewrites NVS.',
  },
  0x34: {
    title: 'Busy with a firmware transfer',
    hint: 'Let the running upload finish, or cancel it, then try again.',
  },
  0xff: {
    title: 'Unknown control opcode',
    hint: 'The device did not recognise the command byte.',
  },
};

export function describeDeviceError(code: number): {
  title: string;
  hint: string;
} {
  return (
    DEVICE_ERRORS[code] ?? {
      title: `Device error 0x${code.toString(16).padStart(2, '0').toUpperCase()}`,
      hint: 'Unrecognised error code.',
    }
  );
}

/**
 * Bytes per write, derived from the negotiated MTU.
 *
 * Three bytes of every ATT packet are header. Android commonly grants 517,
 * iOS around 185; both are fine, the larger one is simply faster.
 */
export function chunkForMtu(mtu: number): number {
  return Math.max(20, Math.min(mtu, 517) - 3);
}
