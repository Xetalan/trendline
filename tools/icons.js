'use strict';

/* Renders the PWA launcher icons. Run: npm run icons

   Drawn to a canvas inside one renderer and read back as PNG bytes. Capturing
   a transparent BrowserWindow per icon is unreliable at larger sizes, and this
   also guarantees exact pixel dimensions and a real alpha channel. */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const OUT = path.join(__dirname, '..', 'docs');
const BLUE = '#2a78d6';

const TARGETS = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable.png', size: 512, maskable: true },
];

// Same mark as the in-app brand: a rising trendline. Maskable gets a
// full-bleed background with the mark inside Android's safe zone, so the
// circle/squircle crop can never clip it.
const DRAW = `
function drawIcon(size, maskable) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');

  let x0, box;
  if (maskable) {
    g.fillStyle = ${JSON.stringify(BLUE)};
    g.fillRect(0, 0, size, size);
    box = size * 0.62;              // mark confined to the safe zone
    x0 = (size - box) / 2;
  } else {
    box = size;
    x0 = 0;
    g.fillStyle = ${JSON.stringify(BLUE)};
    g.beginPath();
    g.roundRect(0, 0, size, size, size * 0.22);
    g.fill();
    box = size * 0.78;
    x0 = (size - box) / 2;
  }

  g.strokeStyle = '#ffffff';
  g.lineWidth = box * 0.13;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(x0 + box * 0.02, x0 + box * 0.82);
  g.lineTo(x0 + box * 0.36, x0 + box * 0.40);
  g.lineTo(x0 + box * 0.58, x0 + box * 0.60);
  g.lineTo(x0 + box * 0.98, x0 + box * 0.10);
  g.stroke();

  return c.toDataURL('image/png');
}`;

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const win = new BrowserWindow({ width: 600, height: 600, show: false });
  await win.loadURL('about:blank');

  for (const t of TARGETS) {
    const dataUrl = await win.webContents.executeJavaScript(
      `(() => { ${DRAW}; return drawIcon(${t.size}, ${t.maskable}); })()`);
    const png = Buffer.from(dataUrl.split(',')[1], 'base64');
    fs.writeFileSync(path.join(OUT, t.file), png);
    console.log('wrote', t.file, `${t.size}x${t.size}`, `${png.length} bytes`);
  }

  win.destroy();
  app.exit(0);
});
