'use strict';

/* =============================================================
   Web / PWA platform adapter.

   Presents the exact same `window.api` surface the Electron preload
   exposes, so the UI never learns which platform it is running on.
   Storage is IndexedDB rather than a JSON file on disk.
   ============================================================= */

(() => {
  const DB_NAME = 'trendline';
  const STORE = 'kv';
  const DATA_KEY = 'data';
  const BACKUP_PREFIX = 'backup:';
  const KEEP_BACKUPS = 14;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idb(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result;
      try { result = fn(store); } catch (err) { reject(err); return; }
      tx.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  const get = (key) => idb('readonly', (s) => s.get(key));
  const put = (key, value) => idb('readwrite', (s) => { s.put(value, key); return true; });
  const del = (key) => idb('readwrite', (s) => { s.delete(key); return true; });
  const allKeys = () => idb('readonly', (s) => s.getAllKeys());

  // A fresh install starts empty rather than carrying anyone else's numbers.
  // The first weigh-in logged becomes the baseline (see saveWeighin).
  const emptyData = () => ({
    version: 1,
    settings: {
      startWeight: null,
      startDate: new Date().toISOString().slice(0, 10),
      goalWeight: null,
      medication: '',
      weekStartsOn: 1,
      theme: 'auto',
    },
    days: {},
    activities: [],
  });

  function normalise(parsed) {
    const base = emptyData();
    if (!parsed || typeof parsed !== 'object') return base;
    return {
      version: 1,
      settings: { ...base.settings, ...(parsed.settings || {}) },
      days: parsed.days && typeof parsed.days === 'object' ? parsed.days : {},
      activities: Array.isArray(parsed.activities) ? parsed.activities : [],
    };
  }

  function download(filename, contents, mime) {
    const blob = new Blob([contents], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  window.api = {
    platform: 'web',

    async load() {
      try {
        const stored = await get(DATA_KEY);
        if (!stored) {
          const seeded = emptyData();
          await put(DATA_KEY, seeded);
          return seeded;
        }
        return normalise(stored);
      } catch (err) {
        console.error('load failed', err);
        return emptyData();
      }
    },

    async save(data) {
      await put(DATA_KEY, JSON.parse(JSON.stringify(data)));
      return true;
    },

    // One snapshot per day, newest KEEP_BACKUPS retained - the same policy the
    // desktop build uses for its backups folder.
    async backup(data) {
      try {
        const stamp = new Date().toISOString().slice(0, 10);
        await put(BACKUP_PREFIX + stamp, JSON.parse(JSON.stringify(data)));
        const keys = (await allKeys())
          .filter((k) => typeof k === 'string' && k.startsWith(BACKUP_PREFIX))
          .sort();
        for (const stale of keys.slice(0, Math.max(0, keys.length - KEEP_BACKUPS))) {
          await del(stale);
        }
      } catch (_) { /* backups are best-effort */ }
      return true;
    },

    // No filesystem to reveal; hand over the raw JSON instead.
    async reveal() {
      const data = await get(DATA_KEY);
      download('trendline-data.json', JSON.stringify(data ?? emptyData(), null, 2), 'application/json');
      return true;
    },

    async exportFile(defaultName, contents) {
      download(defaultName, contents, 'text/csv;charset=utf-8');
      return { ok: true, filePath: defaultName };
    },
  };

  // Ask the browser not to evict the database under storage pressure. Chrome
  // grants this readily once the app is installed to the home screen.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persisted().then((already) => {
      if (!already) navigator.storage.persist().catch(() => {});
    }).catch(() => {});
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((err) =>
        console.warn('service worker registration failed', err));
    });
  }
})();
