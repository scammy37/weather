/* Service worker — makes the dashboard installable and usable offline.

   Strategy
     app shell (html/js/svg/json)  network-first, cache fallback
       so a deploy is picked up immediately, but a cold subway ride still works.
     Open-Meteo requests                 never cached here
       api.js already caches the *aggregated* normals in localStorage, and live
       conditions must never be served stale — a cached "72°F" from yesterday is
       worse than an honest error.
*/
const CACHE = 'weather-v1';
const SHELL = [
  './', './index.html', './manifest.json', './icon.svg',
  './js/config.js', './js/solar.js', './js/api.js',
  './js/climate.js', './js/charts.js', './js/app.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
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
    fetch(e.request)
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
