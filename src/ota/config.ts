/**
 * Board settings - Bluetooth name and Wi-Fi credentials - over the CFG
 * characteristic.
 *
 * These three values live in NVS rather than in the firmware image, so they are
 * per-board facts that can be changed without rebuilding and, with this, without
 * a cable. Ported from `build_config_tlv()` / `parse_config_tlv()` in the desktop
 * app's `backend/ota_daemon.py`, with the wire format defined once in the
 * firmware's `main/ota_cfg.h`:
 *
 *   byte 0   flags     bit0 = restart the board once the keys are stored
 *   byte 1   count     number of entries that follow
 *   then `count` entries, back to back:
 *     byte 0 key       1 = dev_name, 2 = wifi_ssid, 3 = wifi_pass
 *     byte 1 length    value length in bytes; 0 erases the key
 *     ...    value     UTF-8, no terminator, no embedded NUL
 *
 * A key that is absent keeps its stored value, which is what makes "change only
 * the Wi-Fi password" possible. The board validates the whole payload before
 * storing any of it: a new SSID next to an old password would leave it unable to
 * associate, and so unreachable over the transport you would use to fix it.
 *
 * No React Native import here - this is the part that can be silently wrong.
 */
import { utf8Decode, utf8Encode, utf8Length } from '../lib/bytes';

export const CFG_FLAG_RESTART = 0x01;

export const CFG_KEY_NAME = 0x01;
export const CFG_KEY_SSID = 0x02;
export const CFG_KEY_PASS = 0x03;

/**
 * Limits in BYTES of UTF-8, not characters, because that is what the board
 * stores: 26 is what a legacy advertising packet has left after its flags and
 * the name's own length+type, 32 is an 802.11 SSID and 63 a WPA2 passphrase.
 */
export const CFG_LIMITS = { name: 26, ssid: 32, pass: 63 } as const;

export const CFG_FIELD_NAMES = {
  name: 'Bluetooth name',
  ssid: 'Wi-Fi network',
  pass: 'Wi-Fi password',
} as const;

/** How long to wait for the board's acknowledgement of a settings write. */
export const CFG_ACK_TIMEOUT_MS = 15_000;

/**
 * Firmware built before the settings characteristic existed simply has no ff05.
 * That is a capability fact rather than a fault, and it has a specific remedy -
 * one this app can carry out itself.
 */
export const CFG_UNSUPPORTED =
  'This board is running firmware without the settings characteristic, so its ' +
  'name and Wi-Fi credentials cannot be changed over the air.';
export const CFG_UNSUPPORTED_HINT =
  'Upload firmware built from the current project first - that upload works ' +
  'over Bluetooth, so no cable is needed. Once it is running, settings can be ' +
  'changed from here. A USB provision with the desktop app also writes them.';

export type CfgField = keyof typeof CFG_LIMITS;
const FIELD_KEYS: Record<CfgField, number> = {
  name: CFG_KEY_NAME,
  ssid: CFG_KEY_SSID,
  pass: CFG_KEY_PASS,
};

/**
 * What to write. A field left `undefined` is not sent at all and the board keeps
 * what it has; a field set to `''` is sent with length 0, which erases the key.
 */
export interface BoardConfig {
  name?: string;
  ssid?: string;
  pass?: string;
}

/** What the board says it is holding. The password is never readable. */
export interface StoredConfig {
  name: string | null;
  ssid: string | null;
  hasPass: boolean | null;
}

/** Raised for a payload the board would reject, so it is never sent. */
export class ConfigError extends Error {}

/**
 * The three form fields, reduced to what should actually go on the wire.
 *
 * Blank means "leave it alone", which is the whole point: to change only the
 * Wi-Fi password you fill in the SSID and the password and leave the name
 * empty. An SSID with an empty password is an open network - the password is
 * only ever sent alongside an SSID, since the pair has to stay consistent.
 */
export function pendingConfig(fields: {
  name?: string;
  ssid?: string;
  pass?: string;
}): BoardConfig | null {
  const name = (fields.name ?? '').trim();
  const ssid = (fields.ssid ?? '').trim();
  const cfg: BoardConfig = {};
  if (name) cfg.name = name;
  if (ssid) {
    cfg.ssid = ssid;
    cfg.pass = fields.pass ?? '';
  }
  return Object.keys(cfg).length ? cfg : null;
}

/** An error string for the first field that would not fit, or null. */
export function configProblem(cfg: BoardConfig): string | null {
  for (const field of ['name', 'ssid', 'pass'] as CfgField[]) {
    const value = cfg[field];
    if (value === undefined) continue;
    const n = utf8Length(value);
    if (n > CFG_LIMITS[field]) {
      return (
        `The ${CFG_FIELD_NAMES[field]} is ${n} bytes; the board accepts ` +
        `${CFG_LIMITS[field]}. Accented and CJK characters count as more than ` +
        'one byte each.'
      );
    }
    if (value.indexOf('\u0000') >= 0) {
      return `The ${CFG_FIELD_NAMES[field]} contains a NUL character.`;
    }
  }
  return null;
}

/** Pack settings for the CFG characteristic. Throws rather than send junk. */
export function encodeConfigTlv(cfg: BoardConfig, restart: boolean): Uint8Array {
  const problem = configProblem(cfg);
  if (problem) throw new ConfigError(problem);

  const entries: Uint8Array[] = [];
  for (const field of ['name', 'ssid', 'pass'] as CfgField[]) {
    const value = cfg[field];
    if (value === undefined) continue;
    const raw = utf8Encode(value);
    const entry = new Uint8Array(2 + raw.length);
    entry[0] = FIELD_KEYS[field];
    entry[1] = raw.length;
    entry.set(raw, 2);
    entries.push(entry);
  }
  if (entries.length === 0) {
    throw new ConfigError('No settings were given.');
  }

  const total = entries.reduce((n, e) => n + e.length, 2);
  const out = new Uint8Array(total);
  out[0] = restart ? CFG_FLAG_RESTART : 0;
  out[1] = entries.length;
  let at = 2;
  for (const e of entries) {
    out.set(e, at);
    at += e.length;
  }
  return out;
}

/**
 * Decode a read-back: same framing, flags 0, all three keys always present with
 * length 0 meaning "not set" - except the password, which is reported as a
 * single byte, 1 or 0, for "a password is stored". A short or truncated payload
 * yields nulls rather than an exception; it is diagnostic data, not a command.
 */
export function decodeConfigTlv(raw: Uint8Array): StoredConfig {
  const out: StoredConfig = { name: null, ssid: null, hasPass: null };
  if (!raw || raw.length < 2) return out;

  let at = 2;
  for (let i = 0; i < raw[1]; i++) {
    if (at + 2 > raw.length) break;
    const key = raw[at];
    const len = raw[at + 1];
    at += 2;
    const value = raw.subarray(at, Math.min(at + len, raw.length));
    at += len;
    if (key === CFG_KEY_NAME) out.name = utf8Decode(value);
    else if (key === CFG_KEY_SSID) out.ssid = utf8Decode(value);
    else if (key === CFG_KEY_PASS) out.hasPass = value.length > 0 && value[0] !== 0;
  }
  return out;
}

/** What this write will change, for the log and the confirmation. No password. */
export function describeConfig(cfg: BoardConfig): string {
  const bits: string[] = [];
  if (cfg.name !== undefined) {
    bits.push(cfg.name ? `Bluetooth name: ${cfg.name}` : 'Bluetooth name: cleared');
  }
  if (cfg.ssid !== undefined) {
    bits.push(
      cfg.ssid
        ? `Wi-Fi network: ${cfg.ssid}` +
            (cfg.pass ? ' (with password)' : ' (open, no password)')
        : 'Wi-Fi: turned off'
    );
  }
  return bits.join('\n');
}

/** What the board reports holding right now, in one line. */
export function summarizeStored(stored: StoredConfig): string {
  const bits: string[] = [];
  if (stored.name !== null) bits.push(`name "${stored.name || '(unset)'}"`);
  if (stored.ssid !== null) bits.push(`Wi-Fi "${stored.ssid || '(none)'}"`);
  if (stored.hasPass !== null) {
    bits.push(stored.hasPass ? 'password stored' : 'no password');
  }
  return bits.join('  -  ') || 'nothing stored';
}
