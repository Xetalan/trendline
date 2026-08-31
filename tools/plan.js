'use strict';

/* Dev-only: drives a lifting session through the runner and checks that the
   workout is logged and the numbers step up only when the target was met.
   Run: npm run plan */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pad = (n) => String(n).padStart(2, '0');
const d = new Date();
const T = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const DATA = {
  version: 1,
  settings: { startWeight: 250, startDate: T, goalWeight: 210, medication: '', theme: 'light' },
  days: { [T]: { weight: 247, steps: null, notes: '' } },
  activities: [],
};

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
  await new Promise((r) => setTimeout(r, 1300));
  const run = (js) => win.webContents.executeJavaScript(js);
  const settle = (ms) => new Promise((r) => setTimeout(r, ms || 300));

  const results = [];
  const check = (name, pass, detail) => results.push({ name, pass, detail });
  const watchdog = setTimeout(() => { console.log('TIMED OUT'); app.exit(1); }, 90000);

  try {
    // ---- the seeded programme ------------------------------------------
    const plan = await run('JSON.parse(JSON.stringify(DATA.plan))');
    check('a default plan is seeded', plan.templates.length === 4, `${plan.templates.length} templates`);
    check('lift Tue/Thu/Sat, run Mon/Wed/Fri, rest Sun',
      plan.week[2].type === 'lift' && plan.week[4].type === 'lift' && plan.week[6].type === 'lift'
      && plan.week[1].type === 'run' && plan.week[3].type === 'run' && plan.week[5].type === 'run'
      && plan.week[0].type === 'rest',
      JSON.stringify(Object.values(plan.week).map((x) => x.type)));

    const bench = plan.templates[0].exercises[0];
    check('bench is 3x10 at 100 a side, both arms, no bar',
      bench.sets === 3 && bench.reps === 10 && bench.weight === 100
      && !bench.base && bench.perSide,
      JSON.stringify(bench));

    // Every seeded weight must be loadable on the declared equipment.
    const unloadable = await run(`(() => {
      const out = [];
      DATA.plan.templates.forEach((t) => t.exercises.forEach((e) => {
        if (e.bands) return;
        if (!Loads.isLoadable(e.weight, DATA.settings.equipment, e.base, e.perSide)) out.push(e.name);
      }));
      return out; })()`);
    check('every seeded weight is loadable', unloadable.length === 0, unloadable.join(', '));

    // ---- run a session, hitting every target ----------------------------
    await run(`show('training'); showSubtab('training', 'plan');
      startSession('tpl-push'); true;`);
    await settle(400);
    check('session runner appears',
      await run(`!!document.querySelector('.session')`), 'no .session card');

    const setCount = await run(`document.querySelectorAll('.set-btn').length`);
    check('a button per programmed set', setCount === 9, `${setCount} buttons`);

    await run(`document.querySelectorAll('.set-btn').forEach((b) => b.click()); true;`);
    await settle(500);
    const allDone = await run(`document.querySelectorAll('.set-btn.done').length`);
    check('every set can be ticked off', allDone === 9, `${allDone} done`);

    await run(`document.getElementById('sessFinish').click(); true;`);
    await settle(600);

    let d2 = await run('JSON.parse(JSON.stringify(DATA))');
    const logged = d2.activities.find((a) => a.type === 'lift');
    check('the workout is logged as a lift', !!logged && logged.notes === 'Chest & Triceps',
      JSON.stringify(logged && { notes: logged.notes, ex: logged.exercises.length }));
    check('sets are stored as total load, not per side',
      logged.exercises[0].sets[0].weight === 200,
      JSON.stringify(logged.exercises[0].sets[0]));
    check('the session is cleared afterwards', !d2.session, JSON.stringify(d2.session));

    // ---- progression fired ---------------------------------------------
    const benchAfter = d2.plan.templates[0].exercises[0];
    check('hitting the target adds a rep',
      benchAfter.reps === 11 && benchAfter.weight === 100 && benchAfter.sets === 3,
      JSON.stringify(benchAfter));

    // ---- falling short must NOT advance ---------------------------------
    await run(`startSession('tpl-pull'); true;`);
    await settle(400);
    const before = await run('JSON.parse(JSON.stringify(DATA.plan.templates[1].exercises[0]))');
    // Tick only one of the three sets.
    await run(`document.querySelector('.set-btn').click(); true;`);
    await settle(300);
    await run(`document.getElementById('sessFinish').click(); true;`);
    await settle(600);
    const after = await run('JSON.parse(JSON.stringify(DATA.plan.templates[1].exercises[0]))');
    check('an incomplete exercise does not advance',
      JSON.stringify(before) === JSON.stringify(after),
      `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

    d2 = await run('JSON.parse(JSON.stringify(DATA))');
    check('a partial session is still logged', d2.activities.filter((a) => a.type === 'lift').length === 2,
      `${d2.activities.length} activities`);

    // ---- cancelling leaves everything alone ------------------------------
    const beforeCancel = await run('DATA.activities.length');
    await run(`startSession('tpl-shoulders'); true;`);
    await settle(300);
    await run(`document.getElementById('sessCancel').click(); true;`);
    await settle(400);
    check('cancelling logs nothing',
      (await run('DATA.activities.length')) === beforeCancel && !(await run('!!DATA.session')),
      'session or activity left behind');

    // ---- the week grid --------------------------------------------------
    const week = await run(`document.getElementById('planWeek').textContent.replace(/\\s+/g,' ')`);
    check('the week grid names each day', /Mon/.test(week) && /Sat/.test(week) && /Rest/.test(week),
      week.slice(0, 90));
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
