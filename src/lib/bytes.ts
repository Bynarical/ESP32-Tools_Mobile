/**
 * Byte helpers.
 *
 * react-native-ble-plx moves characteristic values as base64 strings, and React
 * Native has no Buffer, so the conversions live here. Kept free of any React
 * Native import so the protocol above them can be tested in plain node.
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64[b0 >> 2];
    out += B64[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    // A short final group is padded rather than truncated: the peer decodes by
    // length, so dropping the '=' would corrupt the last byte of a firmware
    // chunk whose size is not a multiple of three.
    out += b1 === undefined ? '=' : B64[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : B64[b2 & 0x3f];
  }
  return out;
}

const B64_INDEX: Record<string, number> = {};
for (let i = 0; i < B64.length; i++) B64_INDEX[B64[i]] = i;

export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_INDEX[clean[i]] ?? 0;
    const c1 = B64_INDEX[clean[i + 1]] ?? 0;
    const c2 = B64_INDEX[clean[i + 2]];
    const c3 = B64_INDEX[clean[i + 3]];
    out[o++] = (c0 << 2) | (c1 >> 4);
    if (c2 !== undefined) out[o++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    if (c3 !== undefined) out[o++] = ((c2 & 0x03) << 6) | c3;
  }
  return out.subarray(0, o);
}

/** Little-endian uint32, which is how the firmware sends every length. */
export function readU32LE(b: Uint8Array, offset: number): number {
  return (
    (b[offset] |
      (b[offset + 1] << 8) |
      (b[offset + 2] << 16) |
      (b[offset + 3] << 24)) >>>
    0
  );
}

export function readU16LE(b: Uint8Array, offset: number): number {
  return (b[offset] | (b[offset + 1] << 8)) >>> 0;
}

export function writeU32LE(value: number): Uint8Array {
  const b = new Uint8Array(4);
  b[0] = value & 0xff;
  b[1] = (value >>> 8) & 0xff;
  b[2] = (value >>> 16) & 0xff;
  b[3] = (value >>> 24) & 0xff;
  return b;
}

/** A NUL-terminated fixed-width string, as esp_app_desc_t stores them. */
export function readCString(b: Uint8Array, offset: number, max: number): string {
  let end = offset;
  const limit = Math.min(offset + max, b.length);
  while (end < limit && b[end] !== 0) end++;
  let s = '';
  for (let i = offset; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}
