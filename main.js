'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { mapWorkout } = require('./lib/oura-map');

const DATA_FILE = () => path.join(app.getPath('userData'), 'trendline-data.json');
const BACKUP_DIR = () => path.join(app.getPath('userData'), 'backups');

// A fresh install starts empty. The first weigh-in logged becomes the baseline,
// so there is nothing to fill in before the app is useful.
function seedData() {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return {
    version: 1,
    settings: {
      startWeight: null,
      startDate: today,
      goalWeight: null,
      medication: '',
      weekStartsOn: 1, // Monday
      theme: 'auto',
    },
    days: {},
    activities: [],
  };
}

function readDataSync() {
  const file = DATA_FILE();
  try {
    if (!fs.existsSync(file)) {
      const seeded = seedData();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(seeded, null, 2), 'utf8');
      return seeded;
    }
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Tolerate a partially-written or hand-edited file.
    return {
      version: 1,
      settings: { ...seedData().settings, ...(parsed.settings || {}) },
      days: parsed.days || {},
      activities: Array.isArray(parsed.activities) ? parsed.activities : [],
    };
  } catch (err) {
    // Never lose the old file to a parse error - move it aside and start clean.
    try {
      const broken = `${file}.broken-${Date.now()}`;
      fs.renameSync(file, broken);
      console.error('Unreadable data file moved to', broken, err);
    } catch (_) { /* ignore */ }
    return seedData();
  }
}

// Write to a temp file and rename, so a crash mid-write can't truncate the
// real data file.
async function writeData(data) {
  const file = DATA_FILE();
  const tmp = `${file}.tmp`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, file);
  return true;
}

// Keep a rolling set of daily snapshots. Cheap insurance for data that only
// exists on one machine.
async function rollBackup(data) {
  try {
    const dir = BACKUP_DIR();
    await fsp.mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    await fsp.writeFile(path.join(dir, `trendline-${stamp}.json`), JSON.stringify(data, null, 2), 'utf8');
    const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    for (const stale of files.slice(0, Math.max(0, files.length - 14))) {
      await fsp.unlink(path.join(dir, stale)).catch(() => {});
    }
  } catch (_) { /* backups are best-effort */ }
}

/* ---------------------------------------------------------------- Oura

   The Oura API sends no Access-Control-Allow-Origin, so a browser blocks it.
   Fetching from the main process sidesteps CORS entirely, which is why this
   only exists in the desktop build.

   The token is a long-lived credential, so it is encrypted with the OS
   keychain rather than sitting in plain text next to the weigh-ins. */

const TOKEN_FILE = () => path.join(app.getPath('userData'), 'oura-token.bin');

function saveToken(token) {
  const file = TOKEN_FILE();
  if (!token) {
    try { fs.unlinkSync(file); } catch (_) { /* already gone */ }
    return true;
  }
  const buf = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(token)
    : Buffer.from(`plain:${token}`, 'utf8');
  fs.writeFileSync(file, buf);
  return true;
}

function readToken() {
  try {
    const buf = fs.readFileSync(TOKEN_FILE());
    const asText = buf.toString('utf8');
    if (asText.startsWith('plain:')) return asText.slice(6);
    return safeStorage.decryptString(buf);
  } catch (_) {
    return null;
  }
}

async function ouraGet(endpoint, token, params) {
  const url = new URL(`https://api.ouraring.com/v2/usercollection/${endpoint}`);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new Error('Oura rejected the token. Check it in Settings.');
  if (res.status === 429) throw new Error('Oura rate limit hit. Try again in a minute.');
  if (!res.ok) throw new Error(`Oura returned ${res.status}`);
  const body = await res.json();
  return Array.isArray(body.data) ? body.data : [];
}


let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#f7f9fa',
    show: false,
    title: 'Trendline',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.removeMenu();
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Anything that isn't the app itself opens in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  ipcMain.handle('data:load', () => readDataSync());

  ipcMain.handle('data:save', async (_e, data) => {
    await writeData(data);
    return true;
  });

  ipcMain.handle('data:backup', async (_e, data) => {
    await rollBackup(data);
    return true;
  });

  ipcMain.handle('oura:setToken', (_e, token) => saveToken(token));
  ipcMain.handle('oura:hasToken', () => !!readToken());

  ipcMain.handle('oura:sync', async (_e, { startDate, endDate }) => {
    const token = readToken();
    if (!token) return { ok: false, error: 'No Oura token saved yet.' };
    try {
      const range = { start_date: startDate, end_date: endDate };
      const [activity, workouts] = await Promise.all([
        ouraGet('daily_activity', token, range),
        ouraGet('workout', token, range),
      ]);
      return {
        ok: true,
        steps: activity
          .filter((a) => a.day && typeof a.steps === 'number')
          .map((a) => ({ date: a.day, steps: a.steps })),
        workouts: workouts.filter((w) => w.day && w.id).map(mapWorkout),
      };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('data:reveal', () => {
    shell.showItemInFolder(DATA_FILE());
    return true;
  });

  ipcMain.handle('file:export', async (_e, { defaultName, contents }) => {
    const json = /\.json$/i.test(defaultName);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: json ? 'Save backup' : 'Export',
      defaultPath: path.join(app.getPath('documents'), defaultName),
      filters: json
        ? [{ name: 'JSON', extensions: ['json'] }]
        : [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { ok: false };
    await fsp.writeFile(filePath, contents, 'utf8');
    return { ok: true, filePath };
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
