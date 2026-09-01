'use strict';
/* Dev-only: covers the Workouts report view and the History range bug where a
   workout dated outside the weigh-in window became invisible.
   In-memory data; never touches the real file. */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; };

// Anchor the fixture to this week's Monday so week bucketing is deterministic
// whatever day the suite happens to run on.
const TODAY = new Date();
const MONDAY = addDays(TODAY, -((TODAY.getDay() + 6) % 7));
const M = iso(MONDAY);
const T = iso(TODAY);
const OLD = iso(addDays(MONDAY, -14));    // before the start date, but still real training
const FUTURE = iso(addDays(MONDAY, 120)); // a mistyped date

const DATA = {
  version: 1,
  settings: { startWeight: 250, startDate: M, goalWeight: null, medication: '', theme: 'light' },
  days: { [M]: { weight: 250, steps: null, notes: 'baseline' }, [T]: { weight: 247, steps: null, notes: '' } },
  activities: [
    // The reported case: a hike dated before the first weigh-in.
    { id: 'old-hike', date: OLD, type: 'hike', minutes: 120, distance: 4.5, label: '', notes: 'trail', exercises: [] },
    // Dated well into the future - a typo, and the only thing that should now
    // fall outside the tracked weeks.
    // Deliberately different numbers from the duplicate pair below, so that
    // correcting its date does not turn it into a third duplicate.
    { id: 'future-run', date: FUTURE, type: 'run', minutes: 25, distance: 2.5, label: '', notes: '', exercises: [] },
    // Same session entered twice.
    { id: 'dup-a', date: T, type: 'run', minutes: 30, distance: 3, label: '', notes: '', exercises: [] },
    { id: 'dup-b', date: T, type: 'run', minutes: 30, distance: 3, label: '', notes: '', exercises: [] },
    { id: 'lift-1', date: T, type: 'lift', minutes: 45, distance: 0, label: '', notes: '', exercises: [
      { name: 'Bench press', sets: [{ reps: 10, weight: 95 }, { reps: 8, weight: 105 }] },
    ] },
  ],
};

app.whenReady().then(async () => {
  ipcMain.handle('data:load', () => DATA);
  ipcMain.handle('data:save', () => true);
  ipcMain.handle('data:backup', () => true);
  ipcMain.handle('data:reveal', () => true);
  ipcMain.handle('file:export', () => ({ ok: false }));

  const win = new BrowserWindow({
    width: 1320, height: 900, show: false,
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
  const settle = () => new Promise((r) => setTimeout(r, 220));

  const results = [];
  const check = (name, pass, detail) => results.push({ name, pass, detail });

  // A rejected executeJavaScript would otherwise leave the window open and the
  // suite hanging with no output, so bound the run and report what we have.
  const watchdog = setTimeout(() => {
    console.log('HARNESS TIMED OUT after', results.length, 'checks');
    app.exit(1);
  }, 90000);

  try {
  // ---- the reported bug -------------------------------------------------
  const histText = await run(`show('history');
    document.getElementById('historyTable').textContent.replace(/\\s+/g,' ')`);
  check('REGRESSION: workout before the first weigh-in appears in History',
    histText.includes('Hike'), `history covers ${histText.slice(0, 90)}`);

  const rangeFirst = await run('dataRange().first');
  check('data range reaches back to the earliest workout', rangeFirst === OLD,
    `${rangeFirst} vs ${OLD}`);

  // The weight chart itself should still be anchored to weigh-ins, not dragged
  // back two weeks by a stray workout.
  const weightSeriesStart = await run('dailySeries()[0].date');
  check('weight chart still starts at the first weigh-in', weightSeriesStart === M,
    `${weightSeriesStart} vs ${M}`);

  // ---- workouts view ----------------------------------------------------
  const rowCount = await run(`show('workouts'); workoutFilter='all'; openEditor=null; renderWorkouts();
    document.querySelectorAll('#workoutTable .w-row').length`);
  check('workouts view lists every session', rowCount === 5, `rows=${rowCount}`);

  const flagText = await run(`document.getElementById('workoutFlags').textContent.replace(/\\s+/g,' ')`);
  check('duplicate entries are flagged', /look like duplicates/.test(flagText), flagText.slice(0, 100));
  check('a future-dated workout is flagged', /outside your tracked weeks/.test(flagText), flagText.slice(0, 160));

  // Training done before the medication started is still training.
  const counted = await run(`(() => {
    const w = weeklyActivity().find((x) => x.start <= ${JSON.stringify(OLD)} && x.end >= ${JSON.stringify(OLD)});
    return w ? { start: w.start, hikeMi: w.hikeMi } : null; })()`);
  check('a pre-start workout lands in a real week', counted && counted.hikeMi === 4.5,
    JSON.stringify(counted));
  check('and weeks before the start date are named by date, not numbered',
    /Week of/.test(await run(`weekLabel(weeklyActivity()[0])`)),
    await run(`weekLabel(weeklyActivity()[0])`));

  const tagged = await run(`document.querySelectorAll('#workoutTable .chip.warn').length`);
  check('rows carry duplicate / out-of-range tags', tagged >= 3, `tags=${tagged}`);

  // ---- type filter ------------------------------------------------------
  const runRows = await run(`workoutFilter='run'; openEditor=null; renderWorkouts();
    document.querySelectorAll('#workoutTable .w-row').length`);
  check('filter narrows to one type', runRows === 3, `run rows=${runRows}`);

  const hikeTiles = await run(`workoutFilter='hike'; openEditor=null; renderWorkouts();
    document.getElementById('workoutTiles').textContent.replace(/\\s+/g,' ')`);
  check('per-type stats compute', /4\.50/.test(hikeTiles) && /2h 0m/.test(hikeTiles), hikeTiles.slice(0, 130));

  // ---- editing a workout ------------------------------------------------
  await run(`workoutFilter='all'; openEditor='old-hike'; renderWorkouts(); true;`);
  await settle();
  const seeded = await run(`({
    dist: document.querySelector('#workoutTable .e-dist').value,
    min:  document.querySelector('#workoutTable .e-min').value,
    speed: document.querySelector('#workoutTable .e-speed').value })`);
  check('editor seeds distance, duration and derived speed',
    seeded.dist === '4.5' && seeded.min === '120' && seeded.speed === '2.3', JSON.stringify(seeded));

  // Each snippet is its own scope - executeJavaScript shares one global, so a
  // bare `const` would collide with the next call.
  await run(`(() => { const w = document.querySelector('#workoutTable .w-edit');
    w.querySelector('.e-date').value = ${JSON.stringify(T)};
    w.querySelector('.e-dist').value = '5.25';
    w.querySelector('.e-dist').dispatchEvent(new Event('input'));
    w.querySelector('.e-notes').value = 'corrected date';
    w.querySelector('.e-save').click(); return true; })()`);
  await settle();
  let d = await run('JSON.parse(JSON.stringify(DATA.activities))');
  const hike = d.find((a) => a.id === 'old-hike');
  check('edit saves date, distance and notes',
    hike.date === T && hike.distance === 5.25 && hike.notes === 'corrected date', JSON.stringify(hike));

  // The mistyped future date is the one still flagged; correcting it clears it.
  await run(`openEditor='future-run'; renderWorkouts(); true;`);
  await settle();
  await run(`(() => { const w = document.querySelector('#workoutTable .w-edit');
    w.querySelector('.e-date').value = ${JSON.stringify(T)};
    w.querySelector('.e-save').click(); return true; })()`);
  await settle();
  const flagsAfter = await run(`renderWorkouts();
    document.getElementById('workoutFlags').textContent.replace(/\\s+/g,' ')`);
  check('fixing a mistyped date clears the out-of-range flag',
    !/outside your tracked weeks/.test(flagsAfter), flagsAfter.slice(0, 120));

  // ---- editing a lift ---------------------------------------------------
  await run(`openEditor='lift-1'; renderWorkouts(); true;`);
  await settle();
  const volText = await run(`document.querySelector('#workoutTable .e-vol').textContent`);
  check('lift editor shows existing volume', volText === '1,790 lbs', volText);

  await run(`(() => { const w = document.querySelector('#workoutTable .w-edit');
    const chip = w.querySelectorAll('.set-chip')[1];
    chip.querySelector('.s-weight').value = '115';
    chip.querySelector('.s-weight').dispatchEvent(new Event('input'));
    w.querySelector('.e-save').click(); return true; })()`);
  await settle();
  d = await run('JSON.parse(JSON.stringify(DATA.activities))');
  const lift = d.find((a) => a.id === 'lift-1');
  check('lift edit preserves and updates sets',
    lift.exercises[0].sets.length === 2 && lift.exercises[0].sets[1].weight === 115,
    JSON.stringify(lift.exercises));

  // ---- deleting a duplicate --------------------------------------------
  const before = d.length;
  await run(`openEditor='dup-b'; renderWorkouts(); true;`);
  await settle();
  await run(`document.querySelector('#workoutTable .e-delete').click(); true;`);
  await settle();
  d = await run('JSON.parse(JSON.stringify(DATA.activities))');
  check('deleting a duplicate removes exactly one',
    d.length === before - 1 && !d.some((a) => a.id === 'dup-b'), `${before} -> ${d.length}`);

  const flagsFinal = await run(`renderWorkouts();
    document.getElementById('workoutFlags').textContent.replace(/\\s+/g,' ')`);
  check('duplicate flag clears once the copy is gone',
    !/look like duplicates/.test(flagsFinal), flagsFinal.slice(0, 120) || '(no flags)');

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
