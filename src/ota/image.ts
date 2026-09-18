/**
 * Read what an ESP-IDF application image says about itself, before uploading it.
 *
 * Worth doing on a phone even more than on a desktop: a BLE upload takes the
 * better part of a minute, and the ways it predictably ends in failure - wrong
 * chip, OTA service missing, a board that still verifies signatures - are all
 * visible in the first 300 bytes of the file. Ported from the desktop app's
 * `inspect_image()` in ESP32-Tools' `appimage.py`, and kept in step with it.
 */
import { readCString, readU16LE, readU32LE } from '../lib/bytes';

const ESP_IMAGE_MAGIC = 0xe9;
const APP_DESC_MAGIC = 0xabcd5432;
const APP_DESC_OFFSET = 0x20;
const SIG_BLOCK_MAGIC = 0xe7;
const SIG_BLOCK_SIZE = 4096;

/** The chip this app targets; anything else will not boot. */
export const EXPECTED_CHIP_ID = 0x0005; // ESP32-C3

export const CHIP_IDS: Record<number, string> = {
  0x0000: 'ESP32',
  0x0002: 'ESP32-S2',
  0x0005: 'ESP32-C3',
  0x0009: 'ESP32-S3',
  0x000c: 'ESP32-C2',
  0x000d: 'ESP32-C6',
  0x0010: 'ESP32-H2',
  0x0012: 'ESP32-P4',
};

/**
 * The OTA service UUID as NimBLE stores it, little-endian. Finding it in an
 * image is a reliable proxy for "this firmware can still be updated
 * wirelessly" - an image without it boots fine and then can only be reached
 * with a cable.
 */
const OTA_SVC_BYTES = [
  0x10, 0x2a, 0x3b, 0x4c, 0x5a, 0x6e, 0x1f, 0x9d, 0x2c, 0x4b, 0x3e, 0x8a, 0x00,
  0xff, 0x00, 0x00,
];

/**
 * The NVS key the Wi-Fi OTA transport reads its network from. Present only in
 * firmware that carries the Wi-Fi half of the service; the desktop app uses the
 * same marker to label an image "BLE + Wi-Fi".
 */
const WIFI_OTA_MARKER = [...'wifi_ssid'].map((c) => c.charCodeAt(0));

export interface ImageInfo {
  sizeBytes: number;
  /** A parseable ESP application image. */
  valid: boolean;
  chipId: number | null;
  chip: string | null;
  project: string | null;
  version: string | null;
  buildDate: string | null;
  buildTime: string | null;
  idfVersion: string | null;
  signed: boolean;
  /** Carries the BLE OTA service, so the board stays updatable over the air. */
  keepsOta: boolean;
  /** Also carries the Wi-Fi OTA transport. */
  keepsWifiOta: boolean;
  /** Reasons not to upload this at all. */
  problems: string[];
  /** Reasons to think twice. */
  warnings: string[];
}

function findBytes(haystack: Uint8Array, needle: number[]): boolean {
  const last = haystack.length - needle.length;
  outer: for (let i = 0; i <= last; i++) {
    if (haystack[i] !== needle[0]) continue;
    for (let j = 1; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Inspect an image. `name` is the file's name when known: one of the checks is
 * about how a build names its output, not about the bytes.
 */
export function inspectImage(bytes: Uint8Array, name?: string): ImageInfo {
  const info: ImageInfo = {
    sizeBytes: bytes.length,
    valid: false,
    chipId: null,
    chip: null,
    project: null,
    version: null,
    buildDate: null,
    buildTime: null,
    idfVersion: null,
    signed: false,
    keepsOta: false,
    keepsWifiOta: false,
    problems: [],
    warnings: [],
  };

  if (bytes.length < 0x120) {
    info.problems.push(
      'This file is too small to be an ESP32 application image.'
    );
    return info;
  }
  if (bytes[0] !== ESP_IMAGE_MAGIC) {
    info.problems.push(
      'This is not an ESP32 application image (it does not start with 0xE9). ' +
        'Pick the app .bin, not the bootloader or a partition table.'
    );
    return info;
  }

  info.valid = true;
  info.chipId = readU16LE(bytes, 12);
  info.chip = CHIP_IDS[info.chipId] ?? null;

  if (readU32LE(bytes, APP_DESC_OFFSET) === APP_DESC_MAGIC) {
    info.version = readCString(bytes, 0x30, 32) || null;
    info.project = readCString(bytes, 0x50, 32) || null;
    info.buildTime = readCString(bytes, 0x70, 16) || null;
    info.buildDate = readCString(bytes, 0x80, 16) || null;
    info.idfVersion = readCString(bytes, 0x90, 32) || null;
  } else {
    info.warnings.push('No esp_app_desc_t found; version info unavailable.');
  }

  // Secure Boot v2 puts its signature in the image's own final 4 KB sector.
  info.signed =
    bytes.length >= SIG_BLOCK_SIZE &&
    bytes[bytes.length - SIG_BLOCK_SIZE] === SIG_BLOCK_MAGIC;

  info.keepsOta = findBytes(bytes, OTA_SVC_BYTES);
  info.keepsWifiOta = findBytes(bytes, WIFI_OTA_MARKER);

  if (!info.signed) {
    // Unsigned is the expected shape of an image now: the desktop toolchain
    // leaves signature verification off, so a board flashed from it takes any
    // build it is sent. It is only worth a word for a board that predates that
    // - it still verifies the next update - so this is a warning about one
    // situation, not a problem with the file in hand.
    info.warnings.push(
      'Unsigned image - expected, since signature verification is off. A ' +
        'board last flashed while verification was still on rejects it with ' +
        'error 0x11; flash that board over USB once with the desktop app and ' +
        'it takes unsigned updates afterwards.'
    );
    if (name && name.endsWith('-unsigned.bin')) {
      info.warnings.push(
        "Filename says '-unsigned', which only a signed build produces. If " +
          'this project does sign, the signed image sits beside it under the ' +
          'same name without the suffix.'
      );
    }
  }
  if (info.chipId !== EXPECTED_CHIP_ID) {
    info.problems.push(
      `This image targets ${info.chip ?? `chip id 0x${info.chipId.toString(16)}`}` +
        ', not the ESP32-C3. It would not boot.'
    );
  }
  if (!info.keepsOta) {
    info.warnings.push(
      'The OTA service was not found in this image. It will run, but the board ' +
        'will only be updatable with a USB cable afterwards - this is a one-way ' +
        'upload. Rollback may rescue you: unless the image marks itself valid, ' +
        'the bootloader reverts on the next reset.'
    );
  }

  return info;
}

/** One line for the UI, mirroring the desktop app's firmware summary. */
export function summarize(info: ImageInfo): string {
  if (!info.valid) return 'Not an ESP32 application image';
  const bits: string[] = [];
  if (info.project) bits.push(info.project);
  if (info.version) bits.push(`v${info.version}`);
  bits.push(`${(info.sizeBytes / 1024).toFixed(1)} KB`);
  if (info.chip) bits.push(info.chip);
  bits.push(
    info.keepsOta
      ? info.keepsWifiOta
        ? 'keeps OTA (BLE + Wi-Fi)'
        : 'keeps OTA (BLE)'
      : 'no OTA'
  );
  bits.push(info.signed ? 'signed' : 'unsigned');
  return bits.join('  ·  ');
}
