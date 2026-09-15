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

/**
 * UTF-8, hand-rolled for the same reason base64 is: the board stores and
 * counts *bytes*, so a Bluetooth name has to be measured in the encoding it
 * will be stored in - a 26-character CJK name is 78 bytes and does not fit.
 * TextEncoder is not guaranteed to exist on every engine this app runs on.
 */
export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let cp = s.codePointAt(i) as number;
    if (cp > 0xffff) i++; // a surrogate pair is one code point, two JS units
    // A lone surrogate is not encodable; WHATWG says substitute U+FFFD.
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      );
    }
  }
  return new Uint8Array(out);
}

/** Decodes what the board sends back. Malformed bytes become U+FFFD, never an
 * exception: a settings read-back is diagnostic, and throwing on one bad byte
 * would hide the other two fields. */
export function utf8Decode(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; ) {
    const c = b[i++];
    let cp: number;
    let need: number;
    if (c < 0x80) {
      cp = c;
      need = 0;
    } else if (c >= 0xc2 && c < 0xe0) {
      cp = c & 0x1f;
      need = 1;
    } else if (c >= 0xe0 && c < 0xf0) {
      cp = c & 0x0f;
      need = 2;
    } else if (c >= 0xf0 && c < 0xf5) {
      cp = c & 0x07;
      need = 3;
    } else {
      s += '\ufffd'; // a continuation byte where a leading one belongs
      continue;
    }
    let ok = true;
    for (let k = 0; k < need; k++) {
      const cont = b[i];
      if (cont === undefined || (cont & 0xc0) !== 0x80) {
        ok = false;
        break;
      }
      cp = (cp << 6) | (cont & 0x3f);
      i++;
    }
    s += ok && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
      ? String.fromCodePoint(cp)
      : '\ufffd';
  }
  return s;
}

/** Bytes this string costs on the board - what every settings limit counts. */
export const utf8Length = (s: string): number => utf8Encode(s).length;

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
