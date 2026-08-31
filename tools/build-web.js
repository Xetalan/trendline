'use strict';

/* Builds the installable PWA into docs/ from the same src/ the desktop app
   uses, so the two never drift. Run: npm run build:web */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

// --mobile emits the Capacitor payload instead of the GitHub Pages site. The
// difference is the CSP (native HTTP needs Oura allowed) and no service
// worker, since the assets already ship inside the package.
const MOBILE = process.argv.includes('--mobile');
const OUT = path.join(ROOT, MOBILE ? 'mobile/www' : 'docs');

const VERSION = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

fs.mkdirSync(path.join(OUT, 'vendor'), { recursive: true });

// ---- shared assets, copied verbatim ---------------------------------------
for (const rel of ['styles.css', 'app.js', 'platform-web.js', 'vendor/chart.umd.js']) {
  fs.copyFileSync(path.join(SRC, rel), path.join(OUT, rel));
}
// Shared with the Electron main process - one mapping, both platforms.
for (const f of ['oura-map.js', 'loads.js', 'programme.js']) {
  fs.copyFileSync(path.join(ROOT, 'lib', f), path.join(OUT, f));
}
// Icons: the launcher uses native resources on Android, but the manifest and
// apple-touch-icon links reference these in both builds.
for (const icon of ['icon-192.png', 'icon-512.png', 'icon-maskable.png']) {
  const from = path.join(ROOT, 'docs', icon);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(OUT, icon));
}

// ---- index.html, rewired for the browser ----------------------------------
let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');

// The Electron CSP forbids the connections a PWA needs for its manifest and
// service worker, and there is no preload script to supply window.api.
html = html.replace(
  /<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
  '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; '
  + 'script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; '
  + `connect-src 'self'${MOBILE ? ' https://api.ouraring.com' : ''}; `
  + 'manifest-src \'self\'; worker-src \'self\'; base-uri \'none\'; '
  + 'form-action \'none\'; object-src \'none\'" />\n'
  + '  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />\n'
  + '  <meta name="theme-color" content="#2a78d6" />\n'
  + '  <meta name="mobile-web-app-capable" content="yes" />\n'
  + '  <meta name="apple-mobile-web-app-status-bar-style" content="default" />\n'
  + '  <link rel="manifest" href="./manifest.webmanifest" />\n'
  + '  <link rel="apple-touch-icon" href="./icon-192.png" />');

// window.api must exist before app.js runs.
// oura-map defines window.OuraMap, which platform-web reads; both must be in
// place before app.js runs.
// Flatten the shared library paths for the web bundle.
html = html.replace('../lib/loads.js', 'loads.js').replace('../lib/programme.js', 'programme.js');

html = html.replace(
  '<script src="vendor/chart.umd.js"></script>',
  '<script src="oura-map.js"></script>\n'
  + '<script src="platform-web.js"></script>\n'
  + '<script src="vendor/chart.umd.js"></script>');

fs.writeFileSync(path.join(OUT, 'index.html'), html, 'utf8');

// ---- OAuth callback page (hosted build only; it is a redirect target) ------
if (!MOBILE) {
  for (const f of ['oauth.html', 'oauth.js']) {
    fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));
  }
}

// ---- manifest -------------------------------------------------------------
fs.writeFileSync(path.join(OUT, 'manifest.webmanifest'), JSON.stringify({
  name: 'Trendline',
  short_name: 'Trendline',
  description: 'Weight and training tracker',
  start_url: './',
  scope: './',
  display: 'standalone',
  orientation: 'any',
  background_color: '#f9f9f7',
  theme_color: '#2a78d6',
  icons: [
    { src: './icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: './icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: './icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}, null, 2), 'utf8');

// ---- service worker (web only) --------------------------------------------
if (!MOBILE) {
// Cache-first over a versioned cache: the app must open with no signal, and a
// rebuild changes the version so stale shells are dropped on activate.
fs.writeFileSync(path.join(OUT, 'sw.js'), `'use strict';
const CACHE = 'trendline-${VERSION}';
const ASSETS = [
  './', './index.html', './styles.css', './app.js', './platform-web.js',
  './oura-map.js', './loads.js', './programme.js', './vendor/chart.umd.js', './manifest.webmanifest',
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
`, 'utf8');

  // GitHub Pages would otherwise run the output through Jekyll.
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '', 'utf8');
}

console.log('built', MOBILE ? 'mobile/www' : 'docs/', '·', VERSION);
console.log('files:', fs.readdirSync(OUT).join(', '));
