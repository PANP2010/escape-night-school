// One-off probe (not in the gate): 3 separate chromiums on the real ws server (dist-server on PORT); B holds W for 3 s
// while A samples B's rendered position every rAF. Prints median / max per-frame speed and the share of zero-move frames.
// PORT=4179 node tests/probe-walk.mjs   (VIDEO=1 also records A's view to test-results/probe-walk/*.webm, drawn)
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { assertDebugAvailable } from './helpers.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
const base = `http://127.0.0.1:${process.env.PORT ?? 4179}`;
const ARGS = browserArgs(['--disable-background-timer-throttling', '--disable-renderer-backgrounding']);
const VIDEO = !!process.env.VIDEO, HOLD = Number(process.env.HOLD ?? 3000);
// ONE=1: the review's setup (one chromium, 3 contexts: they share the GPU process, so B's frames and sends get uneven)
const ONE = !!process.env.ONE;
const br = ONE ? [await chromium.launch({ args: ARGS })] : await Promise.all([0, 1, 2].map(() => chromium.launch({ args: ARGS })));
try {
mkdirSync('test-results/probe-walk', { recursive: true });
// VW: A's viewport width when recording (swiftshader draws the campus at ~1 fps at 640×360 with 3 browsers up)
const VW = Number(process.env.VW ?? 640), t0 = Date.now();
const ctx = await Promise.all([0, 1, 2].map((i) => (br[i] ?? br[0])).map((b, i) => b.newContext({ baseURL: base, viewport: i === 0 ? { width: VW, height: Math.round(VW * 9 / 16) } : { width: 640, height: 360 },
  ...(VIDEO && i === 0 ? { recordVideo: { dir: 'test-results/probe-walk', size: { width: 1280, height: 720 } } } : {}) })));
const [A, B, C] = await Promise.all(ctx.map((c) => c.newPage()));
await A.addInitScript(() => {
  const W = window.WebSocket; window.__arr = [];
  window.WebSocket = class extends W { constructor(u) { super(u); this.addEventListener('message', (e) => { if (String(e.data).includes('"snap"')) window.__arr.push([performance.now(), JSON.parse(e.data).tick]); }); } };
});
await B.addInitScript(() => {
  const W = window.WebSocket; window.__sent = [];
  window.WebSocket = class extends W { send(d) { if (String(d).includes('"input"')) window.__sent.push(performance.now()); super.send(d); } };
});
await A.goto(VIDEO ? '/' : '/?nodraw'); await B.goto('/?nodraw'); await C.goto('/?nodraw');
for (const [p, n] of [[A, '甲'], [B, '乙'], [C, '丙']]) await p.fill('#name', n);
await A.click('#create');
const code = await A.evaluate(async () => { while (!window.__escape.code) await new Promise((r) => setTimeout(r, 50)); return window.__escape.code; });
for (const p of [B, C]) { await p.fill('#code', code); await p.click('#join'); }
await A.waitForSelector('#wait-members li:nth-child(3)');
await A.evaluate(() => document.getElementById('start').click()); // page.click can hang on 'scheduled navigations' while the scene loads
for (const p of [A, B, C]) await p.waitForFunction(() => window.__escape.game()?.spawnSynced, null, { timeout: 60_000 });
await assertDebugAvailable(B);
const a = await A.evaluate(() => { const g = window.__escape.game(); return { x: g.pos.x, z: g.pos.z }; });
await B.evaluate(([x, z]) => window.__escape.debug('tp', x, z, 0), [a.x, a.z - 4]);
const fps = (p) => p.evaluate(async () => { let fr = 0, on = true; const f = () => { fr++; if (on) requestAnimationFrame(f); }; requestAnimationFrame(f); await new Promise((r) => setTimeout(r, 1000)); on = false; return fr; });
// PR: A's renderer pixel ratio when recording (swiftshader fragment cost scales with pixels)
// wait for steady frame rates (A draws when recording: shader warm-up takes a while, settle for ≥ 2 fps there: swiftshader is fill-rate bound, ~1.6 s per 480×270 frame on 4 cores)
for (let k = 0, f; k < 60 && ((f = await Promise.all([A, B, C].map(fps))), f[0] < (VIDEO ? 2 : 30) || Math.min(f[1], f[2]) < 30); k++) if (VIDEO) console.error('fps', f);
await A.waitForTimeout(1000);
await A.evaluate(() => {
  window.__smp = []; window.__on = true; window.__push = [];
  const g = window.__escape.game();
  const rb = [...g.remotes.values()][0].buf, op = rb.push.bind(rb);
  rb.push = (q) => { window.__push.push([performance.now(), q.t, q.x, q.z]); op(q); };
  const f = (now) => { const r = [...g.remotes.values()][0]; if (r) window.__smp.push([now, r.mesh.position.x, r.mesh.position.z, r.buf.speed?.(), r.clock?.t, r.buf.lastT()]); if (window.__on) requestAnimationFrame(f); };
  requestAnimationFrame(f);
});
const walkAt = (Date.now() - t0) / 1000;
await B.evaluate(() => { const i = window.__escape.game().input; i.yaw = Math.PI; i.press('KeyW'); }); // yaw π: walk toward +z (away from A)
await B.waitForTimeout(HOLD);
await B.evaluate(() => window.__escape.game().input.release('KeyW'));
await A.waitForTimeout(600);
const { smp, arr, push } = await A.evaluate(() => { window.__on = false; return { smp: window.__smp, arr: window.__arr, push: window.__push }; });
const sent = await B.evaluate(() => window.__sent);
for (const c of ctx) await c.close();
for (const b of br) await b.close();
writeFileSync('test-results/probe-walk/data.json', JSON.stringify({ smp, arr, sent, push }));
// the walk window: from the first frame that moved to the last one that moved
const v = [];
for (let k = 1; k < smp.length; k++) v.push({ t: smp[k][0], d: Math.hypot(smp[k][1] - smp[k - 1][1], smp[k][2] - smp[k - 1][2]), dt: (smp[k][0] - smp[k - 1][0]) / 1000 });
const first = v.findIndex((s) => s.d > 1e-4), last = v.length - 1 - [...v].reverse().findIndex((s) => s.d > 1e-4);
const w = v.slice(first, last + 1), sp = w.map((s) => s.d / s.dt).sort((x, y) => x - y);
const dist = w.reduce((s, x) => s + x.d, 0), dur = (w[w.length - 1].t - w[0].t + w[0].dt * 1000) / 1000;
const gaps = (xs) => { const g = []; for (let k = 1; k < xs.length; k++) g.push(xs[k] - xs[k - 1]); g.sort((x, y) => x - y); return g.length ? `med ${g[g.length >> 1].toFixed(1)} max ${g[g.length - 1].toFixed(1)}` : '-'; };
console.log(JSON.stringify({
  walkAt, frames: w.length, avgSpeed: +(dist / dur).toFixed(2), medSpeed: +sp[sp.length >> 1].toFixed(2), maxSpeed: +sp[sp.length - 1].toFixed(2),
  zeroFrames: w.filter((s) => s.d < 1e-4).length, zeroPct: +(100 * w.filter((s) => s.d < 1e-4).length / w.length).toFixed(1),
  frameMs: gaps(smp.map((s) => s[0])), snapGapMs: gaps(arr.map((a) => a[0])), inputGapMs: gaps(sent),
}));
} finally {
  await Promise.allSettled(br.map((browser) => browser.close()));
}
