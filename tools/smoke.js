'use strict';
/* Dev-only: drives the real UI through its save paths and asserts the data
   model actually changed. Uses in-memory data; never touches the real file. */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const today = new Date();
const pad = (n) => String(n).padStart(2, '0');
const TODAY = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

const DATA = {
  version: 1,
  settings: { startWeight: 250, startDate: '2026-01-05', goalWeight: null, medication: '', theme: 'light' },
  days: { '2026-01-05': { weight: 250, steps: null, notes: 'baseline' } },
  activities: [],
};

let saved = 0;

app.whenReady().then(async () => {
  ipcMain.handle('data:load', () => DATA);
  ipcMain.handle('data:save', () => { saved++; return true; });
  ipcMain.handle('data:backup', () => true);
  ipcMain.handle('data:reveal', () => true);
  ipcMain.handle('file:export', () => ({ ok: false }));

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
  const results = [];
  const check = (name, pass, detail) => results.push({ name, pass, detail });

  // 1. Quick weigh-in from the dashboard.
  await run(`document.getElementById('quickWeight').value='287.4';
             document.getElementById('quickSave').click(); true;`);
  await new Promise((r) => setTimeout(r, 200));
  let d = await run('JSON.parse(JSON.stringify(DATA))');
  check('quick weigh-in stored', d.days[TODAY] && d.days[TODAY].weight === 287.4,
    JSON.stringify(d.days[TODAY]));

  // 2. Cardio workout with pace.
  await run(`show('log'); setType('run');
             document.getElementById('aDist').value='3.1';
             document.getElementById('aMin').value='31';
             document.getElementById('aDist').dispatchEvent(new Event('input'));
             document.getElementById('aSave').click(); true;`);
  await new Promise((r) => setTimeout(r, 200));
  d = await run('JSON.parse(JSON.stringify(DATA))');
  const run1 = d.activities.find((a) => a.type === 'run');
  check('run stored', !!run1 && run1.distance === 3.1 && run1.minutes === 31, JSON.stringify(run1));
  const pace = await run(`document.getElementById('aPace').value`);
  check('pace cleared after save', pace === '', `pace="${pace}"`);

  // 3. Lifting session with sets -> tonnage.
  await run(`setType('lift');
    const b = document.querySelector('#exerciseList .exercise');
    b.querySelector('.ex-name').value = 'Bench press';
    const chips = b.querySelectorAll('.set-chip');
    chips[0].querySelector('.s-reps').value='10'; chips[0].querySelector('.s-weight').value='95';
    chips[1].querySelector('.s-reps').value='8';  chips[1].querySelector('.s-weight').value='105';
    chips[0].querySelector('.s-reps').dispatchEvent(new Event('input'));
    document.getElementById('aLiftMin').value='40';
    document.getElementById('aSave').click(); true;`);
  await new Promise((r) => setTimeout(r, 200));
  d = await run('JSON.parse(JSON.stringify(DATA))');
  const lift = d.activities.find((a) => a.type === 'lift');
  const tons = lift ? lift.exercises[0].sets.reduce((s, x) => s + x.reps * x.weight, 0) : 0;
  check('lift stored with sets', !!lift && lift.exercises[0].name === 'Bench press' && tons === 1790,
    `tonnage=${tons} ${JSON.stringify(lift && lift.exercises)}`);

  // 3b. Hike is a first-class type.
  await run(`show('log'); setType('hike');
    const dEl = document.getElementById('aDist'), mEl = document.getElementById('aMin');
    dEl.value='4.2'; dEl.dispatchEvent(new Event('input'));
    mEl.value='95';  mEl.dispatchEvent(new Event('input'));
    document.getElementById('aSave').click(); true;`);
  await new Promise((r) => setTimeout(r, 200));
  d = await run('JSON.parse(JSON.stringify(DATA))');
  const hike = d.activities.find((a) => a.type === 'hike');
  check('hike stored', !!hike && hike.distance === 4.2 && hike.minutes === 95, JSON.stringify(hike));

  // 3c. Running distance totals behind the dashboard card.
  const totals = await run('JSON.parse(JSON.stringify(distanceTotals()))');
  check('distance totals cover run + walk + hike',
    totals.run === 3.1 && totals.walk === 0 && totals.hike === 4.2 &&
    Math.abs(totals.total - 7.3) < 1e-9, JSON.stringify(totals));

  // Lifting has no distance and must not leak into the mileage total.
  check('lifting excluded from distance', totals.total === totals.run + totals.walk + totals.hike,
    JSON.stringify(totals));

  const card = await run(`show('dashboard');
    document.getElementById('distanceCard').textContent.replace(/\\s+/g,' ').trim()`);
  check('dashboard shows running distance card',
    /Distance covered/.test(card) && /Hike/.test(card) && /4\.20/.test(card) && /7\.30/.test(card),
    card.slice(0, 140));

  // 4. Strength table picked it up.
  const strength = await run(`document.getElementById('strengthTable').textContent`);
  check('strength table lists exercise', /Bench press/.test(strength), strength.slice(0, 80));

  // 5. Inline history edit.
  await run(`show('history');
    const inp = document.querySelector('[data-weight-date="${TODAY}"]');
    inp.value='286.2'; inp.dispatchEvent(new Event('change', {bubbles:true})); true;`);
  await new Promise((r) => setTimeout(r, 200));
  d = await run('JSON.parse(JSON.stringify(DATA))');
  check('history inline edit', d.days[TODAY].weight === 286.2, `weight=${d.days[TODAY].weight}`);

  // 6. Deleting a workout.
  const before = d.activities.length;
  await run(`show('workouts'); workoutFilter='all'; openEditor=null; renderWorkouts();
    document.querySelector('#workoutTable .w-row').click(); true;`);
  await new Promise((r) => setTimeout(r, 250));
  await run(`document.querySelector('#workoutTable .e-delete').click(); true;`);
  await new Promise((r) => setTimeout(r, 250));
  d = await run('JSON.parse(JSON.stringify(DATA))');
  check('workout deleted', d.activities.length === before - 1, `${before} -> ${d.activities.length}`);

  // 7. CSV export shape.
  const csv = await run('daysCsv()');
  check('CSV has header + weekly block',
    csv.startsWith('Date,Day,Week,') && csv.includes('Change vs prior'), csv.split('\r\n')[0]);

  // 8. Theme round-trips through the data file, not localStorage.
  await run(`document.getElementById('themeToggle').click(); true;`);
  d = await run('JSON.parse(JSON.stringify(DATA))');
  check('theme persisted to data', d.settings.theme === 'dark', `theme=${d.settings.theme}`);

  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : '  -> ' + r.detail}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed · ${saved} saves issued`);
  if (errors.length) { console.log('CONSOLE ERRORS:'); errors.forEach((e) => console.log('  ' + e)); }
  app.exit(failed ? 1 : 0);
});
