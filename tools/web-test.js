'use strict';

/* Dev-only: serves web/ over localhost (a secure context, so service workers
   and IndexedDB behave as they will on the phone) and drives the PWA at a
   Pixel-sized viewport. Run: npm run test:web */

const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'docs');
const SHOTS = path.join(ROOT, 'shots');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let rel = decodeURIComponent(req.url.split('?')[0]);
      if (rel === '/') rel = '/index.html';
      const file = path.join(WEB, path.normalize(rel).replace(/^[\\/]+/, ''));
      if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

app.whenReady().then(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  fs.mkdirSync(SHOTS, { recursive: true });

  // Pixel Fold cover screen, roughly.
  const win = new BrowserWindow({
    width: 412, height: 915, show: false, useContentSize: true,
  });
  win.showInactive();

  const errors = [];
  win.webContents.on('console-message', (e, level, message) =>
    { if ((level ?? e.level) >= 2) errors.push(message ?? e.message); });

  const results = [];
  const check = (name, pass, detail) => results.push({ name, pass, detail });
  const run = (js) => win.webContents.executeJavaScript(js);
  const settle = (ms) => new Promise((r) => setTimeout(r, ms || 300));

  const watchdog = setTimeout(() => {
    console.log('HARNESS TIMED OUT after', results.length, 'checks');
    app.exit(1);
  }, 90000);

  try {
    await win.loadURL(base);
    await settle(1500);

    // ---- platform wiring ------------------------------------------------
    check('web platform adapter is active',
      (await run('window.api.platform')) === 'web', 'platform');

    const startsEmpty = await run('({ days: Object.keys(DATA.days).length, '
      + 'acts: DATA.activities.length, start: DATA.settings.startWeight })');
    check('fresh install starts empty - no seeded personal data',
      startsEmpty.days === 0 && startsEmpty.acts === 0 && startsEmpty.start === null,
      JSON.stringify(startsEmpty));

    // ---- manifest + icons are reachable ---------------------------------
    const manifest = await run(`fetch('./manifest.webmanifest').then(r => r.json())`);
    check('manifest is served and valid',
      manifest.name === 'Trendline' && manifest.display === 'standalone'
      && manifest.icons.length === 3, JSON.stringify(manifest.icons.map((i) => i.sizes)));

    const iconOk = await run(`fetch('./icon-512.png').then(r => r.ok && r.headers.get('content-type'))`);
    check('icons are served as PNG', iconOk === 'image/png', String(iconOk));

    const swReady = await run(`navigator.serviceWorker.ready.then(r => !!r.active).catch(e => 'ERR:' + e.message)`);
    check('service worker registers and activates', swReady === true, String(swReady));

    // ---- auto baseline --------------------------------------------------
    await run(`document.getElementById('quickWeight').value = '247';
      document.getElementById('quickSave').click(); true;`);
    await settle();
    const baseline = await run('({ start: DATA.settings.startWeight, date: DATA.settings.startDate })');
    check('first weigh-in becomes the baseline', baseline.start === 247, JSON.stringify(baseline));

    // ---- persistence across a reload (IndexedDB, not memory) ------------
    await settle(500);
    await win.webContents.reload();
    await settle(1600);
    const afterReload = await run('({ start: DATA.settings.startWeight, days: Object.keys(DATA.days).length })');
    check('data survives a reload via IndexedDB',
      afterReload.start === 247 && afterReload.days === 1, JSON.stringify(afterReload));

    // ---- restoring a backup from the desktop app ------------------------
    const backup = JSON.stringify({
      version: 1,
      settings: { startWeight: 250, startDate: '2026-01-05', goalWeight: 210, medication: 'GLP-1', theme: 'auto' },
      days: { '2026-01-05': { weight: 250, steps: null, notes: 'baseline' },
              '2026-01-09': { weight: 247, steps: 9000, notes: '' } },
      activities: [{ id: 'x1', date: '2026-01-09', type: 'hike', minutes: 90, distance: 3.5,
                     label: '', notes: '', exercises: [] }],
    });
    await run(`(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([${JSON.stringify(backup)}], 'backup.json', { type: 'application/json' }));
      const input = document.getElementById('importFile');
      input.files = dt.files;
      window.confirm = () => true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true; })()`);
    await settle(700);
    const restored = await run('({ start: DATA.settings.startWeight, days: Object.keys(DATA.days).length, '
      + 'acts: DATA.activities.length, goal: DATA.settings.goalWeight })');
    check('restore brings over settings, days and workouts',
      restored.start === 250 && restored.days === 2 && restored.acts === 1 && restored.goal === 210,
      JSON.stringify(restored));

    await win.webContents.reload();
    await settle(1600);
    const persisted = await run('({ acts: DATA.activities.length, start: DATA.settings.startWeight })');
    check('restored data persists too', persisted.acts === 1 && persisted.start === 250,
      JSON.stringify(persisted));

    // ---- phone layout ---------------------------------------------------
    const layout = await run(`(() => {
      const bar = document.querySelector('.sidebar').getBoundingClientRect();
      const main = document.querySelector('.main').getBoundingClientRect();
      return { barTop: Math.round(bar.top), barW: Math.round(bar.width),
               mainW: Math.round(main.width), vw: window.innerWidth,
               bodyScrollW: document.body.scrollWidth }; })()`);
    check('nav sits at the bottom, full width', layout.barTop > 500 && layout.barW === layout.vw,
      JSON.stringify(layout));
    check('main content uses the full width', layout.mainW === layout.vw, JSON.stringify(layout));
    check('page does not scroll sideways', layout.bodyScrollW <= layout.vw + 1,
      `scrollW=${layout.bodyScrollW} vw=${layout.vw}`);

    for (const view of ['dashboard', 'log', 'workouts']) {
      await run(`show('${view}'); true;`);
      await settle(600);
      fs.writeFileSync(path.join(SHOTS, `phone-${view}.png`),
        (await win.webContents.capturePage()).toPNG());
    }
    console.log('wrote phone screenshots to shots/');
  } catch (err) {
    check('harness ran to completion', false, String((err && err.message) || err));
  }
  clearTimeout(watchdog);

  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : '  -> ' + r.detail}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (errors.length) { console.log('CONSOLE ERRORS:'); errors.forEach((e) => console.log('  ' + e)); }
  server.close();
  app.exit(failed ? 1 : 0);
});
