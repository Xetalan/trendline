'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

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
