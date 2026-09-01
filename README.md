# ESP32 OTA — mobile

Send firmware to an ESP32-C3 over Bluetooth from a phone. React Native + Expo,
so the same codebase covers Android now and iOS when you want it.

Companion to the desktop app in [`../ESP32-Tools`](../ESP32-Tools), which
provisions a blank board over USB. This app does not provision and does not
sign — it sends an already-signed image to a board that is already running the
OTA firmware.

> **Status: not yet run on a device.** The protocol, the image inspector and the
> transfer state machine are unit-tested (29 tests) and the whole app
> type-checks against the real library types, but nobody has installed this on a
> phone or pointed it at a board. See [Building](#building) — this machine has
> no Android SDK.

## Why React Native, and not a web app

The firmware marks its CTRL and DATA characteristics `BLE_GATT_CHR_F_WRITE_ENC`,
so the link must be **bonded** before the board accepts a single firmware byte.

That one fact rules out the browser: Web Bluetooth has no pairing API at all. It
is the same reason the desktop app runs BLE through Python and `bleak` rather
than doing it in Electron — on Windows only WinRT's `PairAsync` can initiate
bonding from code.

Android and iOS both bond *automatically* the first time an encrypted
characteristic is written, so `react-native-ble-plx` works on both without any
explicit pairing call. Nothing in this app initiates pairing; the first CTRL
write is what makes Android show its prompt.

## The protocol

Service `0000ff00-8a3e-4b2c-9d1f-6e5a4c3b2a10`, five characteristics on it:

| Characteristic | Use |
|---|---|
| `…ff01` CTRL | `START` + length, `END`, `ABORT` — always written with a response |
| `…ff02` DATA | firmware chunks, written *without* response in fast mode |
| `…ff03` STAT | notifications: READY, PROGRESS, DONE, ERROR |
| `…ff04` WIFI | the board's IP, for the desktop app's Wi-Fi transport |
| `…ff05` CFG | name and Wi-Fi credentials (not used by this app yet) |

A transfer is: write `START` with the total length, wait for READY, stream the
image, write `END`, wait for DONE.

**Flow control is the interesting part.** Fast mode writes without response, so
several packets ride each connection interval instead of one round trip per
chunk — the single biggest lever on BLE OTA time. Nothing acknowledges an
individual packet any more, so the sender meters itself against the board's
committed-bytes notifications and never lets more than 16 KB be outstanding.
That ceiling is not arbitrary: exceed the firmware's receive buffer and the board
answers `0x21`.

Two decisions worth knowing before you change them:

- **A missing DONE counts as success.** The board reboots the instant it accepts
  the image, which can beat the notification out the door. Reporting failure
  there would be a lie.
- **A missing READY does not abort.** Some builds start accepting data without
  ever sending it, so the transfer streams anyway and lets `END` adjudicate.

## Layout

```
src/lib/bytes.ts        base64 + little-endian helpers      (pure)
src/ota/protocol.ts     UUIDs, opcodes, status decoder,
                        the device error table              (pure)
src/ota/image.ts        what an .esp app image says
                        about itself                        (pure)
src/ota/session.ts      the transfer state machine          (pure, over an interface)
src/ota/firmwareFile.ts picking and reading a .bin          (expo-file-system)
src/ble/transport.ts    react-native-ble-plx adapter        (native)
App.tsx                 the one screen
```

The split is deliberate. Everything above `firmwareFile.ts` has no React Native
or Expo import, which is what makes the part that can be *silently* wrong — the
wire protocol and the flow control — testable in plain node with a fake board.
`session.ts` talks to an `OtaIo` interface, never to a BLE client.

## Testing

```bash
npm test        # 29 tests, ~300 ms
npm run typecheck
```

The tests compile the pure modules to CommonJS (`tsconfig.test.json`) and run
them under `node --test`. They cover base64 at every length that exposes a
padding bug, the status decoder including truncated packets, image inspection
(signed, unsigned, wrong chip, OTA service missing, an `.elf` picked by
mistake), and the state machine against a fake board that can withhold
acknowledgements, reject START, error mid-stream, or go quiet.

That last group earned its keep. The suite originally took 30 seconds because a
rejected START sat unread for the full 30-second READY timeout — every wait
watched a single gate, so an error arriving during one was invisible until the
timeout expired. On a phone that is half a minute of "Erasing" before being told
the board has no OTA partition. Racing each wait against the failure gate cut
the suite to 0.3 s, and there is a regression test asserting a rejected START
returns in under two seconds.

## Building

**This project has never been compiled.** There is no Android SDK, no Gradle and
no `adb` on the machine it was written on, and its Java is 1.8 where modern
Android Gradle wants 17+. `npx expo prebuild` was run to verify the config plugin
chain produces the right `AndroidManifest.xml`, which it does — but that
generates files, it does not compile them.

Two ways forward.

### Cloud build — no Android SDK needed

```bash
npm install -g eas-cli
eas login                       # a free Expo account
eas build -p android --profile preview
```

`preview` produces an installable **APK** (`eas.json`). EAS returns a download
link; put it on the phone and install it. `development` builds a dev client if
you want Metro's fast refresh against a real board.

### Local build

Install Android Studio and a JDK 17+, then:

```bash
npx expo run:android
```

`react-native-ble-plx` is a native module, so **Expo Go will not work** — it has
to be a dev build or a real build.

## Permissions

Handled at two levels, and they have to agree:

- The `react-native-ble-plx` config plugin runs with `neverForLocation: true`, so
  the manifest gets `BLUETOOTH_SCAN` with that flag and caps
  `ACCESS_FINE/COARSE_LOCATION` at `maxSdkVersion="30"`.
- `requestBlePermissions()` therefore asks for `BLUETOOTH_SCAN` +
  `BLUETOOTH_CONNECT` on API 31+, and `ACCESS_FINE_LOCATION` below it. API 31
  split Bluetooth out of location; before it, scanning genuinely needed the
  location permission.

The generated manifest was checked against this — it is easy to write runtime
requests for a permission the manifest never declared, and the failure looks
like a Bluetooth bug.

## Known risks

- **New Architecture.** Expo 57 / RN 0.86 default to it and offer no opt-out
  flag, while `react-native-ble-plx` 3.5.1 is still a legacy (Paper) module with
  no `codegenConfig`. RN 0.86 ships the TurboModule interop layer that exists to
  carry exactly such modules, so this is expected to work — but only a real build
  proves it. If it fails, that is the first thing to look at.
- **iOS is untested and unbuilt.** The code paths are there and CoreBluetooth
  bonds the same way, but iOS needs a Mac or an EAS build, and MTU is smaller
  (~185 vs Android's 517), so transfers will be slower.
- `expo-dev-client` pulls `SYSTEM_ALERT_WINDOW` and `VIBRATE` into the manifest.
  Drop the dependency for a store build if you would rather not declare them.

## The signing key still rules everything

This app only *sends* images. The board checks every one against the RSA-3072 key
baked into the firmware it is currently running, so an image signed with a
different key is rejected with `0x11` after the whole upload has transferred.

The inspector catches that before you spend the minute: an unsigned image is
reported as a problem with the reason, and uploading it needs a deliberate second
tap. What it cannot detect is an image signed with the *wrong* key — only the
board knows that.

A key cannot be rotated over the air. Changing it means a USB provision from the
desktop app. Keep `ota_signing_key.pem` backed up somewhere that is not one
laptop.
