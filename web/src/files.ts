/**
 * Getting a firmware image out of the browser - the web counterpart of
 * `src/ota/firmwareFile.ts`.
 *
 * Nothing here filters on a MIME type. Browsers hand `.bin` files whatever the
 * platform feels like, often an empty string, so an `accept` filter hides the
 * very files this app exists to send. The bytes are validated instead, which
 * has to happen regardless.
 */
import { type ImageInfo, inspectImage } from '../../src/ota/image';

export interface LoadedFirmware {
  name: string;
  size: number;
  bytes: Uint8Array;
  info: ImageInfo;
}

export async function readFirmware(file: File): Promise<LoadedFirmware> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    name: file.name,
    size: file.size,
    bytes,
    // The name goes along: one of the checks is about how a build names its
    // output ('-unsigned.bin'), which the bytes alone cannot say.
    info: inspectImage(bytes, file.name),
  };
}
