# ESP32 OTA — web

The same app in a browser, over **Bluetooth or Wi-Fi**. No install, no store,
no SDK. It shares the protocol, the image inspector, the transfer state
machine, the settings TLV and the retry policy with the mobile app by
importing them from `../src` — nothing is re-implemented here, so the two
front ends cannot drift.

```bash
npm run serve:web     # http://localhost:8123, rebuilds on change
npm run build:web     # web/dist: index.html + a 26 KB app.js
```

## Read this before deciding where to host it

Three browser rules apply here, they have nothing to do with each other, and
each one disables a different half of the app. **No single address enables
everything**, so pick the one that matches what you need:

| Where the page is served from | Bluetooth | Wi-Fi |
|---|---|---|
| `http://localhost` (`npm run serve:web`) | ✅ full | ⚠️ works, verdict inferred |
| `https://…` (any normal web host) | ✅ full | ❌ blocked |
| `http://…` on the LAN | ❌ blocked | ⚠️ works, verdict inferred |
| `http://<board>` (served by the board) | ❌ blocked | ✅ full |
| `file://…` opened from disk | ❌ blocked | ❌ blocked |

The app works this out at load time and says so at the top of the screen, with
the reason — it never shows a button that cannot work. `src/capabilities.ts`
is that decision, and it is pure, so every row above is a unit test.

**Why each rule bites:**

1. **Web Bluetooth needs a secure context** — `https`, or `localhost`. A page
   served over plain `http` from a LAN address is not one, so the API is
   withheld even in Chrome.
2. **Mixed content** — a page on `https` may not touch `http://<board>` at
   all. The board speaks plain HTTP and has no certificate. Nothing on the
   board can change this; the browser refuses before anything is sent.
3. **CORS** — the firmware sends no `Access-Control-Allow-Origin`, so a page
   on a different origin may *send* to the board but may not *read* the reply.

## iOS

**There is no Bluetooth on iPhone or iPad, in any browser.** Safari has never
shipped Web Bluetooth, and Apple requires every iOS browser to use WebKit, so
Chrome and Firefox there cannot offer it either. On iOS this app is Wi-Fi
only, which means the board has to be on the network already — and getting it
onto a network is a Bluetooth job. In practice that means iPhone can update a
board that is already provisioned, and cannot provision a new one.

Full parity on iPhone needs the native app: the React Native codebase in the
parent folder already has the iOS paths, and `eas build -p ios` builds it in
the cloud without a Mac. That needs an Apple Developer Program membership.

## The cross-origin Wi-Fi mode, and why it is kept

Cross-origin the upload still works, which is worth explaining because it
looks like it should not.

The POST goes out with `Content-Type: text/plain`. That type is
CORS-safelisted, so the browser sends it **without a preflight** — which
matters, because the firmware has no `OPTIONS` handler and would answer one
with a 404. The firmware never looks at `Content-Type` anyway; `ota_post_handler`
reads `content_len` and nothing else, so the bytes land exactly as they do from
the desktop app. `XMLHttpRequest.upload.onprogress` still fires, so the progress
bar is measured rather than guessed.

Only the *reply* is withheld. So the verdict is inferred instead: the app
watches the board drop off the network and come back, which is what a
successful update looks like from outside. A board that never went away never
rebooted and so never took the image — that much is solid. Whether it booted
the *new* image cannot be told from here, and the result says so rather than
claiming a success it did not read.

Serving the page from the board removes all of this, which is the one argument
for doing it.

## What differs from the mobile app

| | Mobile | Web |
|---|---|---|
| Finding a board | a live scan you can watch | the browser's own chooser — a page may not enumerate devices |
| Pairing | Android bonds automatically on the first encrypted write | no pairing API at all; on desktop the board must be paired in the OS first |
| Write size | from the negotiated MTU | nothing exposes the MTU, so it starts at 512 and halves on the first over-long write |
| Transports | Bluetooth | Bluetooth **and** Wi-Fi |

Everything else — the flow control, the 16 KB window, the error table, the
retry policy, the settings limits in UTF-8 bytes, treating a missing DONE as
success — is the same code.

## Settings without an upload

**Change settings over BLE** writes the name and Wi-Fi credentials on their
own and restarts the board to apply them, with no firmware involved. Three
attempts when the link is what failed, none when the board answered — a
verdict is final. **Read from board** shows what it currently holds; the
password is never readable over any transport, so the firmware answers with
one byte for "a password is stored" or "none".

Filled in alongside an upload instead, the settings are stored just before it
with the restart flag off, and the reboot at the end applies both at once.

## Layout

```
web/index.html               the page, with its CSS inline
web/src/capabilities.ts      what works here, and why not      (pure, tested)
web/src/env.ts               the only reader of live globals
web/src/files.ts             <input type=file> -> inspected image
web/src/transport/wifiParse.ts  /ping parsing, addresses       (pure, tested)
web/src/transport/wifi.ts    POST /ota, progress, reboot watch
web/src/transport/webble.ts  OtaIo + CfgIo over Web Bluetooth
web/src/main.ts              the one screen
web/build.mjs                esbuild: bundle, watch, serve
```

`capabilities.ts` and `wifiParse.ts` have no DOM imports, which is what lets
them run under `node --test` beside the rest of the pure modules — the same
boundary the mobile app draws at `firmwareFile.ts`. They are covered by 18 of
the suite's 86 tests.

## Testing

```bash
npm test          # 86 tests, all front ends
npm run typecheck # the mobile app and the web app, separately
```

The web app is typechecked by `web/tsconfig.json` against DOM types; the root
config excludes `web/` because React Native has no `window`.
