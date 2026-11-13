// One-off check (not in the gate): how a teammate's torch looks from A over the real ws server (dist-server on PORT).
// B stands 3.5 m in front of A, light on, side-on and then facing away (and light off for a baseline); A draws a frame
// per pose → test-results/torch-{side,away,off}.png, plus the mean brightness of the floor patch ahead of B.
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { assertDebugAvailable, placeNear } from './helpers.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const base = `http://127.0.0.1:${process.env.PORT ?? 4198}`;
const W = 640, H = 360;
const ARGS = browserArgs(['--disable-background-timer-throttling', '--disable-renderer-backgrounding']);
const ba = await chromium.launch({ args: ARGS }), bb = await chromium.launch({ args: ARGS });
try {
const ctxA = await ba.newContext({ baseURL: base, viewport: { width: W, height: H } });
const ctxB = await bb.newContext({ baseURL: base, viewport: { width: 400, height: 260 } });
const A = await ctxA.newPage(), B = await ctxB.newPage();
await A.goto('/?nodraw&steady'); await B.goto('/?nodraw&steady'); // steady: no 日光灯 flicker in the shots (#190)
await A.fill('#name', '甲'); await B.fill('#name', '乙');
await A.click('#create');
const code = await A.evaluate(async () => { while (!window.__escape.code) await new Promise((r) => setTimeout(r, 50)); return window.__escape.code; });
await B.fill('#code', code); await B.click('#join');
await A.waitForSelector('#wait-members li:nth-child(2)');
await A.click('#start');
for (const p of [A, B]) await p.waitForFunction(() => window.__escape.game()?.spawnSynced, null, { timeout: 60_000 });
await assertDebugAvailable(A);
const placeAt = async (page, x, z) => {
  const origin = await page.evaluate(() => { const g = window.__escape.game(); return { x: g.pos.x, z: g.pos.z }; });
  return placeNear(page, x - origin.x, z - origin.z);
};
const fps = (p) => p.evaluate(async () => { let fr = 0, on = true; const f = () => { fr++; if (on) requestAnimationFrame(f); }; requestAnimationFrame(f); await new Promise((r) => setTimeout(r, 1000)); on = false; return fr; });
for (let k = 0; k < 60 && Math.min(...(await Promise.all([A, B].map(fps)))) < 30; k++);
const [ax, az] = (process.env.AT ?? '').split(',').map(Number);
if (process.env.AT) await placeAt(A, ax, az);
await A.waitForTimeout(800);
const a = await A.evaluate(() => { const g = window.__escape.game(); g.input.yaw = 0; g.input.pitch = -0.12; return { x: g.pos.x, z: g.pos.z }; });
await placeAt(B, a.x, a.z - 3.5);
console.log('A at', a);
mkdirSync('test-results', { recursive: true });
let spotPx; // where B's spot lands on A's screen (from the first lit facing-away pose), measured in every pose
const pose = async (name, yaw, light, aLight = true) => {
  await B.evaluate(([y, l]) => { const g = window.__escape.game(); g.input.yaw = y; g.input.pitch = -0.35; g.light = l; }, [yaw, light]);
  await A.evaluate((l) => { window.__escape.game().light = l; }, aLight);
  await A.waitForTimeout(1500);
  const r = await A.evaluate(() => { const g = window.__escape.game(); g.draw = true; const r = [...g.remotes.values()][0]; return { b: [+r.mesh.position.x.toFixed(2), +r.mesh.position.z.toFixed(2), +r.mesh.rotation.y.toFixed(2)], f: r.f }; });
  await A.waitForTimeout(1500);
  const sp = await A.evaluate(() => { const g = window.__escape.game(); const st = [...g.remotes.values()][0].st; if (!st.spot.visible) return null;
    const v = st.spot.position.clone().setFromMatrixPosition(st.spot.matrixWorld); const w = v.clone(); v.project(g.camera); return { x: (v.x + 1) / 2 * innerWidth, y: (1 - v.y) / 2 * innerHeight, w: [+w.x.toFixed(2), +w.y.toFixed(2), +w.z.toFixed(2)] }; });
  if (sp && !spotPx) spotPx = sp;
  const file = `test-results/torch-${name}.png`;
  await A.screenshot({ path: file });
  await A.evaluate(() => { window.__escape.game().draw = false; });
  // floor ahead of B (B faces away from A: the patch just beyond B, lower-middle of the frame)
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  const box = (...q) => { const [x0, y0, x1, y1] = q.map(Math.round); let s = 0, n = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += raw[y * W + x]; n++; } return +(s / n).toFixed(1); };
  console.log(name, JSON.stringify(r), 'frame', box(0, 0, W, H), 'centre', box(W * 0.3, H * 0.35, W * 0.7, H * 0.75), 'upper', box(W * 0.3, H * 0.15, W * 0.7, H * 0.45),
    'spot', sp && sp.w, spotPx ? box(spotPx.x - 24, spotPx.y - 12, spotPx.x + 24, spotPx.y + 12) : '-');
};
await pose('away', 0, true);
await pose('off', 0, false);
await pose('side', -Math.PI / 2, true);
await pose('away-dark', 0, true, false); // A's own torch off: only B's light
await pose('off-dark', 0, false, false);
await ctxA.close(); await ctxB.close(); await ba.close(); await bb.close();
} finally {
  await Promise.allSettled([ba, bb].map((browser) => browser.close()));
}
