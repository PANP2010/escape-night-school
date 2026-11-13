// One-off motion video (not in the gate): A watches B walk / strafe / run / turn / crouch over the real ws server (dist-server
// on PORT). swiftshader draws ~1 fps here, so A runs without drawing and records every ws message with its arrival time; a
// fresh page R then replays that stream through a fake WebSocket on a virtual clock stepped 1/FPS s per frame, one screenshot
// each, so R's real interpolation / animation code runs at an even FPS. node tests/vid-remote.mjs → test-results/vid/remote.mp4
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { assertDebugAvailable } from './helpers.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
const base = `http://127.0.0.1:${process.env.PORT ?? 4198}`;
const FPS = 15, SECS = Number(process.env.SECS ?? 18);
const ARGS = browserArgs(['--disable-background-timer-throttling', '--disable-renderer-backgrounding']);
const ba = await chromium.launch({ args: ARGS }), bb = await chromium.launch({ args: ARGS });
try {
const ctxA = await ba.newContext({ baseURL: base, viewport: { width: 400, height: 260 } });
const ctxB = await bb.newContext({ baseURL: base, viewport: { width: 400, height: 260 } });
const A = await ctxA.newPage(), B = await ctxB.newPage();
await A.addInitScript(() => {
  const W = window.WebSocket; window.__rec = [];
  window.WebSocket = class extends W { constructor(u) { super(u); this.addEventListener('message', (e) => window.__rec.push([performance.now(), e.data])); } };
});
await A.goto('/?nodraw'); await B.goto('/?nodraw');
await A.fill('#name', '甲'); await B.fill('#name', '乙');
await A.click('#create');
const code = await A.evaluate(async () => { while (!window.__escape.code) await new Promise((r) => setTimeout(r, 50)); return window.__escape.code; });
await B.fill('#code', code); await B.click('#join');
await A.waitForSelector('#wait-members li:nth-child(2)');
await A.click('#start');
for (const p of [A, B]) await p.waitForFunction(() => window.__escape.game()?.spawnSynced, null, { timeout: 60_000 });
await assertDebugAvailable(B);
const a = await A.evaluate(() => { const g = window.__escape.game(); return { x: g.pos.x, z: g.pos.z }; });
await B.evaluate(([x, z]) => window.__escape.debug('tp', x, z, 0), [a.x, a.z - 4]);
// the first seconds after spawn are the campus build (0 fps here): wait until both clients run, or B's moves never happen
const fps = (p) => p.evaluate(async () => { let fr = 0, on = true; const f = () => { fr++; if (on) requestAnimationFrame(f); }; requestAnimationFrame(f); await new Promise((r) => setTimeout(r, 1000)); on = false; return fr; });
for (let k = 0; k < 60 && Math.min(...(await Promise.all([A, B].map(fps)))) < 30; k++);
// WARM=s idles first: server tick drift (~1.3%) piles up for that long before the filmed moves (SnapClock regression)
await A.waitForTimeout(500 + Number(process.env.WARM ?? 0) * 1000);
const mark = await A.evaluate(() => performance.now());
const hold = async (keys, ms, yaw) => {
  await B.evaluate(([k, y]) => { const i = window.__escape.game().input; if (y !== undefined) i.yaw = y; for (const c of k) i.press(c); }, [keys, yaw]);
  await B.waitForTimeout(ms);
  await B.evaluate((k) => { const i = window.__escape.game().input; for (const c of k) i.release(c); }, keys);
};
const at = (s) => console.log(((Date.now() - t0) / 1000 + 1).toFixed(1).padStart(5), s);
const t0 = Date.now();
at('strafe right'); await hold(['KeyD'], 2000, 0);
at('strafe left'); await hold(['KeyA'], 2000, 0);
at('idle'); await B.waitForTimeout(1000);
at('run, facing +x'); await hold(['KeyW', 'ShiftLeft'], 1500, -Math.PI / 2);
at('turn round + walk back'); await hold(['KeyW'], 2500, Math.PI / 2);
at('crouch-strafe'); await hold(['KeyC', 'KeyD'], 2500, 0);
at('turn in place x4'); for (const y of [Math.PI / 2, Math.PI, -Math.PI / 2, 0]) { await B.evaluate((v) => { window.__escape.game().input.yaw = v; }, y); await B.waitForTimeout(700); }
at('end'); await A.waitForTimeout(1500);
const rec = await A.evaluate(() => window.__rec);
await ctxA.close(); await ctxB.close(); await bb.close();
console.log('recorded', rec.length, 'messages');
if (process.env.DUMP) { const { writeFileSync } = await import('node:fs'); writeFileSync('test-results/vid/rec.json', JSON.stringify({ mark, rec })); }

// replay into R, which plays A's part (same id, same messages) and looks where A looked
const ctxR = await ba.newContext({ baseURL: base, viewport: { width: 640, height: 360 } });
const R = await ctxR.newPage();
await R.addInitScript((rec) => {
  let vnow = rec[0][0] - 50, i = 0;
  performance.now = () => vnow;
  const cbs = [], socks = [];
  window.requestAnimationFrame = (cb) => cbs.push(cb);
  class FakeWS { constructor() { this.readyState = 0; socks.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); } send() {} close() {} }
  FakeWS.OPEN = 1; window.WebSocket = FakeWS;
  window.__step = (ms) => {
    vnow += ms;
    while (i < rec.length && rec[i][0] <= vnow) { const data = rec[i++][1]; for (const s of socks) s.onmessage?.({ data }); }
    for (const f of cbs.splice(0)) f(vnow);
    return vnow;
  };
}, rec);
await R.goto('/?nodraw');
// pre-roll (no draw) up to 1 s before B starts moving
while ((await R.evaluate(() => window.__step(1000 / 15))) < mark - 1000) await R.waitForTimeout(5);
await R.evaluate(() => { const g = window.__escape.game(); g.input.yaw = 0; g.input.pitch = -0.08; g.draw = true; });
for (let k = 0; k < 4; k++) await R.evaluate(() => window.__step(0)); // compile shaders on a frozen clock
const dir = 'test-results/vid/frames';
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
for (let f = 0; f < FPS * SECS; f++) {
  const pose = await R.evaluate((ms) => { const t = window.__step(ms), r = [...window.__escape.game().remotes.values()][0]; return [Math.round(t), +r.mesh.position.x.toFixed(2), +r.mesh.position.z.toFixed(2), +r.mesh.rotation.y.toFixed(2)]; }, 1000 / FPS);
  if (process.env.DUMP && f % 5 === 0) console.log('R', f, JSON.stringify(pose));
  await R.screenshot({ path: `${dir}/${String(f).padStart(4, '0')}.png` });
}
await ctxR.close(); await ba.close();
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', `${dir}/%04d.png`, '-vf', 'scale=960:-2', '-r', '24', '-c:v', 'libx264', '-crf', '28', '-pix_fmt', 'yuv420p', 'test-results/vid/remote.mp4']);
console.log('test-results/vid/remote.mp4');
} finally {
  await Promise.allSettled([ba, bb].map((browser) => browser.close()));
}
