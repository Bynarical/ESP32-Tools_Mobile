# ESP32 OTA — mobile

Send firmware to an ESP32-C3 over Bluetooth from a phone, and change the board's
name and Wi-Fi network while you are there. React Native + Expo, so the same
codebase covers Android now and iOS when you want it.

Companion to the desktop app in [`../ESP32-Tools`](../ESP32-Tools), which
provisions a blank board over USB. This app does not provision and does not
sign — it sends an already-signed image to a board that is already running the
OTA firmware.

There is also a **browser version** in [`web/`](web/README.md), sharing this
app's protocol, image inspector, transfer state machine and retry policy by
importing them directly. It speaks Bluetooth *and* the board's Wi-Fi OTA
endpoint, and needs no install. Note that Web Bluetooth does not exist on iOS
in any browser, so on iPhone the web version is Wi-Fi only; its README has the
full matrix of what works where.

> **Status: not yet run on a device.** The protocol, the image inspector, the
> transfer state machine, the settings path and the retry policy are
> unit-tested (86 tests) and the whole app type-checks against the real library
> types, but nobody has installed this on a phone or pointed it at a board. See
> [Building](#building) — this machine has no Android SDK.

**In step with ESP32 Tools 1.4.5.** The wire protocol, the error table and the
decisions around it are transcribed from the desktop app's backend and updated
with it: signature verification is off by default there, so an unsigned image
is the normal case here too; a link that fails is tried again, twice, as the
daemon does; settings ride ahead of an upload and are deferred when the board's
firmware is too old to take them; and the log is for one opening of the app.

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
| `…ff05` CFG | name and Wi-Fi credentials — read, and written with a response |

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
- **A link failure is retried, a verdict is not.** The desktop daemon gives an
  upload two more tries, two seconds apart, when the connection is what failed
  — a drop, a stall, a connect that never came up — because the board keeps its
  current firmware until `END` is accepted, so starting over is safe. The same
  policy runs here (`src/ota/retry.ts`). Codes `0x02`, `0x03` and `0x11` are
  about the image and come back identical every time, so they end the attempt
  at once; so does a cancel.

## Changing the name and Wi-Fi network

A board that is already running the OTA firmware takes three settings over the
same link that carries firmware: Bluetooth name, Wi-Fi SSID, Wi-Fi password.
They live in NVS rather than in the image, which is what lets them change
without a rebuild — and, here, without a cable. This is the desktop app's
*Change settings over BLE*, on the phone.

Two ways in, both from the fields in **2 · Board settings**:

* **Change settings over BLE** writes them on their own. The board stores them
  and restarts to apply.
* **the switch above Upload** sends them just before a firmware upload, with the
  restart flag off — the reboot at the end of that upload applies both at once,
  so a new build can arrive on a new network under a new name in one visit. If
  the board refuses the settings the firmware is not sent: a board that comes
  back on the old network under the old name, having reported success, is worse
  than a no-op. One refusal is different: a board whose firmware has no
  settings characteristic at all cannot take them *yet*, and the image about to
  be sent is what adds it — so the upload goes ahead, the app waits for the
  board to advertise again, and stores the settings on the new firmware with a
  restart of their own. This is the desktop daemon's behaviour, step for step.

A settings write on its own gets three attempts when the link is what failed,
as the daemon's does; a verdict from the board — a device code — is final.

A blank field is not sent at all, so the board keeps what it has: to change only
the Wi-Fi password, fill in the SSID and the new password and leave the name
empty. An SSID with an empty password means an open network. The password is
only ever sent alongside an SSID, because the pair has to stay consistent — a new
SSID next to the old password leaves the board unable to associate, and so no
longer reachable over the transport you would use to fix it.

Unlike a USB provision this touches nothing but those three keys: both app slots,
`otadata` and — the part that matters day to day — the board's Bluetooth bonds all
survive, so the phone does not have to pair again.

**Read from board** shows what it is currently holding. The app reads before
every write too, which is how a board running firmware too old for this is
diagnosed *before* anything has been sent to it. The password itself is not
readable over any transport; the firmware answers with one byte for "a password
is stored" or "none".

The limits are in **bytes of UTF-8**, not characters — 26, 32 and 63 — so each
field shows a byte count. A nine-syllable Hangul name is 27 bytes, and counting
characters would send it only for the board to answer `0x31` after a connect, a
bond and a write.

Two things this cannot do:

- **Older firmware has no `ff05` at all.** That is reported as exactly that,
  with the remedy: upload a current image first — an upload this app can do
  wirelessly, after which settings work from here.
- **It is BLE only, deliberately.** The characteristic is `WRITE_ENC`, so the
  link has to be bonded and encrypted first, which is the one gate the board
  really has. An HTTP endpoint on the LAN would let anything on the network move
  the board onto another access point.

## Layout

```
src/lib/bytes.ts         base64, UTF-8, little-endian
                         helpers                            (pure)
src/lib/gate.ts          an awaitable flag, and a race
                         across several of them             (pure)
src/ota/protocol.ts      UUIDs, opcodes, status decoder,
                         the device error table             (pure)
src/ota/image.ts         what an .esp app image says
                         about itself                       (pure)
src/ota/config.ts        the settings TLV, and what may
                         go in it                           (pure)
src/ota/session.ts       the transfer state machine         (pure, over an interface)
src/ota/configSession.ts the settings write                 (pure, over an interface)
src/ota/firmwareFile.ts  picking and reading a .bin         (expo-file-system)
src/ble/transport.ts     react-native-ble-plx adapter       (native)
App.tsx                  the one screen
```

The split is deliberate. Everything above `firmwareFile.ts` has no React Native
or Expo import, which is what makes the part that can be *silently* wrong — the
wire protocol and the flow control — testable in plain node with a fake board.
`session.ts` talks to an `OtaIo` interface, never to a BLE client.

## Testing

```bash
npm test        # 86 tests, all front ends
npm run typecheck
```

The tests compile the pure modules to CommonJS (`tsconfig.test.json`) and run
them under `node --test`. They cover base64 at every length that exposes a
padding bug, the status decoder including truncated packets, image inspection
(signed, unsigned, wrong chip, OTA service missing, an `.elf` picked by
mistake), and the state machine against a fake board that can withhold
acknowledgements, reject START, error mid-stream, or go quiet.

The settings path is tested the same way, and for the same reason — its failure
mode is a board on a network that does not exist. UTF-8 is checked against
Node's own encoder at every length that matters, the payload is checked against
the byte-for-byte shape in `ota_cfg.h` (including the 129-byte maximum the
firmware sizes its buffer for), and the write runs against a fake board that
validates before it stores, refuses while busy, answers with device codes, has
no settings characteristic at all, or drops the link before acknowledging.

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

## Signatures, and why 0x11 can still happen

The desktop toolchain builds with signature verification **off**: these are
internal boards with no eFuses burned, so the signature never protected anything
a USB cable could not already reach, while a key that drifts out of step with
the fleet strands it. A board flashed from that toolchain takes any image it is
sent, and every image it produces is unsigned. The inspector here therefore
treats an unsigned image as the expected shape — a warning, not a problem — and
labels it `unsigned` in the summary; an image that still carries a signature
block is labelled `signed`. Wrong chip and a missing OTA service remain the
things that stop an upload or ask for a second tap.

`0x11` is still possible. A board last flashed while verification was on keeps
verifying the next update and rejects an unsigned one after the whole transfer.
The fix is one USB provision with the desktop app, after which it takes
unsigned updates. Otherwise `0x11` means the image was truncated or corrupt.

## The log

The log is for one opening of the app. It is held in memory only — nothing is
written to the phone, least of all the Wi-Fi password — and it starts afresh
when the app is brought back from the background, unless an operation is still
running, whose lines are what you came back for. **Clear** empties it by hand.
