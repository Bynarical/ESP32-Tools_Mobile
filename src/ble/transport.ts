/**
 * react-native-ble-plx bound to the OTA protocol.
 *
 * Why this library and not Web Bluetooth: the firmware marks CTRL and DATA
 * `BLE_GATT_CHR_F_WRITE_ENC`, so the link must be **bonded** before it accepts
 * a single firmware byte. Web Bluetooth has no pairing API at all - which is
 * why the desktop app needs Python and bleak rather than doing BLE in Electron.
 * Android and iOS both bond automatically the first time an encrypted
 * characteristic is touched, so nothing here initiates pairing explicitly; the
 * first CTRL write is what triggers the system prompt.
 */
import { PermissionsAndroid, Platform } from 'react-native';
import {
  BleError,
  BleManager,
  Device,
  State,
  Subscription,
} from 'react-native-ble-plx';

import { fromBase64, toBase64 } from '../lib/bytes';
import {
  CTRL_UUID,
  DATA_UUID,
  DEFAULT_DEVICE_NAME,
  STAT_UUID,
  SVC_UUID,
  chunkForMtu,
} from '../ota/protocol';
import type { OtaIo } from '../ota/session';

/** Android grants at most 517; iOS negotiates its own and ignores the request. */
const WANTED_MTU = 517;

let manager: BleManager | null = null;

export function bleManager(): BleManager {
  if (!manager) manager = new BleManager();
  return manager;
}

export interface FoundBoard {
  id: string;
  name: string | null;
  rssi: number | null;
  /** Advertised the OTA service, or carries the expected name. */
  isOtaBoard: boolean;
}

/**
 * Ask for what this Android version actually requires.
 *
 * API 31 split Bluetooth out of location: before it, scanning needed
 * ACCESS_FINE_LOCATION and nothing else worked without it; from it, SCAN and
 * CONNECT are their own permissions and location is not involved.
 */
export async function requestBlePermissions(): Promise<{
  granted: boolean;
  missing: string[];
}> {
  if (Platform.OS !== 'android') return { granted: true, missing: [] };

  const api = typeof Platform.Version === 'number' ? Platform.Version : 0;
  const wanted =
    api >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];

  const result = await PermissionsAndroid.requestMultiple(wanted);
  const missing = wanted.filter(
    (p) => result[p] !== PermissionsAndroid.RESULTS.GRANTED
  );
  return { granted: missing.length === 0, missing };
}

export async function bluetoothState(): Promise<State> {
  return bleManager().state();
}

/**
 * Scan until stopped, reporting each board once per RSSI change.
 *
 * Deliberately unfiltered: matching on the service UUID alone misses a board
 * whose advertising packet truncated it, and matching on the name alone misses
 * a renamed board. The desktop app accepts either, so this does too.
 */
export function scanForBoards(
  onFound: (board: FoundBoard) => void,
  onError: (e: BleError) => void,
  expectedName: string = DEFAULT_DEVICE_NAME
): () => void {
  const seen = new Map<string, string>();

  bleManager().startDeviceScan(null, { allowDuplicates: false }, (err, device) => {
    if (err) {
      onError(err);
      return;
    }
    if (!device) return;

    const name = device.name ?? device.localName ?? null;
    const uuids = (device.serviceUUIDs ?? []).map((u) => u.toLowerCase());
    const isOtaBoard =
      uuids.includes(SVC_UUID.toLowerCase()) ||
      (!!name && name === expectedName);

    // Every advertisement carries a slightly different RSSI, so republishing on
    // any change would spam the list several times a second.
    const signature = `${name}|${isOtaBoard}`;
    if (seen.get(device.id) === signature) return;
    seen.set(device.id, signature);

    onFound({ id: device.id, name, rssi: device.rssi ?? null, isOtaBoard });
  });

  return () => {
    try {
      bleManager().stopDeviceScan();
    } catch {
      // Already stopped, or the adapter went away - nothing to undo.
    }
  };
}

/** A connected board, ready to run a transfer. */
export class BoardLink implements OtaIo {
  readonly chunkSize: number;

  private constructor(
    private readonly device: Device,
    private readonly subscription: Subscription,
    mtu: number
  ) {
    this.chunkSize = chunkForMtu(mtu);
  }

  static async connect(
    deviceId: string,
    onStatus: (bytes: Uint8Array) => void,
    onDisconnect?: (reason: string | null) => void
  ): Promise<BoardLink> {
    const mgr = bleManager();
    // requestMTU is honoured on Android and ignored on iOS, which negotiates on
    // its own; either way chunkForMtu() clamps to what the link reports.
    const device = await mgr.connectToDevice(deviceId, { requestMTU: WANTED_MTU });
    await device.discoverAllServicesAndCharacteristics();

    let mtu = device.mtu ?? 23;
    if (Platform.OS === 'android') {
      try {
        const negotiated = await device.requestMTU(WANTED_MTU);
        mtu = negotiated.mtu ?? mtu;
      } catch {
        // Some stacks refuse a second request after connect() already asked.
      }
    }

    device.onDisconnected((_err, d) => {
      onDisconnect?.(d?.id ?? null);
    });

    const subscription = device.monitorCharacteristicForService(
      SVC_UUID,
      STAT_UUID,
      (err, characteristic) => {
        if (err || !characteristic?.value) return;
        onStatus(fromBase64(characteristic.value));
      }
    );

    return new BoardLink(device, subscription, mtu);
  }

  async writeCtrl(bytes: Uint8Array): Promise<void> {
    await this.device.writeCharacteristicWithResponseForService(
      SVC_UUID,
      CTRL_UUID,
      toBase64(bytes)
    );
  }

  async writeData(bytes: Uint8Array, withResponse: boolean): Promise<void> {
    const value = toBase64(bytes);
    if (withResponse) {
      await this.device.writeCharacteristicWithResponseForService(
        SVC_UUID,
        DATA_UUID,
        value
      );
    } else {
      await this.device.writeCharacteristicWithoutResponseForService(
        SVC_UUID,
        DATA_UUID,
        value
      );
    }
  }

  async close(): Promise<void> {
    try {
      this.subscription.remove();
    } catch {
      // Already removed with the connection.
    }
    try {
      await this.device.cancelConnection();
    } catch {
      // Already disconnected.
    }
  }
}

/**
 * Turn a library error into something worth showing a user.
 *
 * The two that actually happen in the field are a refused pairing and a link
 * that drops mid-transfer, and neither is self-explanatory from the raw text.
 */
export function describeBleError(e: unknown): { message: string; hint?: string } {
  const raw = e instanceof Error ? e.message : String(e);
  const low = raw.toLowerCase();

  if (low.includes('not authorized') || low.includes('insufficient authentication')) {
    return {
      message: 'The board refused the write because the link is not bonded.',
      hint:
        'Accept the Bluetooth pairing prompt. If you declined it, forget the ' +
        "board in Android's Bluetooth settings and try again.",
    };
  }
  if (low.includes('was disconnected') || low.includes('disconnected')) {
    return {
      message: 'The Bluetooth link dropped.',
      hint:
        'Stay within a few metres of the board during an upload and keep the ' +
        'screen on. The board keeps its current firmware, so retrying is safe.',
    };
  }
  if (low.includes('powered off') || low.includes('bluetoothle is powered off')) {
    return { message: 'Bluetooth is turned off.', hint: 'Turn Bluetooth on.' };
  }
  if (low.includes('scan') && low.includes('permission')) {
    return {
      message: 'Bluetooth permission was denied.',
      hint: 'Grant Nearby devices permission in Android app settings.',
    };
  }
  return { message: raw };
}
