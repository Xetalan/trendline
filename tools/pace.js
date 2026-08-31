'use strict';
/* Dev-only: exercises the distance / duration / pace triangle in both
   directions. In-memory data; never touches the real file. */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DATA = {
  version: 1,
  settings: { startWeight: 250, startDate: '2026-01-05', goalWeight: null, medication: '', theme: 'light' },
  days: {}, activities: [],
};

app.whenReady().then(async () => {
  ipcMain.handle('data:load', () => DATA);
  ipcMain.handle('data:save', () => true);
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

  // Type into a field the way a person does, so the real listeners fire.
  const typeInto = (id, value, evt) => run(`
    (() => { const el = document.getElementById(${JSON.stringify(id)});
      el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event(${JSON.stringify(evt)}, { bubbles: true }));
      return true; })()`);

  const reset = (type = 'run') => run(`show('log'); setType(${JSON.stringify(type)}); clearActivityForm(); true;`);
  const readAll = () => run(`({ dist:  document.getElementById('aDist').value,
                                min:   document.getElementById('aMin').value,
                                speed: document.getElementById('aSpeed').value,
                                pace:  document.getElementById('aPace').value })`);

  const results = [];
  const check = (name, pass, detail) => results.push({ name, pass, detail });

  // --- pace parsing
  const parses = await run(`[parsePace('9:30'), parsePace('9:30 /mi'), parsePace('9.5'),
                             parsePace('10'), parsePace(''), parsePace('abc')]`);
  check('parsePace handles mm:ss, decimals, junk',
    parses[0] === 9.5 && parses[1] === 9.5 && parses[2] === 9.5 &&
    parses[3] === 10 && parses[4] === null && parses[5] === null,
    JSON.stringify(parses));

  // --- distance + duration -> pace
  await reset();
  await typeInto('aDist', '3.1', 'input');
  await typeInto('aMin', '31', 'input');
  let v = await readAll();
  check('distance + duration -> pace', v.pace === '10:00', JSON.stringify(v));

  // --- distance + pace -> duration
  await reset();
  await typeInto('aDist', '4', 'input');
  await typeInto('aPace', '9:30', 'change');
  v = await readAll();
  check('distance + pace -> duration', v.min === '38', JSON.stringify(v));

  // --- pace + duration -> distance   (the case just asked for)
  await reset();
  await typeInto('aMin', '45', 'input');
  await typeInto('aPace', '15:00', 'change');
  v = await readAll();
  check('duration + pace -> distance', v.dist === '3', JSON.stringify(v));

  // --- and the reverse entry order
  await reset();
  await typeInto('aPace', '12:00', 'change');
  await typeInto('aMin', '30', 'input');
  v = await readAll();
  check('pace first, then duration -> distance', v.dist === '2.5', JSON.stringify(v));

  // --- treadmill: set the belt speed and run the clock -> distance
  await reset('walk');
  await typeInto('aSpeed', '3.5', 'change');
  await typeInto('aMin', '40', 'input');
  v = await readAll();
  check('treadmill speed + duration -> distance',
    v.dist === '2.33' && v.pace === '17:09', JSON.stringify(v));

  // --- speed and pace stay two faces of one number
  await reset('walk');
  await typeInto('aSpeed', '4', 'change');
  v = await readAll();
  check('speed fills pace', v.pace === '15:00', JSON.stringify(v));
  await typeInto('aPace', '12:00', 'change');
  v = await readAll();
  check('pace fills speed back', v.speed === '5', JSON.stringify(v));

  // --- distance + duration fills BOTH rate faces
  await reset('run');
  await typeInto('aDist', '3', 'input');
  await typeInto('aMin', '30', 'input');
  v = await readAll();
  check('distance + duration -> speed and pace',
    v.pace === '10:00' && v.speed === '6', JSON.stringify(v));

  // --- editing one field alone must not wipe another
  await reset('run');
  await typeInto('aDist', '2', 'input');
  v = await readAll();
  check('single field does not clear the others', v.dist === '2' && v.min === '', JSON.stringify(v));

  // --- a saved run keeps the derived numbers
  await reset('run');
  await typeInto('aPace', '12:00', 'change');
  await typeInto('aMin', '30', 'input');
  await run(`document.getElementById('aSave').click(); true;`);
  await new Promise((r) => setTimeout(r, 250));
  const saved = await run('JSON.parse(JSON.stringify(DATA.activities))');
  check('derived distance is stored on save',
    saved.length === 1 && saved[0].distance === 2.5 && saved[0].minutes === 30,
    JSON.stringify(saved[0]));

  // --- form clears, including the touched-order memory
  v = await readAll();
  check('form cleared after save', !v.dist && !v.min && !v.pace, JSON.stringify(v));

  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : '  -> ' + r.detail}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (errors.length) { console.log('CONSOLE ERRORS:'); errors.forEach((e) => console.log('  ' + e)); }
  app.exit(failed ? 1 : 0);
});
