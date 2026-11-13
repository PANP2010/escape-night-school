// One-off (not in the gate): rubber-band video at LAT ms RTT (default 150, TCP delay proxy). B stands down the corridor past the spawn
// route's end and records every ws message it gets (both pages ?nodraw: swiftshader draws ~1 fps here) while A runs the route
// there and back 5 times. A fresh 1280×720 page R then replays B's stream through a fake WebSocket on a virtual clock (as
// tests/vid-remote.mjs), camera on A, one screenshot per 1/FPS s.  PORT=4179 node tests/video-rubber.mjs → test-results/video-rubber/rubber.mp4
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { assertDebugAvailable } from './helpers.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { delayProxy } from './e2e/delay-proxy.mjs';
const LAT = Number(process.env.LAT ?? 150), FPS = 15, SECS = Number(process.env.SECS ?? 21);
const proxy = await delayProxy('127.0.0.1', Number(process.env.PORT ?? 4179), LAT / 2);
const base = `http://127.0.0.1:${proxy.port}`;
const ARGS = browserArgs(['--disable-background-timer-throttling', '--disable-renderer-backgrounding']);
const [bA, bB] = await Promise.all([0, 1].map(() => chromium.launch({ args: ARGS })));
try {
const [cA, cB] = await Promise.all([bA, bB].map((b) => b.newContext({ baseURL: base, viewport: { width: 400, height: 260 } })));
const [A, B] = await Promise.all([cA.newPage(), cB.newPage()]);
await B.addInitScript(() => {
  const W = window.WebSocket; window.__rec = [];
  window.WebSocket = class extends W { constructor(u) { super(u); this.addEventListener('message', (e) => window.__rec.push([performance.now(), e.data])); } };
});
await A.goto('/?nodraw'); await B.goto('/?nodraw');
await A.fill('#name', '甲'); await B.fill('#name', '乙');
await A.click('#create');
const code = await A.evaluate(async () => { while (!window.__escape.code) await new Promise((r) => setTimeout(r, 50)); return window.__escape.code; });
await B.fill('#code', code); await B.click('#join');
await A.waitForSelector('#wait-members li:nth-child(2)');
await A.evaluate(() => document.getElementById('start').click());
for (const p of [A, B]) await p.waitForFunction(() => window.__escape.game()?.spawnSynced, null, { timeout: 60_000 });
await assertDebugAvailable(A);
const aId = await A.evaluate(() => window.__escape.game().myId);
const sr = await A.evaluate(() => window.__escape.spawnRoute());
const [p0, p1] = sr, L = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
// B stands on the route line 2.5 m past its far end (down the same corridor), looking back at A
const side = [p1[0] + ((p1[0] - p0[0]) / L) * 2.5, p1[1] + ((p1[1] - p0[1]) / L) * 2.5];
await A.evaluate(([x, z]) => window.__escape.debug('tp', x, z, 0), p0);
await B.evaluate(([x, z]) => window.__escape.debug('tp', x, z, 0), side);
const fps = (p) => p.evaluate(async () => { let fr = 0, on = true; const f = () => { fr++; if (on) requestAnimationFrame(f); }; requestAnimationFrame(f); await new Promise((r) => setTimeout(r, 1000)); on = false; return fr; });
for (let k = 0; k < 60 && Math.min(...(await Promise.all([A, B].map(fps)))) < 30; k++);
await A.waitForTimeout(1000);
const mark = await B.evaluate(() => performance.now());
const run = async (route) => {
  await A.evaluate((r) => window.__escape.autopilot(r), route);
  await A.waitForFunction(() => window.__escape.game().autopilotDone, null, { timeout: 60_000, polling: 200 });
};
await A.evaluate(() => window.__escape.game().input.press('ShiftLeft'));
const t0 = Date.now();
for (let k = 0; k < 5; k++) await run(k % 2 ? [...sr].reverse() : sr);
const runS = (Date.now() - t0) / 1000;
await A.waitForTimeout(1000);
const corr = await Promise.all([A, B].map((p) => p.evaluate(() => window.__escape.game().corrections)));
const rec = await B.evaluate(() => window.__rec);
await cA.close(); await cB.close(); await bA.close(); proxy.close();
console.log('recorded', rec.length, 'msgs; run s', runS, 'corrections', corr);

const cR = await bB.newContext({ baseURL: base.replace(`:${proxy.port}`, `:${process.env.PORT ?? 4179}`), viewport: { width: 1280, height: 720 } });
const R = await cR.newPage();
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
while ((await R.evaluate(() => window.__step(1000 / 15))) < mark - 500) await R.waitForTimeout(5);
// camera on A's remote mesh (yaw convention as Game.autopilot: forward = (−sin, −cos))
const look = (id) => { const g = window.__escape.game(), r = g.remotes.get(id); if (r) { g.input.yaw = Math.atan2(g.pos.x - r.mesh.position.x, g.pos.z - r.mesh.position.z); g.input.pitch = -0.12; } };
await R.evaluate(([id, f]) => { (0, eval)(`(${f})`)(id); window.__escape.game().draw = true; }, [aId, look.toString()]);
for (let k = 0; k < 4; k++) await R.evaluate(() => window.__step(0));
const dir = 'test-results/video-rubber/frames';
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
let maxJ = 0, px;
for (let f = 0; f < FPS * SECS; f++) {
  const pos = await R.evaluate(([ms, id, fs]) => { (0, eval)(`(${fs})`)(id); window.__step(ms); const m = window.__escape.game().remotes.get(id).mesh.position; return [m.x, m.z]; }, [1000 / FPS, aId, look.toString()]);
  if (px) maxJ = Math.max(maxJ, Math.hypot(pos[0] - px[0], pos[1] - px[1])); px = pos;
  await R.screenshot({ path: `${dir}/${String(f).padStart(4, '0')}.png` });
}
await cR.close(); await bB.close();
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', `${dir}/%04d.png`, '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', 'test-results/video-rubber/rubber.mp4']);
console.log('test-results/video-rubber/rubber.mp4 max per-frame (1/15 s) remote step', maxJ.toFixed(3));
} finally {
  proxy?.close();
  await Promise.allSettled([bA, bB].map((browser) => browser.close()));
}
