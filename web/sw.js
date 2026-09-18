/**
 * A deliberately small service worker: it exists so the app can be installed
 * to a phone's home screen and opened again with no internet.
 *
 * That matters more here than for most pages. The board is usually on a bench
 * on its own network segment, or on a phone's hotspot with no route out, and
 * an update tool that needs the internet to *load* is useless exactly when it
 * is needed. Nothing this app does requires a network beyond the board itself.
 *
 * Cache strategy is network-first for the shell, falling back to the cache.
 * Not cache-first: a stale bundle that still "works" is the worst outcome for
 * a tool that writes firmware, so a reachable server always wins and the cache
 * is only the offline safety net. CACHE is versioned, and activate deletes
 * every older one, so a deploy cannot leave two bundles interleaved.
 */
const CACHE = 'esp32-ota-v1';
const SHELL = ['.', 'index.html', 'app.js', 'manifest.webmanifest', 'icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // addAll is atomic and would fail the whole install over one missing
      // file, so each is added on its own and a miss is survivable.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Only ever touch our own origin. Board traffic - /ota and /ping on another
  // host entirely - must reach the network untouched and must never be cached.
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((hit) => hit ?? caches.match('index.html'))
      )
  );
});
