// One-off check (not in the gate): which teammate gets A's two real teamLights with 3 players over the real ws server.
// B stands close beside A with the beam pointing back (out of A's view); C stands 5 m ahead lighting the floor in view.
// A screenshots with C's torch on and off → test-results/tl-{on,off}.png; prints who holds the light and the
// brightness of C's pool and of a ring round it (the decal alone only brightens the pool; the real light spills).
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { assertDebugAvailable, placeNear } from './helpers.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const base = `http://127.0.0.1:${process.env.PORT ?? 4198}`;
const W = 640, H = 360;
const ARGS = browserArgs(['--disable-background-timer-throttling', '--disable-renderer-backgrounding']);
const names = ['甲', '乙', '丙'];
const brs = await Promise.all(names.map(() => chromium.launch({ args: ARGS })));
try {
const ctxs = await Promise.all(brs.map((b, i) => b.newContext({ baseURL: base, viewport: i ? { width: 320, height: 200 } : { width: W, height: H } })));
const [A, B, C] = await Promise.all(ctxs.map((c) => c.newPage()));
// steady: no 日光灯 flicker in the brightness compare (#190)
for (const [i, p] of [A, B, C].entries()) { await p.goto('/?nodraw&steady'); await p.fill('#name', names[i]); }
await A.click('#create');
const code = await A.evaluate(async () => { while (!window.__escape.code) await new Promise((r) => setTimeout(r, 50)); return window.__escape.code; });
for (const p of [B, C]) { await p.fill('#code', code); await p.click('#join'); }
await A.waitForSelector('#wait-members li:nth-child(3)');
await A.click('#start');
for (const p of [A, B, C]) await p.waitForFunction(() => window.__escape.game()?.spawnSynced, null, { timeout: 90_000 });
await assertDebugAvailable(A);
const placeAt = async (page, x, z) => {
  const origin = await page.evaluate(() => { const g = window.__escape.game(); return { x: g.pos.x, z: g.pos.z }; });
  return placeNear(page, x - origin.x, z - origin.z);
};
const fps = (p) => p.evaluate(async () => { let fr = 0, on = true; const f = () => { fr++; if (on) requestAnimationFrame(f); }; requestAnimationFrame(f); await new Promise((r) => setTimeout(r, 1000)); on = false; return fr; });
for (let k = 0; k < 60 && (await fps(A)) < 20; k++);
if (process.env.AT) { const [x, z] = process.env.AT.split(',').map(Number); await placeAt(A, x, z); }
await A.waitForTimeout(800);
const a = await A.evaluate(() => { const g = window.__escape.game(); g.input.yaw = 0; g.input.pitch = -0.15; return { x: g.pos.x, z: g.pos.z }; });
await placeAt(B, a.x + 1.3, a.z + 0.6);
await placeAt(C, a.x, a.z - 5);
await B.evaluate(() => { const g = window.__escape.game(); g.input.yaw = Math.PI; g.input.pitch = -0.3; g.light = true; });
mkdirSync('test-results', { recursive: true });
let poolPx;
const pose = async (name, cLight) => {
  await C.evaluate((l) => { const g = window.__escape.game(); g.input.yaw = 0.6; g.input.pitch = -0.4; g.light = l; }, cLight);
  await A.evaluate(() => { window.__escape.game().light = false; }); // only teammates' light
  await A.waitForTimeout(2500);
  const r = await A.evaluate(() => {
    const g = window.__escape.game(), out = {};
    for (const [id, rm] of g.remotes) {
      const n = g.names.get(id), o = new THREE_V(rm);
      out[n] = { lit: rm.st.spot.visible, holds: g.teamLights.some((l) => l.intensity > 0 && l.position.distanceTo(o) < 0.6) };
    }
    function THREE_V(rm) { rm.st.cone.updateWorldMatrix(true, false); return rm.st.cone.getWorldPosition(g.teamLights[0].position.clone()); }
    out.intensity = g.teamLights.map((l) => +l.intensity.toFixed(2));
    g.draw = true;
    return out;
  });
  await A.waitForTimeout(1200);
  const sp = await A.evaluate(() => { const g = window.__escape.game(); const rm = [...g.remotes].find(([id]) => g.names.get(id) === '丙')[1];
    const v = rm.st.spot.position.clone().setFromMatrixPosition(rm.st.spot.matrixWorld); v.project(g.camera); return { x: (v.x + 1) / 2 * innerWidth, y: (1 - v.y) / 2 * innerHeight, vis: rm.st.spot.visible }; });
  if (sp.vis && !poolPx) poolPx = sp;
  const file = `test-results/tl-${name}.png`;
  await A.screenshot({ path: file });
  await A.evaluate(() => { window.__escape.game().draw = false; });
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  const box = (x0, y0, x1, y1) => { let s = 0, n = 0; for (let y = Math.max(0, Math.round(y0)); y < Math.min(H, y1); y++) for (let x = Math.max(0, Math.round(x0)); x < Math.min(W, x1); x++) { s += raw[y * W + x]; n++; } return n ? s / n : 0; };
  const p = poolPx ?? { x: W / 2, y: H * 0.6 };
  const pool = box(p.x - 20, p.y - 8, p.x + 20, p.y + 8);
  // ring: a box 3× the pool's size minus the pool itself
  const big = box(p.x - 90, p.y - 40, p.x + 90, p.y + 40), ring = (big * 180 * 80 - pool * 40 * 16) / (180 * 80 - 40 * 16);
  console.log(name, JSON.stringify(r), 'poolPx', p.x | 0, p.y | 0, 'pool', pool.toFixed(1), 'ring', ring.toFixed(1), 'frame', box(0, 0, W, H).toFixed(1));
};
await pose('on', true);
await pose('off', false);
await pose('on2', true);
// C's torch off then on again: sample A's light every frame (holder name, intensity) — should fade, not pop
for (const l of [false, true]) {
  await C.evaluate((l) => { window.__escape.game().light = l; }, l);
  const trace = await A.evaluate(async () => {
    const g = window.__escape.game(), out = [], t0 = performance.now();
    while (performance.now() - t0 < 1500) {
      await new Promise((r) => requestAnimationFrame(r));
      const s = g.teamPick.slots.map((p, i) => `${p.holder === undefined ? '-' : g.names.get(p.holder)}${g.teamLights[i].intensity.toFixed(1)}`).join('/');
      if (out.at(-1)?.s !== s) out.push({ t: Math.round(performance.now() - t0), s });
    }
    return out.map((o) => `${o.t}:${o.s}`).join(' ');
  });
  console.log('C', l ? 'on ' : 'off', trace);
}
for (const c of ctxs) await c.close();
for (const b of brs) await b.close();
} finally {
  await Promise.allSettled(brs.map((browser) => browser.close()));
}
