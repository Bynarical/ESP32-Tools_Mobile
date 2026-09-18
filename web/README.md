# ESP32 OTA — web

The same app in a browser, over **Bluetooth or Wi-Fi**. No install, no store,
no SDK. It shares the protocol, the image inspector, the transfer state
machine, the settings TLV and the retry policy with the mobile app by
importing them from `../src` — nothing is re-implemented here, so the two
front ends cannot drift.

```bash
npm run serve:web     # rebuilds on change, and prints an address for your phone
npm run build:web     # web/dist: a page, a 26 KB bundle, a manifest and an icon
```

## Running it on a phone

`npm run serve:web` binds every interface and prints both addresses:

```
    this PC        http://localhost:8123
                   Bluetooth and Wi-Fi both work here.

    a phone        http://192.168.0.14:8123
                   Wi-Fi only - plain http is not a secure
                   context, so the browser withholds Bluetooth.
                   This is the address an iPhone can use.
```

Open the second one on the phone — same Wi-Fi network as the PC — and the
Wi-Fi upload works, on any phone including an iPhone. It needs no hosting
decision, no account and no App Store.

What that address cannot do is Bluetooth, on any phone: a plain-`http` LAN
origin is not a secure context, so browsers withhold the API entirely. For
Bluetooth on a phone you need an `https` address — which is what GitHub Pages
is for, below.

## Read this before deciding where to host it

Three browser rules apply here, they have nothing to do with each other, and
each one disables a different half of the app. **No single address enables
everything**, so pick the one that matches what you need:

| Where the page is served from | Bluetooth | Wi-Fi |
|---|---|---|
| `http://localhost` (`npm run serve:web`) | ✅ full | ⚠️ works, verdict inferred |
| `http://<your-pc>` on the LAN — **what a phone opens** | ❌ blocked | ⚠️ works, verdict inferred |
| `https://…` — GitHub Pages, or any web host | ✅ full (iPhone: in Bluefy) | ❌ blocked |
| `http://<board>` (served by the board) | ❌ blocked | ✅ full |
| `file://…` opened from disk | ❌ blocked | ❌ blocked |

The app works this out at load time and says so at the top of the screen, with
the reason — it never shows a button that cannot work. `src/capabilities.ts`
is that decision, and it is pure, so every row above is a unit test.

**Why each rule bites:**

1. **Web Bluetooth needs a secure context** — `https`, or `localhost`. On
   anything else the browser does not merely refuse the call, it removes
   `navigator.bluetooth` from the page, which is why the app reports the
   insecure origin rather than guessing the browser is Safari.
2. **Mixed content** — a page on `https` may not touch `http://<board>` at
   all. The board speaks plain HTTP and has no certificate. Nothing on the
   board can change this; the browser refuses before anything is sent.
3. **CORS** — the firmware sends no `Access-Control-Allow-Origin`, so a page
   on a different origin may *send* to the board but may not *read* the reply.

## GitHub Pages

A workflow is ready at [`.github/workflows/pages.yml`](../.github/workflows/pages.yml),
manual-trigger only until Pages is turned on. Two things to know first.

**Pages can only ever be the Bluetooth half.** Pages is HTTPS-only and
`*.github.io` is in the browsers' HSTS preload list, so the scheme cannot be
downgraded even by typing `http://` — which means a Pages deployment can never
reach the board over Wi-Fi. What it is, is the **Bluetooth** address for
phones: Android in Chrome with nothing installed, and iPhone in Bluefy (see
[iOS](#ios)).

**It requires making this repository public.** Pages from a private repository
needs GitHub Team for an organisation account, and `Bynarical` is on the free
plan. Worse, even on a paid plan the published site is public by default —
repository visibility and Pages visibility are separate settings, and truly
private publishing exists only on Enterprise Cloud. So enabling Pages here
means the source becomes public.

Once the repository is public: **Settings → Pages → Source: GitHub Actions**,
then uncomment the `push` trigger in the workflow. The site lands at
`https://bynarical.github.io/ESP32-Tools_Mobile/`. Every reference in the page
is relative, so the subpath works without configuration.

## Installing it to a home screen

There is a web app manifest and a small service worker, so on `https` or
`localhost` the app can be added to the home screen and opened again with no
internet. That matters here more than for most pages: the board is usually on
a bench network with no route out, and an update tool that needs the internet
to *load* is useless exactly when it is wanted.

The service worker is network-first, falling back to the cache — a stale
bundle that still "works" is the worst outcome for something that writes
firmware, so a reachable server always wins. It never touches board traffic;
requests to another origin pass through untouched and uncached.

Service workers also need a secure context, so the plain-`http` LAN address a
phone uses for Wi-Fi uploads cannot install the app. It still runs there.

## iOS

**Safari has no Web Bluetooth, on any platform, and Apple requires every iOS
browser to use WebKit** — so Chrome and Firefox on an iPhone cannot offer it
either. That is Apple's decision and nothing in this app changes it.

It is not a dead end, though. [Bluefy](https://apps.apple.com/us/app/bluefy-web-ble-browser/id1492822055)
is a free App Store browser that ships its own BLE stack on top of
CoreBluetooth. Open **this same page** in it over https and `navigator.bluetooth`
is there, so Bluetooth upload and settings work with nothing to install from
us. CoreBluetooth bonds on the first write to an encrypted characteristic, the
way the native app does, so the firmware's `WRITE_ENC` gate should be satisfied
without a pairing call — that part is reasoned from how CoreBluetooth behaves
and has not been run against a board yet.

The app detects an iPhone and says this itself, with a link, instead of sending
you to Wi-Fi. Note the https requirement still applies inside Bluefy: the LAN
address from `serve:web` is plain http, so use the Pages URL there.

So, on an iPhone:

| | |
|---|---|
| Bluetooth | the Pages URL, opened in Bluefy |
| Wi-Fi | the LAN address from `npm run serve:web`, in any browser |

A native iOS build (`eas build -p ios`, cloud, no Mac, Apple Developer
membership) remains the option that needs no third-party browser.

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
web/manifest.webmanifest     home-screen install
web/sw.js                    offline shell, network-first
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
