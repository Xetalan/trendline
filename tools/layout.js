'use strict';

/* Dev-only: checks every view for horizontal overflow at the widths that
   matter — the Fold's cover screen, its inner screen, and desktop.
   Nothing may extend past the viewport. Run: npm run layout */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; };

const TODAY = new Date();
const T = iso(TODAY);

// Enough data that tables and charts are actually populated.
const days = {};
const activities = [];
for (let i = 30; i >= 0; i--) {
  const d = iso(addDays(TODAY, -i));
  days[d] = { weight: +(250 - (30 - i) * 0.4).toFixed(1), steps: 8000 + i * 37, notes: '',
    food: i % 3 === 0 ? [{ id: `f${i}`, text: 'Chicken bowl with rice and extra vegetables' }] : undefined };
  if (i % 2 === 0) {
    activities.push({ id: `r${i}`, date: d, type: 'run', minutes: 32, distance: 3.1,
      label: '', notes: 'Treadmill, steady effort', exercises: [] });
  }
  if (i % 5 === 0) {
    activities.push({ id: `l${i}`, date: d, type: 'lift', minutes: 45, distance: 0, label: '', notes: '',
      exercises: [{ name: 'Bench press', sets: [{ reps: 10, weight: 95 }, { reps: 8, weight: 105 }] }] });
  }
  if (i % 7 === 0) {
    activities.push({ id: `h${i}`, date: d, type: 'hike', minutes: 120, distance: 4.4,
      label: '', notes: '', exercises: [] });
  }
}

const DATA = {
  version: 1,
  settings: { startWeight: 250, startDate: iso(addDays(TODAY, -30)), goalWeight: 210,
    medication: 'GLP-1', theme: 'light' },
  days, activities,
};

// Cover screen, inner screen (portrait and landscape), and desktop.
const WIDTHS = [
  { w: 412, h: 915, name: 'folded (cover)' },
  { w: 673, h: 841, name: 'unfolded narrow' },
  { w: 880, h: 900, name: 'unfolded (inner)' },
  { w: 1024, h: 800, name: 'unfolded landscape' },
  { w: 1320, h: 900, name: 'desktop' },
];

const VIEWS = ['dashboard', 'log', 'training', 'history', 'settings'];

app.whenReady().then(async () => {
  ipcMain.handle('data:load', () => DATA);
  ipcMain.handle('data:save', () => true);
  ipcMain.handle('data:backup', () => true);
  ipcMain.handle('data:reveal', () => true);
  ipcMain.handle('file:export', () => ({ ok: false }));
  ipcMain.handle('oura:hasToken', () => false);
  ipcMain.handle('oura:setToken', () => true);
  ipcMain.handle('oura:sync', () => ({ ok: false, error: 'stub' }));

  const win = new BrowserWindow({
    width: 1320, height: 900, show: false, useContentSize: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  win.showInactive();

  const errors = [];
  win.webContents.on('console-message', (e, level, message) =>
    { if ((level ?? e.level) >= 2) errors.push(message ?? e.message); });

  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await new Promise((r) => setTimeout(r, 1400));
  const run = (js) => win.webContents.executeJavaScript(js);

  const results = [];
  const watchdog = setTimeout(() => { console.log('TIMED OUT'); app.exit(1); }, 120000);

  try {
    await win.webContents.insertCSS('.view.active{animation:none!important}');

    for (const size of WIDTHS) {
      win.setContentSize(size.w, size.h);
      await new Promise((r) => setTimeout(r, 450));

      for (const view of VIEWS) {
        await run(`show('${view}'); true;`);
        await new Promise((r) => setTimeout(r, 320));

        const probe = await run(`(() => {
          const vw = document.documentElement.clientWidth;
          const over = [];
          // Content wider than its box is fine when an ancestor scrolls it -
          // that is a table you can swipe, not a broken layout.
          const scrolls = (el) => {
            for (let p = el.parentElement; p; p = p.parentElement) {
              const ox = getComputedStyle(p).overflowX;
              if (ox === 'auto' || ox === 'scroll') return true;
              if (p.classList.contains('view')) return false;
            }
            return false;
          };
          document.querySelectorAll('#view-' + ${JSON.stringify(view)} + ' *').forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.right > vw + 1 && !scrolls(el)) {
              over.push((el.tagName + '.' + (el.className || '')).slice(0, 46)
                        + ' @' + Math.round(r.right));
            }
          });
          return {
            vw,
            docScroll: document.documentElement.scrollWidth,
            bodyScroll: document.body.scrollWidth,
            mainScroll: document.querySelector('.main').scrollWidth,
            mainClient: document.querySelector('.main').clientWidth,
            over: over.slice(0, 4),
          }; })()`);

        const bleeds = probe.docScroll > probe.vw + 1
          || probe.mainScroll > probe.mainClient + 1
          || probe.over.length > 0;
        results.push({ size, view, probe, bleeds });
      }
    }
  } catch (err) {
    console.log('HARNESS ERROR:', err.message || err);
  }
  clearTimeout(watchdog);

  let bad = 0;
  for (const size of WIDTHS) {
    const rows = results.filter((r) => r.size.name === size.name);
    const broken = rows.filter((r) => r.bleeds);
    if (!broken.length) {
      console.log(`PASS  ${size.w}px ${size.name} — all ${rows.length} views fit`);
    } else {
      bad += broken.length;
      console.log(`FAIL  ${size.w}px ${size.name} — ${broken.length} view(s) overflow:`);
      broken.forEach((r) => {
        console.log(`        ${r.view}: doc ${r.probe.docScroll} vs vw ${r.probe.vw}, `
          + `main ${r.probe.mainScroll} vs ${r.probe.mainClient}`);
        r.probe.over.forEach((o) => console.log(`          ${o}`));
      });
    }
  }
  console.log(`\n${results.length - bad}/${results.length} view/width combinations fit`);
  if (errors.length) { console.log('CONSOLE ERRORS:'); errors.forEach((e) => console.log('  ' + e)); }
  app.exit(bad ? 1 : 0);
});
