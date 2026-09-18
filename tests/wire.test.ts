/**
 * Byte-level tests: base64, the little-endian readers, the status decoder and
 * the image inspector. No device and no React Native involved.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  formatBytes,
  fromBase64,
  readCString,
  readU16LE,
  readU32LE,
  toBase64,
  writeU32LE,
} from '../src/lib/bytes';
import {
  CMD_ABORT,
  CMD_END,
  CMD_START,
  EV_DONE,
  EV_ERROR,
  EV_PROGRESS,
  EV_READY,
  chunkForMtu,
  decodeStatus,
  describeDeviceError,
  encodeAbort,
  encodeEnd,
  encodeStart,
} from '../src/ota/protocol';
import { EXPECTED_CHIP_ID, inspectImage, summarize } from '../src/ota/image';

test('base64 round-trips every length, including short final groups', () => {
  // Firmware chunks are rarely a multiple of three; getting the padding wrong
  // corrupts the last byte or two of every write.
  for (let n = 0; n <= 64; n++) {
    const src = new Uint8Array(n);
    for (let i = 0; i < n; i++) src[i] = (i * 37 + 11) & 0xff;
    const back = fromBase64(toBase64(src));
    assert.deepEqual([...back], [...src], `length ${n} did not survive`);
  }
});

test('base64 matches Node for byte values that expose sign errors', () => {
  const src = new Uint8Array([0x00, 0xff, 0x80, 0x7f, 0xfe, 0x01]);
  assert.equal(toBase64(src), Buffer.from(src).toString('base64'));
  assert.deepEqual(
    [...fromBase64(Buffer.from(src).toString('base64'))],
    [...src]
  );
});

test('little-endian helpers agree with DataView', () => {
  const b = new Uint8Array([0x78, 0x56, 0x34, 0x12, 0xff, 0xff]);
  assert.equal(readU32LE(b, 0), 0x12345678);
  assert.equal(readU16LE(b, 0), 0x5678);
  // A length near 2^32 must stay unsigned, not go negative.
  assert.equal(readU32LE(new Uint8Array([0xff, 0xff, 0xff, 0xff]), 0), 4294967295);
  assert.deepEqual([...writeU32LE(0x12345678)], [0x78, 0x56, 0x34, 0x12]);
  assert.deepEqual([...writeU32LE(593920)], [0x00, 0x10, 0x09, 0x00]);
});

test('readCString stops at NUL and respects the field width', () => {
  const b = new Uint8Array(16);
  b.set([0x76, 0x31, 0x2e, 0x30, 0x00, 0x41, 0x41], 0); // "v1.0\0AA"
  assert.equal(readCString(b, 0, 16), 'v1.0');
  // No NUL inside the window: stop at the width, do not run on.
  const full = new Uint8Array([0x41, 0x42, 0x43, 0x44]);
  assert.equal(readCString(full, 0, 2), 'AB');
});

test('encodeStart carries the length as little-endian uint32', () => {
  const out = encodeStart(593920);
  assert.equal(out.length, 5, 'START must be exactly 5 bytes');
  assert.equal(out[0], CMD_START);
  assert.equal(readU32LE(out, 1), 593920);
  assert.equal(encodeEnd()[0], CMD_END);
  assert.equal(encodeAbort()[0], CMD_ABORT);
});

test('decodeStatus understands every event the firmware sends', () => {
  assert.deepEqual(decodeStatus(new Uint8Array([EV_READY])), { kind: 'ready' });
  assert.deepEqual(decodeStatus(new Uint8Array([EV_DONE])), { kind: 'done' });

  const prog = new Uint8Array(5);
  prog[0] = EV_PROGRESS;
  prog.set(writeU32LE(16384), 1);
  assert.deepEqual(decodeStatus(prog), { kind: 'progress', committed: 16384 });

  const err = decodeStatus(new Uint8Array([EV_ERROR, 0x11]));
  assert.equal(err?.kind, 'error');
  if (err?.kind === 'error') {
    assert.equal(err.code, 0x11);
    // 0x11 is the one users hit. Since the toolchain stopped signing, its
    // usual cause is a board that still verifies - so the hint has to name
    // that, and the one-time USB flash that fixes it, not a key file.
    assert.match(err.title, /rejected at finalize/i);
    assert.match(err.hint, /signature verification off/i);
    assert.match(err.hint, /USB/);
    assert.match(err.hint, /truncated or corrupt/i);
  }
});

test('decodeStatus refuses to invent a committed count', () => {
  // A truncated progress packet must not be read past its end.
  assert.deepEqual(decodeStatus(new Uint8Array([EV_PROGRESS, 0x01])), {
    kind: 'unknown',
    opcode: EV_PROGRESS,
  });
  assert.equal(decodeStatus(new Uint8Array([])), null);
  assert.deepEqual(decodeStatus(new Uint8Array([0x7a])), {
    kind: 'unknown',
    opcode: 0x7a,
  });
});

test('unknown device errors still produce usable text', () => {
  const d = describeDeviceError(0x99);
  assert.match(d.title, /0x99/);
  assert.ok(d.hint.length > 0);
});

test('chunkForMtu leaves room for the ATT header and clamps sanely', () => {
  assert.equal(chunkForMtu(517), 514);
  assert.equal(chunkForMtu(185), 182);
  assert.equal(chunkForMtu(23), 20);
  // A nonsense MTU must not produce a zero or negative write size.
  assert.equal(chunkForMtu(0), 20);
  assert.equal(chunkForMtu(4096), 514);
});

/** Build an image that looks like what ESP-IDF produces. */
function fakeImage(
  opts: {
    chipId?: number;
    signed?: boolean;
    withDesc?: boolean;
    withOtaSvc?: boolean;
    size?: number;
  } = {}
): Uint8Array {
  const size = opts.size ?? 8192;
  const b = new Uint8Array(size);
  b[0] = 0xe9;
  const chipId = opts.chipId ?? EXPECTED_CHIP_ID;
  b[12] = chipId & 0xff;
  b[13] = (chipId >> 8) & 0xff;

  if (opts.withDesc !== false) {
    b.set(writeU32LE(0xabcd5432), 0x20);
    const put = (s: string, at: number) => {
      for (let i = 0; i < s.length; i++) b[at + i] = s.charCodeAt(i);
    };
    put('1.2.3', 0x30);
    put('ble_ota_c3', 0x50);
    put('09:46:16', 0x70);
    put('Aug 21 2026', 0x80);
    put('v6.0', 0x90);
  }
  if (opts.withOtaSvc !== false) {
    b.set(
      [0x10, 0x2a, 0x3b, 0x4c, 0x5a, 0x6e, 0x1f, 0x9d, 0x2c, 0x4b, 0x3e, 0x8a,
        0x00, 0xff, 0x00, 0x00],
      0x400
    );
  }
  if (opts.signed !== false) b[size - 4096] = 0xe7;
  return b;
}

test('a good image is read correctly and raises nothing', () => {
  const info = inspectImage(fakeImage());
  assert.equal(info.valid, true);
  assert.equal(info.chip, 'ESP32-C3');
  assert.equal(info.project, 'ble_ota_c3');
  assert.equal(info.version, '1.2.3');
  assert.equal(info.idfVersion, 'v6.0');
  assert.equal(info.buildDate, 'Aug 21 2026');
  assert.equal(info.signed, true);
  assert.equal(info.keepsOta, true);
  assert.deepEqual(info.problems, []);
  assert.deepEqual(info.warnings, []);
  assert.match(summarize(info), /ble_ota_c3.*v1\.2\.3.*signed/);
});

test('an unsigned image is the expected shape now - a warning, not a problem', () => {
  // The desktop toolchain leaves signature verification off, so every image it
  // produces is unsigned and a board flashed from it takes them. The one board
  // that would refuse is worth a word, which is what the warning is.
  const info = inspectImage(fakeImage({ signed: false }));
  assert.equal(info.signed, false);
  assert.deepEqual(info.problems, []);
  assert.equal(info.warnings.length, 1);
  assert.match(info.warnings[0], /unsigned/i);
  assert.match(info.warnings[0], /0x11/);
  assert.match(info.warnings[0], /USB/);
  assert.match(summarize(info), /unsigned/);
});

test('a file named -unsigned.bin gets the note about its signed sibling', () => {
  const info = inspectImage(fakeImage({ signed: false }), 'app-unsigned.bin');
  assert.equal(info.problems.length, 0);
  assert.ok(info.warnings.some((w) => /-unsigned/.test(w)));
  const plain = inspectImage(fakeImage({ signed: false }), 'app.bin');
  assert.ok(!plain.warnings.some((w) => /-unsigned/.test(w)));
});

test('the Wi-Fi half of the OTA service is recognised, as the desktop app does', () => {
  const marker = [...'wifi_ssid'].map((c) => c.charCodeAt(0));
  const withWifi = fakeImage();
  withWifi.set(marker, 0x600);
  const info = inspectImage(withWifi);
  assert.equal(info.keepsOta, true);
  assert.equal(info.keepsWifiOta, true);
  assert.match(summarize(info), /BLE \+ Wi-Fi/);

  const bleOnly = inspectImage(fakeImage());
  assert.equal(bleOnly.keepsWifiOta, false);
  assert.match(summarize(bleOnly), /keeps OTA \(BLE\)/);
});

test('an image for the wrong chip is a problem', () => {
  const info = inspectImage(fakeImage({ chipId: 0x0009 }));
  assert.equal(info.chip, 'ESP32-S3');
  assert.ok(info.problems.some((p) => /not the ESP32-C3/.test(p)));
});

test('an image without the OTA service warns that it is one-way', () => {
  const info = inspectImage(fakeImage({ withOtaSvc: false }));
  assert.equal(info.keepsOta, false);
  assert.equal(info.problems.length, 0, 'it still boots, so not a problem');
  assert.ok(info.warnings.some((w) => /USB cable/.test(w)));
});

test('non-images are rejected without pretending to parse them', () => {
  const notEsp = new Uint8Array(4096);
  notEsp[0] = 0x7f; // ELF, i.e. someone picked the .elf by mistake
  const info = inspectImage(notEsp);
  assert.equal(info.valid, false);
  assert.ok(info.problems.some((p) => /not an ESP32 application image/i.test(p)));

  const tiny = inspectImage(new Uint8Array([0xe9, 0x01]));
  assert.equal(tiny.valid, false);
  assert.ok(tiny.problems.some((p) => /too small/i.test(p)));
});

test('formatBytes reads the way the desktop app does', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(593920), '580.0 KB');
  assert.equal(formatBytes(1048576 * 2), '2.00 MB');
});
