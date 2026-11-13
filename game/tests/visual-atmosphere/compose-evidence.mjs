// Local PNG processing only: does not launch or connect to a browser.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const { PNG } = require(join(dirname(require.resolve('playwright-core/package.json')), 'lib/utilsBundle.js'));
const before = 'test-results/visual-atmosphere-baseline', after = 'test-results/visual-atmosphere-after';
const image = (path) => PNG.sync.read(readFileSync(path));
const background = (out) => { for (let i = 0; i < out.data.length; i += 4) { out.data[i] = out.data[i + 1] = out.data[i + 2] = 18; out.data[i + 3] = 255; } return out; };
const put = (out, src, x0, y0, w, h, crop) => {
  const [sx, sy, sw, sh] = crop ?? [0, 0, src.width, src.height];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = (Math.floor(sy + y / h * sh) * src.width + Math.floor(sx + x / w * sw)) * 4;
    const di = ((y0 + y) * out.width + x0 + x) * 4;
    src.data.copy(out.data, di, si, si + 4);
  }
};
const font = {
  A: ['01110','10001','10001','11111','10001','10001','10001'], B:['11110','10001','10001','11110','10001','10001','11110'],
  E:['11111','10000','10000','11110','10000','10000','11111'], F:['11111','10000','10000','11110','10000','10000','10000'],
  O:['01110','10001','10001','10001','10001','10001','01110'], R:['11110','10001','10001','11110','10100','10010','10001'],
  T:['11111','00100','00100','00100','00100','00100','00100'], X:['10001','10001','01010','00100','01010','10001','10001'],
  N:['10001','11001','11001','10101','10011','10011','10001'], L:['10000','10000','10000','10000','10000','10000','11111'],
  I:['11111','00100','00100','00100','00100','00100','11111'], G:['01111','10000','10000','10111','10001','10001','01111'],
  H:['10001','10001','10001','11111','10001','10001','10001'], ' ':['00000','00000','00000','00000','00000','00000','00000'],
};
function label(out, s, x0, y0) {
  for (const [j, ch] of [...s].entries()) for (let y = 0; y < 7; y++) for (let x = 0; x < 5; x++)
    if (font[ch]?.[y]?.[x] === '1') for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
      const i = ((y0 + y * 2 + a) * out.width + x0 + j * 12 + x * 2 + b) * 4;
      out.data[i] = out.data[i + 1] = out.data[i + 2] = 235;
    }
}
for (const device of ['desktop', 'phone']) {
  const rows = ['l1-5-fx-off', 'l2-corridor-blackout-fx-off', 'l2-classroom-darkest-fx-off'];
  const tileH = device === 'phone' ? 296 : 360, rowH = tileH + 28;
  const out = background(new PNG({ width: 1280, height: 3 * rowH }));
  for (let row = 0; row < rows.length; row++) for (let col = 0; col < 2; col++) {
    const dir = col ? after : before, src = image(`${dir}/${device}-${rows[row]}.png`);
    const y0 = row * rowH;
    label(out, col ? 'AFTER' : 'BEFORE', col * 640 + 12, y0 + 7);
    put(out, src, col * 640, y0 + 28, 640, tileH);
  }
  writeFileSync(`test-results/visual-atmosphere-${device}-comparison.png`, PNG.sync.write(out));
}
const crops = background(new PNG({ width: 1536, height: 284 }));
for (const [i, [name, text]] of [
  ['desktop-l1-5-landmark-off', 'LIGHT OFF'], ['desktop-l1-5-fx-off', 'FX OFF'], ['desktop-l1-5-fx-on', 'FX ON'],
].entries()) {
  const src = image(`${after}/${name}-scene.png`);
  label(crops, text, i * 512 + 12, 7);
  put(crops, src, i * 512, 28, 512, 256, [100, 250, 512, 256]);
}
writeFileSync('test-results/visual-atmosphere-wall-grain-crops.png', PNG.sync.write(crops));
const evidence = JSON.parse(readFileSync(`${after}/evidence.json`, 'utf8')), hudPixels = [];
for (const device of ['desktop', 'phone']) {
  const offSample = evidence.samples.find((s) => s.label === `${device}-l1-5-fx-off`);
  const off = image(`${after}/${device}-l1-5-fx-off.png`), on = image(`${after}/${device}-l1-5-fx-on.png`);
  const scale = off.width / (device === 'phone' ? 844 : 1280);
  for (const id of ['room-code', 'battery']) {
    const rect = offSample.hud.find((r) => r.id === id);
    let pixels = 0, changed = 0, maxDifference = 0;
    for (let y = Math.ceil(rect.y * scale); y < Math.floor((rect.y + rect.height) * scale); y++)
      for (let x = Math.ceil(rect.x * scale); x < Math.floor((rect.x + rect.width) * scale); x++) {
        const i = (y * off.width + x) * 4;
        // Bright, opaque glyph/paper interiors. Translucent antialias edges may legitimately mix with the world.
        if (Math.min(off.data[i], off.data[i + 1], off.data[i + 2]) < 200) continue;
        const delta = Math.max(...[0, 1, 2].map((c) => Math.abs(off.data[i + c] - on.data[i + c])));
        pixels++; if (delta > 2) changed++; maxDifference = Math.max(maxDifference, delta);
      }
    hudPixels.push({ device, id, brightPixels: pixels, changedOver2: changed, maxDifference,
      note: 'Pixel evidence covers bright opaque interiors, supplemented by manual full screenshot review.' });
  }
}
writeFileSync('test-results/visual-atmosphere-hud-pixels.json', JSON.stringify(hudPixels, null, 2));
console.log('Wrote desktop/phone comparisons and 1:1 wall/grain crops.');
