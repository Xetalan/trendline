'use strict';

/* Dev-only: checks the Couch-to-10K programme data and drives a real session
   through the runner on a fast-forwarded clock, so interval boundaries and
   logging are verified rather than assumed. Run: npm run running */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const R = require(path.join(ROOT, 'lib', 'running.js'));
const pad = (n) => String(n).padStart(2, '0');
const d = new Date();
const T = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const DATA = {
  version: 1,
  settings: { startWeight: 250, startDate: T, goalWeight: 210, medication: '', theme: 'light' },
  days: {}, activities: [],
};

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });
const eqv = (name, a, b) => check(name, JSON.stringify(a) === JSON.stringify(b),
  `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

/* ---- programme data, before any UI is involved ------------------------- */
const all = R.allSessions();
eqv('45 sessions across 15 weeks', [all.length, R.WEEKS.length], [45, 15]);
check('every week has exactly three runs',
  R.WEEKS.every((w) => w.sessions.length === 3), 'a week does not have 3');

// Against the published NHS totals, in minutes.
const mins = (w, day) => R.totalSeconds(R.sessionAt(w, day)) / 60;
const published = [[1, 1, 28.5], [2, 1, 29], [3, 1, 25], [4, 1, 31.5], [5, 1, 31],
  [5, 2, 31], [5, 3, 30], [6, 1, 34], [6, 2, 33], [6, 3, 35], [7, 1, 35], [8, 1, 38], [9, 1, 40]];
const wrong = published.filter(([w, day, want]) => Math.abs(mins(w, day) - want) > 0.01);
check('C25K totals match the published plan', wrong.length === 0,
  wrong.map(([w, day, want]) => `W${w}D${day} ${mins(w, day)} vs ${want}`).join(', '));

check('week 9 is 30 minutes of continuous running',
  R.sessionAt(9, 1).steps.filter((s) => s.type === 'run').length === 1
  && R.sessionAt(9, 1).steps.find((s) => s.type === 'run').seconds === 1800, 'not 30 min');
check('week 15 builds to an hour',
  R.sessionAt(15, 2).steps.find((s) => s.type === 'run').seconds === 3600, 'not 60 min');
check('every session starts with a warm-up and ends with a cool-down',
  all.every((s) => s.steps[0].type === 'warmup' && s.steps[s.steps.length - 1].type === 'cooldown'),
  'a session is missing one');
check('no interval is zero length', all.every((s) => s.steps.every((x) => x.seconds > 0)), 'zero found');
check('runs never sit back to back without a walk',
  all.every((s) => s.steps.every((x, i) =>
    !(x.type === 'run' && s.steps[i + 1] && s.steps[i + 1].type === 'run'))),
  'two runs adjacent');

eqv('next session is the first not completed',
  R.nextSession(['1:1', '1:2']).key, '1:3');
eqv('completing a whole week moves to the next',
  R.nextSession(all.slice(0, 3).map((s) => s.key)).key, '2:1');

/* ---- drive the runner --------------------------------------------------- */
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
  const settle = (ms) => new Promise((r) => setTimeout(r, ms || 250));

  const watchdog = setTimeout(() => { console.log('TIMED OUT'); app.exit(1); }, 90000);

  try {
    await run(`show('training'); showSubtab('training', 'plan'); true;`);
    await settle(400);
    check('the programme card offers the first run',
      /Week 1/.test(await run(`document.getElementById('planRun').textContent`)), 'not offered');

    // Silence speech so the harness does not narrate, then start.
    await run(`window.speechSynthesis && window.speechSynthesis.cancel();
      say = () => {}; startRun('1:1'); true;`);
    await settle(400);
    check('runner takes over', await run(`!!document.querySelector('.runner')`), 'no runner');
    check('starts in the warm-up',
      (await run(`document.querySelector('.runner-now').textContent`)) === 'Warm up', 'wrong step');

    // Fast-forward by rewriting startedAt: the runner reads the wall clock, so
    // this exercises the real boundary logic rather than a mocked timer.
    const jumpTo = async (sec) => {
      await run(`DATA.run.startedAt = new Date(Date.now() - ${sec} * 1000).toISOString(); true;`);
      await settle(400);
    };

    await jumpTo(310);   // 10s into the first run interval
    eqv('after the warm-up it says Run',
      await run(`document.querySelector('.runner-now').textContent`), 'Run');

    await jumpTo(370);   // 10s into the first walk
    eqv('then Walk', await run(`document.querySelector('.runner-now').textContent`), 'Walk');

    // The next-up line has to track the session, not stay as first rendered.
    const nextLine = await run(`document.querySelector('.runner-next').textContent.replace(/\\s+/g,' ').trim()`);
    check('it counts the runs remaining', /run(s)? left/.test(nextLine), nextLine);
    check('during a walk it names the run coming next', /Next: Run/.test(nextLine), nextLine);

    await jumpTo(310);   // back into a run interval
    const duringRun = await run(`document.querySelector('.runner-next').textContent.replace(/\\s+/g,' ').trim()`);
    check('during a run it names the walk coming next', /Next: Walk/.test(duringRun), duringRun);
    await jumpTo(370);

    // Pause must actually stop the clock.
    await run(`togglePauseRun(); true;`);
    const t1 = await run('runElapsed()');
    await settle(700);
    const t2 = await run('runElapsed()');
    check('pausing stops the clock', Math.abs(t2 - t1) < 0.2, `${t1} -> ${t2}`);
    await run(`togglePauseRun(); true;`);
    await settle(400);
    const t3 = await run('runElapsed()');
    check('resuming restarts it', t3 >= t2, `${t2} -> ${t3}`);

    // Jump past the end; the runner should log and clear itself.
    await jumpTo(Math.round(R.totalSeconds(R.sessionAt(1, 1))) + 5);
    await settle(700);
    const d2 = await run('JSON.parse(JSON.stringify(DATA))');
    check('finishing logs a run', d2.activities.some((a) => a.type === 'run'),
      JSON.stringify(d2.activities));
    check('it is marked complete', (d2.running.completed || []).includes('1:1'),
      JSON.stringify(d2.running));
    check('the runner clears itself', !d2.run, JSON.stringify(d2.run));
    const logged = d2.activities.find((a) => a.type === 'run');
    check('logged with the session in the notes', /Week 1 run 1/.test(logged.notes), logged.notes);
    check('duration is about the session length',
      Math.abs(logged.minutes - 28.5) <= 1.5, `${logged.minutes} min`);

    await settle(300);
    check('the programme now offers run 2',
      /Week 1 · run 2/.test(await run(`document.getElementById('planRun').textContent`)),
      'did not advance');

    // Discarding must not log anything.
    const before = await run('DATA.activities.length');
    await run(`startRun('1:2'); true;`);
    await settle(300);
    await run(`stopRun(false); true;`);
    await settle(400);
    check('discarding logs nothing',
      (await run('DATA.activities.length')) === before && !(await run('!!DATA.run')),
      'something was left behind');
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
