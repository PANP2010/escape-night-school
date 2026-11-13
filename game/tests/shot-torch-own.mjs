// One-off check (not in the gate): the player's own 手电 at the L1 spawn, facing down the corridor to the 铁栅门 (−x).
// Same camera, light off then on → test-results/own-torch-{off,on}.png and the mean brightness ratios (frame / centre).
// Run against a dist-server: PORT=4198 node dist-server/index.js & PORT=4198 node tests/shot-torch-own.mjs
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { assertDebugAvailable } from './helpers.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const base = `http://127.0.0.1:${process.env.PORT ?? 4198}`;
const W = 960, H = 540;
const ARGS = browserArgs(['--disable-gpu-compositing', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']);
const b = await chromium.launch({ args: ARGS });
try {
const ctx = await b.newContext({ baseURL: base, viewport: { width: W, height: H } });
const p = await ctx.newPage();
await p.goto('/?nodraw&steady');
await p.fill('#name', '甲');
await p.click('#create');
await p.click('#start');
await p.waitForFunction(() => window.__escape.game()?.spawnSynced, null, { timeout: 60_000 });
await assertDebugAvailable(p);
const yaw = Number(process.env.YAW ?? Math.PI / 2), pitch = Number(process.env.PITCH ?? -0.05);
const at = await p.evaluate(([yaw, pitch]) => {
  const g = window.__escape.game(), c = g.camera.position;
  window.__escape.debug('safe', 600); // nobody catches us mid-measurement (the 倒地 overlay would swamp the frame)
  g.view = { x: c.x, y: c.y, z: c.z, yaw, pitch }; // camera pinned: the same pose for every shot
  return [c.x, c.y, c.z].map((v) => +v.toFixed(2));
}, [yaw, pitch]);
const tune = { intensity: process.env.I, distance: process.env.DIST, angle: process.env.A, penumbra: process.env.PEN, decay: process.env.DEC };
console.log('flashlight', await p.evaluate((t) => { // env overrides for tuning without a rebuild
  const l = window.__escape.game().flashlight;
  for (const [k, v] of Object.entries(t)) if (v != null) l[k] = Number(v);
  if (t.z != null) l.position.z = Number(t.z);
  return { intensity: l.intensity, distance: l.distance, angle: l.angle, penumbra: l.penumbra, decay: l.decay, pos: l.position.toArray() };
}, { ...tune, z: process.env.Z }));
console.log('camera', at, 'yaw', yaw.toFixed(2));
await p.addStyleTag({ content: 'body * { visibility: hidden } canvas { visibility: visible }' }); // HUD + 茉莉 grain off
mkdirSync('test-results', { recursive: true });
const gray = (file) => execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
const box = (raw, x0, y0, x1, y1) => { let s = 0, n = 0; for (let y = Math.round(y0); y < y1; y++) for (let x = Math.round(x0); x < x1; x++) { s += raw[y * W + x]; n++; } return s / n; };
const sat = (raw) => { let n = 0; for (const v of raw) if (v >= 250) n++; return n / raw.length; };
const res = {};
for (const on of [false, true, false, true]) {
  await p.evaluate((l) => { const g = window.__escape.game(); g.light = l; g.draw = true; }, on);
  await p.waitForTimeout(2500);
  const file = `test-results/own-torch-${on ? 'on' : 'off'}.png`;
  await p.locator('body > canvas').screenshot({ path: file }); // the 3D view only: HUD and the 茉莉 grain overlay are DOM
  await p.evaluate(() => { window.__escape.game().draw = false; });
  const raw = gray(file);
  res[on] = { frame: box(raw, 0, 0, W, H), centre: box(raw, W * 0.3, H * 0.35, W * 0.7, H * 0.75), sat: sat(raw) };
}
const f = (v) => v.toFixed(2);
console.log('off', JSON.stringify(res.false), '\non ', JSON.stringify(res.true));
console.log('ratio frame', f(res.true.frame / res.false.frame), 'centre', f(res.true.centre / res.false.centre), 'saturated(on)', (res.true.sat * 100).toFixed(2) + '%');

// near field: light on, facing each side wall of the corridor (≈1 m away at the spawn) — must not blow out
for (const [name, y] of [['wall-n', 0], ['wall-s', Math.PI]]) {
  await p.evaluate((y) => { const g = window.__escape.game(); g.view = { ...g.view, yaw: y, pitch: -0.1 }; g.light = true; g.draw = true; }, y);
  await p.waitForTimeout(2500);
  const file = `test-results/own-torch-${name}.png`;
  await p.locator('body > canvas').screenshot({ path: file });
  await p.evaluate(() => { window.__escape.game().draw = false; });
  const raw = gray(file);
  console.log(name, 'centre', f(box(raw, W * 0.3, H * 0.35, W * 0.7, H * 0.75)), 'max', raw.reduce((a, v) => Math.max(a, v), 0), 'saturated', (sat(raw) * 100).toFixed(2) + '%');
}
await ctx.close(); await b.close();
} finally {
  await b.close();
}
