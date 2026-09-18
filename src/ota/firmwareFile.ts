/**
 * Getting a firmware image off the phone.
 *
 * expo-file-system in SDK 57 has both the picker and a byte reader, so there is
 * no need for expo-document-picker here. `File` exposes no name getter, hence
 * the basename is taken from the URI.
 */
import { File } from 'expo-file-system';

import { ImageInfo, inspectImage } from './image';

export interface LoadedFirmware {
  name: string;
  uri: string;
  bytes: Uint8Array;
  info: ImageInfo;
}

function basename(uri: string): string {
  try {
    const decoded = decodeURIComponent(uri);
    const parts = decoded.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] || 'firmware.bin';
  } catch {
    return 'firmware.bin';
  }
}

/**
 * Ask the user for a .bin, read it, and say what it is.
 *
 * Returns null when the picker was dismissed - a cancel is not an error and
 * should not surface as one.
 */
export async function pickFirmware(): Promise<LoadedFirmware | null> {
  const picked = await File.pickFileAsync({
    // Android hands .bin files a generic type, so filtering on
    // application/octet-stream alone hides them on some devices. Allowing
    // everything and validating the bytes afterwards is more reliable, and the
    // validation has to happen regardless.
    mimeTypes: ['*/*'],
  });
  if (picked.canceled || !picked.result) return null;

  const file = picked.result;
  const bytes = await file.bytes();
  const name = basename(file.uri);
  return {
    name,
    uri: file.uri,
    bytes,
    // The name goes along: one of the checks is about how a build names its
    // output ('-unsigned.bin'), which the bytes alone cannot say.
    info: inspectImage(bytes, name),
  };
}
