'use strict';
const CACHE = 'trendline-20260831194000';
const ASSETS = [
  './', './index.html', './styles.css', './app.js', './platform-web.js',
  './oura-map.js', './lib-loads.js', './lib-programme.js', './vendor/chart.umd.js', './manifest.webmanifest',
  './oauth.html', './oauth.js',
  './icon-192.png', './icon-512.png', './icon-maskable.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(ASSETS))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      // Only a navigation deserves the shell as a fallback; a failed asset
      // request should fail honestly rather than resolve to an HTML page.
      .catch(() => (e.request.mode === 'navigate'
        ? caches.match('./index.html')
        : Response.error()))));
});
