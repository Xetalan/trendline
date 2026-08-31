'use strict';

/* Writes the Trendline launcher icons into the Android resource folders.
   Run after `cap add android` (or any time the mark changes):
     npm run icons:android

   Adaptive icons put the mark on a coloured background, and Android crops the
   foreground to a circle/squircle - so the mark is drawn inside the safe zone
   (the middle ~66% of the canvas) with transparent margin around it. */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const RES = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');
const BLUE = '#2a78d6';

// Legacy launcher icons are 48dp; the adaptive foreground is 108dp.
const DENSITIES = [
  ['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192],
];

const DRAW = `
function mark(g, x0, box, stroke) {
  g.strokeStyle = '#ffffff';
  g.lineWidth = box * stroke;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(x0 + box * 0.02, x0 + box * 0.82);
  g.lineTo(x0 + box * 0.36, x0 + box * 0.40);
  g.lineTo(x0 + box * 0.58, x0 + box * 0.60);
  g.lineTo(x0 + box * 0.98, x0 + box * 0.10);
  g.stroke();
}

function draw(size, kind) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');

  if (kind === 'foreground') {
    // Transparent: the adaptive background colour shows through. Mark sits
    // inside the safe zone so the system crop cannot clip it.
    const box = size * 0.42;
    mark(g, (size - box) / 2, box, 0.13);
  } else {
    g.fillStyle = ${JSON.stringify(BLUE)};
    if (kind === 'round') {
      g.beginPath();
      g.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      g.fill();
    } else {
      g.beginPath();
      g.roundRect(0, 0, size, size, size * 0.22);
      g.fill();
    }
    const box = size * 0.62;
    mark(g, (size - box) / 2, box, 0.13);
  }
  return c.toDataURL('image/png');
}`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 600, height: 600, show: false });
  await win.loadURL('about:blank');

  let written = 0;
  for (const [density, size] of DENSITIES) {
    const dir = path.join(RES, `mipmap-${density}`);
    if (!fs.existsSync(dir)) continue;
    const targets = [
      ['ic_launcher.png', size, 'square'],
      ['ic_launcher_round.png', size, 'round'],
      // 108dp foreground against the 48dp legacy size
      ['ic_launcher_foreground.png', Math.round(size * 2.25), 'foreground'],
    ];
    for (const [file, px, kind] of targets) {
      const dataUrl = await win.webContents.executeJavaScript(
        `(() => { ${DRAW}; return draw(${px}, ${JSON.stringify(kind)}); })()`);
      fs.writeFileSync(path.join(dir, file), Buffer.from(dataUrl.split(',')[1], 'base64'));
      written++;
    }
    console.log(`mipmap-${density}: ${size}px`);
  }

  // The adaptive background is a flat colour behind the foreground.
  const colorFile = path.join(RES, 'values', 'ic_launcher_background.xml');
  if (fs.existsSync(colorFile)) {
    fs.writeFileSync(colorFile,
      '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
      + `    <color name="ic_launcher_background">${BLUE}</color>\n</resources>\n`, 'utf8');
    console.log('adaptive background set to', BLUE);
  }

  console.log(`${written} icon files written`);
  win.destroy();
  app.exit(0);
});
