'use strict';
/* Dev-only harness: loads the real UI against in-memory demo data and writes
   PNGs of each view. Never touches the user's data file. */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const OUT = process.env.SHOT_DIR || path.join(__dirname, '..', 'shots');
const ROOT = path.join(__dirname, '..');

function demo() {
  const days = {};
  const activities = [];
  // Anchor the fixture to today so screenshots show a live-looking chart.
  const d0 = new Date();
  d0.setDate(d0.getDate() - 44);
  const startISO = `${d0.getFullYear()}-${String(d0.getMonth()+1).padStart(2,"0")}-${String(d0.getDate()).padStart(2,"0")}`;
  days[startISO] = { weight: 250, steps: null, notes: "Starting weight" };

  const wave = [0, -0.4, 0.5, -0.9, 0.3, -0.2, 0.6];
  let w = 247;
  for (let i = 4; i <= 44; i++) {           // a couple of months of data
    const d = new Date(d0.getTime());
    d.setDate(d.getDate() + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (i % 9 === 5) continue;              // a couple of missed days
    w -= 0.34;
    days[key] = { weight: +(w + wave[i % 7]).toFixed(1), steps: 5200 + ((i * 733) % 6000), notes: '' };

    const dow = d.getDay();
    if (dow === 1 || dow === 4) {
      activities.push({ id: `r${i}`, date: key, type: 'run', minutes: 26 + (i % 5) * 3,
        distance: +(2.1 + (i % 7) * 0.14).toFixed(2), label: '', notes: '', exercises: [] });
    }
    if (dow === 2 || dow === 6) {
      activities.push({ id: `l${i}`, date: key, type: 'lift', minutes: 45, distance: 0, label: '', notes: '',
        exercises: [
          { name: 'Goblet squat', sets: [{ reps: 10, weight: 45 + i }, { reps: 10, weight: 45 + i }, { reps: 8, weight: 50 + i }] },
          { name: 'Bench press', sets: [{ reps: 8, weight: 95 + i }, { reps: 8, weight: 95 + i }, { reps: 6, weight: 105 + i }] },
          { name: 'Row', sets: [{ reps: 12, weight: 60 + i }, { reps: 12, weight: 60 + i }] },
        ] });
    }
    if (dow === 6) {
      activities.push({ id: `h${i}`, date: key, type: 'hike', minutes: 85 + (i % 3) * 20,
        distance: +(3.4 + (i % 4) * 0.45).toFixed(2), label: '', notes: '', exercises: [] });
    }
    if (dow === 0 || dow === 3 || dow === 5) {
      activities.push({ id: `w${i}`, date: key, type: 'walk', minutes: 32 + (i % 4) * 6,
        distance: +(1.5 + (i % 5) * 0.2).toFixed(2), label: '', notes: '', exercises: [] });
    }
  }
  return {
    version: 1,
    settings: { startWeight: 250, startDate: startISO, goalWeight: 210, medication: 'GLP-1', weekStartsOn: 1 },
    days, activities,
  };
}

const DATA = demo();

app.whenReady().then(async () => {
  ipcMain.handle('data:load', () => DATA);
  ipcMain.handle('data:save', () => true);
  ipcMain.handle('data:backup', () => true);
  ipcMain.handle('data:reveal', () => true);
  ipcMain.handle('file:export', () => ({ ok: false }));

  fs.mkdirSync(OUT, { recursive: true });

  // A hidden window is not composited, so capturePage returns stale or
  // half-painted frames. Show it (without stealing focus) and keep it awake.
  const win = new BrowserWindow({
    width: Number(process.env.SHOT_W) || 1320,
    height: Number(process.env.SHOT_H) || 900,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.showInactive();

  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });
  win.webContents.on('preload-error', (_e, p, err) => errors.push(`preload ${p}: ${err}`));

  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await new Promise((r) => setTimeout(r, 1400));

  // Kill the view fade so a capture can't catch it mid-animation.
  await win.webContents.insertCSS('.view.active{animation:none!important}');

  const theme = process.env.SHOT_THEME || 'light';
  await win.webContents.executeJavaScript(
    `DATA.settings.theme = ${JSON.stringify(theme)}; applyTheme(); renderAll(); true;`);
  await new Promise((r) => setTimeout(r, 1200));

  for (const view of ['dashboard', 'training', 'log', 'history']) {
    await win.webContents.executeJavaScript(`show(${JSON.stringify(view)}); true;`);
    await new Promise((r) => setTimeout(r, 1000));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `${view}-${theme}.png`), img.toPNG());
    console.log('wrote', `${view}-${theme}.png`);
  }

  // Each dashboard focus panel.
  for (const focus of ['run', 'lift']) {
    await win.webContents.executeJavaScript(
      `show('dashboard'); dashFocus = ${JSON.stringify(focus)}; renderDashboard(); true;`);
    await new Promise((r) => setTimeout(r, 900));
    const shot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `dash-${focus}-${theme}.png`), shot.toPNG());
    console.log('wrote', `dash-${focus}-${theme}.png`);
  }
  await win.webContents.executeJavaScript(`dashFocus = 'weight'; renderDashboard(); true;`);

  // The per-workout editor lives under Training > Sessions, once a row is open.
  await win.webContents.executeJavaScript(`show('training');
    showSubtab('training', 'sessions');
    workoutFilter = 'hike';
    openEditor = DATA.activities.filter(a => a.type === 'hike').sort((a,b) => a.date < b.date ? 1 : -1)[0].id;
    renderWorkouts(); true;`);
  await new Promise((r) => setTimeout(r, 800));
  fs.writeFileSync(path.join(OUT, `workout-editor-${theme}.png`), (await win.webContents.capturePage()).toPNG());
  console.log('wrote', `workout-editor-${theme}.png`);

  // The lifting form only exists once that type is selected.
  await win.webContents.executeJavaScript(`show('log'); setType('lift'); true;`);
  await new Promise((r) => setTimeout(r, 800));
  fs.writeFileSync(path.join(OUT, `log-lift-${theme}.png`), (await win.webContents.capturePage()).toPNG());
  console.log('wrote', `log-lift-${theme}.png`);

  if (errors.length) {
    console.log('--- CONSOLE ERRORS ---');
    errors.forEach((e) => console.log(e));
  } else {
    console.log('--- no console errors ---');
  }
  app.quit();
});
