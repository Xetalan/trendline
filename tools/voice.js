'use strict';

/* Dev-only: checks the voice picker against the voice lists real devices
   report. The phone is the target, so the Android Google TTS naming
   ("en-us-x-sfg#female_1-local") matters more than anything on this desktop.
   Run: npm run voice */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pad = (n) => String(n).padStart(2, '0');
const d = new Date();
const T = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const DATA = {
  version: 1,
  settings: { startWeight: 250, startDate: T, goalWeight: null, medication: '', theme: 'light' },
  days: {}, activities: [],
};

// Voice lists as the platforms actually report them.
const DEVICES = {
  android: [
    { name: 'English United States', voiceURI: 'en-us-x-sfg#male_1-local', lang: 'en-US', localService: true },
    { name: 'English United States', voiceURI: 'en-us-x-sfg#female_1-local', lang: 'en-US', localService: true },
    { name: 'English United States', voiceURI: 'en-us-x-tpf#female_2-network', lang: 'en-US', localService: false },
    { name: 'English United Kingdom', voiceURI: 'en-gb-x-gba#male_2-local', lang: 'en-GB', localService: true },
    { name: 'Deutsch', voiceURI: 'de-de-x-nfh#female_1-local', lang: 'de-DE', localService: true },
  ],
  windows: [
    { name: 'Microsoft David Desktop - English (United States)', voiceURI: 'David', lang: 'en-US', localService: true },
    { name: 'Microsoft Zira Desktop - English (United States)', voiceURI: 'Zira', lang: 'en-US', localService: true },
    { name: 'Microsoft Aria Online (Natural) - English (United States)', voiceURI: 'Aria', lang: 'en-US', localService: false },
  ],
  maleOnly: [
    { name: 'Microsoft David Desktop - English (United States)', voiceURI: 'David', lang: 'en-US', localService: true },
    { name: 'Daniel', voiceURI: 'Daniel', lang: 'en-GB', localService: true },
  ],
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
  const settle = (ms) => new Promise((r) => setTimeout(r, ms || 250));

  const results = [];
  const check = (name, pass, detail) => results.push({ name, pass, detail });
  const watchdog = setTimeout(() => { console.log('TIMED OUT'); app.exit(1); }, 60000);

  // Swap in a device's voice list and ask the app what it would choose.
  const useDevice = (which) => run(`(() => {
      const list = ${JSON.stringify(DEVICES[which])};
      window.speechSynthesis.getVoices = () => list;
      return true; })()`);

  try {
    await useDevice('android');
    const pick = await run(`(() => { const v = pickVoice(); return { uri: v.voiceURI, lang: v.lang }; })()`);
    check('on Android it picks a female voice',
      /#female/.test(pick.uri), JSON.stringify(pick));
    check('and prefers the local one over the network one',
      /-local$/.test(pick.uri), JSON.stringify(pick));

    const scores = await run(`(() => {
      const out = {};
      window.speechSynthesis.getVoices().forEach((v) => { out[v.voiceURI] = scoreVoice(v); });
      return out; })()`);
    check('non-English voices are excluded', scores['de-de-x-nfh#female_1-local'] === -1,
      JSON.stringify(scores));
    check('female scores above male',
      scores['en-us-x-sfg#female_1-local'] > scores['en-us-x-sfg#male_1-local'], JSON.stringify(scores));

    await useDevice('windows');
    const win2 = await run(`(() => { const v = pickVoice(); return v.voiceURI; })()`);
    check('on Windows it picks Aria over Zira and David', win2 === 'Aria', win2);

    await useDevice('maleOnly');
    const only = await run(`(() => { const v = pickVoice(); return v ? v.voiceURI : null; })()`);
    check('with only male voices it still returns one', !!only, String(only));

    // An explicit choice must win over the scoring.
    await useDevice('android');
    await run(`DATA.settings.voiceURI = 'en-gb-x-gba#male_2-local'; true;`);
    const chosen = await run(`pickVoice().voiceURI`);
    check('an explicit choice overrides the default', chosen === 'en-gb-x-gba#male_2-local', chosen);
    await run(`DATA.settings.voiceURI = null; true;`);

    // The picker itself.
    await run(`show('settings'); renderVoicePicker(); true;`);
    await settle(300);
    const opts = await run(`[...document.querySelectorAll('#voiceSel option')].map((o) => o.textContent)`);
    check('the picker lists English voices only', opts.length === 4, JSON.stringify(opts));
    check('network voices are labelled', opts.some((o) => /needs data/.test(o)), JSON.stringify(opts));
    check('the best voice is preselected',
      /#female/.test(await run(`document.getElementById('voiceSel').value`)),
      await run(`document.getElementById('voiceSel').value`));

    // Rate and voice reach the utterance. The utterance is stubbed too: a real
    // one rejects a plain object as `voice`, and these stub voices are plain
    // objects, so only a stub can carry them through.
    const spoken = await run(`(() => {
      let captured = null;
      const realSpeak = window.speechSynthesis.speak;
      const realUtter = window.SpeechSynthesisUtterance;
      window.SpeechSynthesisUtterance = function (t) { this.text = t; };
      window.speechSynthesis.speak = (u) => {
        captured = { rate: u.rate, voice: u.voice && u.voice.voiceURI, lang: u.lang };
      };
      DATA.settings.voiceRate = 1.2;
      say('test');
      window.speechSynthesis.speak = realSpeak;
      window.SpeechSynthesisUtterance = realUtter;
      return captured; })()`);
    check('the chosen rate is used', spoken && spoken.rate === 1.2, JSON.stringify(spoken));
    check('the chosen voice is attached', spoken && /#female/.test(spoken.voice || ''), JSON.stringify(spoken));

    // A voice the engine refuses must not silence the cue.
    const fallback = await run(`(() => {
      let captured = null;
      const realSpeak = window.speechSynthesis.speak;
      const realPick = pickVoice;
      pickVoice = () => { throw new Error('engine refused'); };
      window.speechSynthesis.speak = (u) => { captured = { text: u.text, rate: u.rate }; };
      say('run for ninety seconds');
      window.speechSynthesis.speak = realSpeak;
      pickVoice = realPick;
      return captured; })()`);
    check('a rejected voice still speaks the cue',
      fallback && /ninety/.test(fallback.text || ''), JSON.stringify(fallback));

    // No voices at all must not throw.
    await run(`window.speechSynthesis.getVoices = () => []; renderVoicePicker(); say('nothing'); true;`);
    check('a device with no voices degrades quietly',
      /No voices/.test(await run(`document.getElementById('voiceSel').textContent`)),
      await run(`document.getElementById('voiceSel').textContent`));
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
