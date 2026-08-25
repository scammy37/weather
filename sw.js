/* Service worker — makes the dashboard installable and usable offline.

   Strategy
     app shell (html/js/svg/json)  network-first, cache fallback
       so a deploy is picked up immediately, but a cold subway ride still works.
     Open-Meteo requests                 never cached here
       api.js already caches the *aggregated* normals in localStorage, and live
       conditions must never be served stale — a cached "72°F" from yesterday is
       worse than an honest error.
*/
/* Both the cache name and the ?v= stamps below are written by
   scripts/stamp-assets.mjs from a hash of the shell's contents. Do not edit
   them by hand; test/globals.mjs fails if they are stale. */
const CACHE = 'weather-0f8a1d5f7f';

/* Must list every script index.html loads. test/globals.mjs asserts this:
   js/units.js was missing here once, which would have broken the installed
   app offline while working perfectly online. */
const SHELL = [
  './', './index.html', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png',
  './js/config.js?v=0f8a1d5f7f', './js/units.js?v=0f8a1d5f7f', './js/solar.js?v=0f8a1d5f7f', './js/api.js?v=0f8a1d5f7f',
  './js/climate.js?v=0f8a1d5f7f', './js/charts.js?v=0f8a1d5f7f', './js/radar.js?v=0f8a1d5f7f', './js/app.js?v=0f8a1d5f7f'
];

/* Best-effort extras: nice to have offline, but their absence must not stop
   the shell being cached. */
const EXTRAS = ['./data/climate.json', './data/validation.json'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    /* Cached one at a time rather than with addAll: addAll is atomic, so a
       single 404 would silently leave the whole app uncached. */
    await Promise.allSettled(SHELL.map(u => c.add(u)));
    await Promise.allSettled(EXTRAS.map(u => c.add(u)));
  })().catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname.endsWith('open-meteo.com')) return;   // always live

  e.respondWith(
    /* cache: 'reload' bypasses the browser's HTTP cache on the way out. Without
       it "network-first" is a lie: GitHub Pages sends max-age=600, so this
       fetch could be answered from the browser's own cache and the worker
       would happily store and serve code that is ten minutes stale. */
    fetch(e.request, url.origin === self.location.origin ? { cache: 'reload' } : undefined)
      .then(res => {
        if (res && res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request).then(m => m || caches.match('./index.html')))
  );
});
