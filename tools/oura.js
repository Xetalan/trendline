'use strict';

/* Dev-only: verifies the Oura import against a stubbed API — activity-name
   mapping, metres-to-miles, dedup on re-sync, and the rule that hand-entered
   treadmill distances are never overwritten. No token, no network.
   Run: npm run oura */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const T = iso(new Date());

const DATA = {
  version: 1,
  settings: { startWeight: 250, startDate: T, goalWeight: null, medication: '', theme: 'light' },
  days: { [T]: { weight: 247, steps: null, notes: '' } },
  activities: [],
};

// Shapes mirror the real v2 payloads: distance in metres, ISO datetimes.
const WORKOUTS = [
  { id: 'w-run', day: T, activity: 'running', start_datetime: `${T}T07:00:00+00:00`,
    end_datetime: `${T}T07:32:00+00:00`, distance: 5150.2, intensity: 'moderate', calories: 300 },
  { id: 'w-tread', day: T, activity: 'treadmill', start_datetime: `${T}T18:00:00+00:00`,
    end_datetime: `${T}T18:40:00+00:00`, distance: null, intensity: 'easy', calories: 220 },
  { id: 'w-hike', day: T, activity: 'hiking', start_datetime: `${T}T09:00:00+00:00`,
    end_datetime: `${T}T11:30:00+00:00`, distance: 8046.72, intensity: 'moderate' },
  { id: 'w-lift', day: T, activity: 'weightlifting', start_datetime: `${T}T12:00:00+00:00`,
    end_datetime: `${T}T12:45:00+00:00`, distance: 0, intensity: 'hard' },
  { id: 'w-odd', day: T, activity: 'cross_country_skiing', start_datetime: `${T}T13:00:00+00:00`,
    end_datetime: `${T}T13:25:00+00:00`, distance: 0 },
];

app.whenReady().then(async () => {
  ipcMain.handle('data:load', () => DATA);
  ipcMain.handle('data:save', () => true);
  ipcMain.handle('data:backup', () => true);
  ipcMain.handle('data:reveal', () => true);
  ipcMain.handle('file:export', () => ({ ok: false }));
  ipcMain.handle('oura:hasToken', () => true);
  ipcMain.handle('oura:setToken', () => true);

  // Reuse the real mapper from main.js rather than reimplementing it here.
  const { mapWorkout } = require(path.join(ROOT, 'lib', 'oura-map'));
  ipcMain.handle('oura:sync', () => ({
    ok: true,
    steps: [{ date: T, steps: 11480 }],
    workouts: WORKOUTS.map(mapWorkout),
  }));

  const win = new BrowserWindow({
    width: 1280, height: 900, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (e, level, message) =>
    { if ((level ?? e.level) >= 2) errors.push(message ?? e.message); });

  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));
  const run = (js) => win.webContents.executeJavaScript(js);
  const settle = (ms) => new Promise((r) => setTimeout(r, ms || 400));

  const results = [];
  const check = (name, pass, detail) => results.push({ name, pass, detail });
  const watchdog = setTimeout(() => { console.log('TIMED OUT'); app.exit(1); }, 60000);

  try {
    await run('syncOura(30)');
    await settle(600);
    let d = await run('JSON.parse(JSON.stringify(DATA))');

    check('steps land on the day', d.days[T].steps === 11480, JSON.stringify(d.days[T]));
    check('imported one workout per Oura session', d.activities.length === 5,
      `count=${d.activities.length}`);

    const byId = Object.fromEntries(d.activities.map((a) => [a.sourceId, a]));
    check('running maps to run, metres to miles',
      byId['w-run'].type === 'run' && byId['w-run'].distance === 3.2 && byId['w-run'].minutes === 32,
      JSON.stringify(byId['w-run']));
    check('treadmill maps to run with no distance',
      byId['w-tread'].type === 'run' && byId['w-tread'].distance === 0 && byId['w-tread'].minutes === 40,
      JSON.stringify(byId['w-tread']));
    check('hiking maps to hike', byId['w-hike'].type === 'hike' && byId['w-hike'].distance === 5,
      JSON.stringify(byId['w-hike']));
    check('weightlifting maps to lift', byId['w-lift'].type === 'lift' && byId['w-lift'].minutes === 45,
      JSON.stringify(byId['w-lift']));
    check('unknown activity falls back to other, keeping its name',
      byId['w-odd'].type === 'other' && byId['w-odd'].label === 'cross country skiing',
      JSON.stringify(byId['w-odd']));

    // Type in a treadmill distance the ring could not know, then re-sync.
    await run(`(() => {
      const a = DATA.activities.find(x => x.sourceId === 'w-tread');
      a.distance = 2.4; a.minutes = 40; return true; })()`);
    await run('syncOura(30)');
    await settle(600);
    d = await run('JSON.parse(JSON.stringify(DATA))');

    check('re-syncing does not duplicate', d.activities.length === 5,
      `count=${d.activities.length}`);
    check('hand-entered treadmill distance survives a re-sync',
      d.activities.find((a) => a.sourceId === 'w-tread').distance === 2.4,
      JSON.stringify(d.activities.find((a) => a.sourceId === 'w-tread')));

    const totals = await run('JSON.parse(JSON.stringify(distanceTotals()))');
    check('imported distances reach the dashboard totals',
      Math.abs(totals.run - 5.6) < 1e-9 && totals.hike === 5, JSON.stringify(totals));
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
  app.exit(failed ? 1 : 0);
});
