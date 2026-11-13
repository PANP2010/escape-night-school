// One-off probe (not in the gate): 3 separate chromiums on the real ws server (dist-server on PORT); B summons a mob
// (MOB=warden: 角色074 chases B from D m ahead; MOB=monitor: the 值日生 hunts from D m ahead, everyone faces away so it is
// never watched) while A samples the mob's rendered position every rAF. Prints median / max per-frame speed and the
// share of zero-move frames, same method as probe-walk.mjs.   PORT=4179 MOB=warden node tests/probe-mob.mjs
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { assertDebugAvailable } from './helpers.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
const base = `http://127.0.0.1:${process.env.PORT ?? 4179}`;
const ARGS = browserArgs(['--disable-background-timer-throttling', '--disable-renderer-backgrounding']);
const MOB = process.env.MOB ?? 'warden', D = Number(process.env.D ?? 12), HOLD = Number(process.env.HOLD ?? 4000);
const ID = MOB === 'warden' ? 1 : 2;
const br = await Promise.all([0, 1, 2].map(() => chromium.launch({ args: ARGS })));
try {
mkdirSync('test-results/probe-mob', { recursive: true });
const t0 = Date.now();
const ctx = await Promise.all(br.map((b) => b.newContext({ baseURL: base, viewport: { width: 640, height: 360 } })));
const [A, B, C] = await Promise.all(ctx.map((c) => c.newPage()));
await A.addInitScript(() => {
  const W = window.WebSocket; window.__arr = [];
  window.WebSocket = class extends W { constructor(u) { super(u); this.addEventListener('message', (e) => { if (String(e.data).includes('"snap"')) window.__arr.push([performance.now(), JSON.parse(e.data).tick]); }); } };
});
for (const p of [A, B, C]) await p.goto('/?nodraw');
for (const [p, n] of [[A, '甲'], [B, '乙'], [C, '丙']]) await p.fill('#name', n);
await A.click('#create');
const code = await A.evaluate(async () => { while (!window.__escape.code) await new Promise((r) => setTimeout(r, 50)); return window.__escape.code; });
for (const p of [B, C]) { await p.fill('#code', code); await p.click('#join'); }
await A.waitForSelector('#wait-members li:nth-child(3)');
await A.evaluate(() => document.getElementById('start').click());
for (const p of [A, B, C]) await p.waitForFunction(() => window.__escape.game()?.spawnSynced, null, { timeout: 60_000 });
await assertDebugAvailable(B);
const fps = (p) => p.evaluate(async () => { let fr = 0, on = true; const f = () => { fr++; if (on) requestAnimationFrame(f); }; requestAnimationFrame(f); await new Promise((r) => setTimeout(r, 1000)); on = false; return fr; });
for (let k = 0, f; k < 60 && ((f = await Promise.all([A, B, C].map(fps))), Math.min(...f) < 30); k++);
if (MOB === 'monitor') { // the 值日生 lives on 第 2 关: stairwell key + the exit zone, then everyone near B on the 2F corridor
  await B.evaluate(() => window.__escape.debug('key', -1)); // the level only advances once everyone stands in the exit zone
  const exit = await B.evaluate(() => window.__escape.game().level.exit);
  // the exit circle overlaps the stair flight: stand on its landing side (in-exit needs |y - exit.y| < 1.5), as x-multi does
  for (const [i, p] of [A, B, C].entries()) await p.evaluate(([e, i]) => window.__escape.debug('tp', e.x + 2, e.z + (i - 1) * 0.8, Math.round(e.y / 3.6)), [exit, i]);
  for (const p of [A, B, C]) await p.waitForFunction(() => window.__escape.game()?.level.index === 1, null, { timeout: 60_000 });
  await A.waitForTimeout(4000);
  for (const [p, x] of [[A, 38], [B, 40], [C, 42]]) await p.evaluate((x) => window.__escape.debug('tp', x, 84.2, 1), x);
  await A.waitForTimeout(1000);
}
// everyone looks the same way (yaw 0 = −z); the mob appears D m ahead of B and walks back toward B, i.e. behind A and C too
// JasmineFx (fx.ts) swaps its grain image every 3rd frame while 角色074 is within 15 m; since #182 the 32 frames are
// encoded once from a CPU canvas (was a GPU readback of seconds per toDataURL), stubbed by default, FX=1 keeps it
const NOFX = !process.env.FX;
for (const p of [A, B, C]) await p.evaluate((nofx) => { const g = window.__escape.game(); g.input.yaw = 0; if (nofx) g.jasmine.update = () => {}; }, NOFX);
await A.waitForTimeout(1000);
await A.evaluate((id) => {
  window.__smp = []; window.__on = true; window.__push = [];
  const g = window.__escape.game();
  const hook = (o) => { if (!o || o.buf.__h) return; const op = o.buf.push.bind(o.buf); o.buf.__h = 1; o.buf.push = (q) => { window.__push.push([performance.now(), q.t, q.x, q.z]); op(q); }; };
  const f = (now) => { const o = g.mobs.byId.get(id); hook(o); if (o) window.__smp.push([now, o.mesh.position.x, o.mesh.position.z, o.anim, o.buf.lastT()]); if (window.__on) requestAnimationFrame(f); };
  requestAnimationFrame(f);
}, ID);
const at = (Date.now() - t0) / 1000;
const prof = process.env.PROF ? await ctx[0].newCDPSession(A) : null;
if (prof) { await prof.send('Profiler.enable'); await prof.send('Profiler.start'); }
await B.evaluate(([m, d]) => window.__escape.debug(m, d), [MOB, D]);
if (MOB === 'monitor') for (const p of [A, B, C]) await p.evaluate(() => { window.__escape.game().input.yaw = Math.PI; }); // turn away: unwatched
await B.waitForTimeout(HOLD);
if (prof) { // top self time (ms) on A's main thread while the mob moves
  const { profile: pf } = await prof.send('Profiler.stop'), self = new Map(), byId = new Map(pf.nodes.map((n) => [n.id, n]));
  for (let k = 0; k < pf.samples.length; k++) { const n = byId.get(pf.samples[k]), key = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`; self.set(key, (self.get(key) ?? 0) + (pf.timeDeltas[k] ?? 0) / 1000); }
  console.error([...self].sort((x, y) => y[1] - x[1]).slice(0, 15).map(([k, v]) => `${v.toFixed(0).padStart(6)} ${k}`).join('\n'));
}
const { smp, arr, push } = await A.evaluate(() => { window.__on = false; return { smp: window.__smp, arr: window.__arr, push: window.__push }; });
for (const c of ctx) await c.close();
for (const b of br) await b.close();
writeFileSync(`test-results/probe-mob/${MOB}.json`, JSON.stringify({ smp, arr, push }));
const v = [];
for (let k = 1; k < smp.length; k++) v.push({ t: smp[k][0], d: Math.hypot(smp[k][1] - smp[k - 1][1], smp[k][2] - smp[k - 1][2]), dt: (smp[k][0] - smp[k - 1][0]) / 1000, anim: smp[k][3] });
// the move window: the summon teleports the mob (one big jump), so start after the largest step
const j0 = v.reduce((j, s, k) => (s.d > v[j].d ? k : j), 0);
let jump = j0; // the 2-tick box filter smears that teleport over ~8 frames: skip them all (> 25 m/s, no mob runs that fast)
while (jump + 1 < v.length && v[jump + 1].d / v[jump + 1].dt > 25) jump++;
const rest = v.slice(jump + 1), first = rest.findIndex((s) => s.d > 1e-4), last = rest.length - 1 - [...rest].reverse().findIndex((s) => s.d > 1e-4);
const w = rest.slice(first, last + 1), sp = w.map((s) => s.d / s.dt).sort((x, y) => x - y);
const dist = w.reduce((s, x) => s + x.d, 0), dur = (w[w.length - 1].t - w[0].t + w[0].dt * 1000) / 1000;
const gaps = (xs) => { const g = []; for (let k = 1; k < xs.length; k++) g.push(xs[k] - xs[k - 1]); g.sort((x, y) => x - y); return g.length ? `med ${g[g.length >> 1].toFixed(1)} max ${g[g.length - 1].toFixed(1)}` : '-'; };
console.log(JSON.stringify({
  mob: MOB, at, summonJump: +v[j0].d.toFixed(2), summonFrames: jump - j0 + 1, frames: w.length, avgSpeed: +(dist / dur).toFixed(2), medSpeed: +sp[sp.length >> 1].toFixed(2),
  p95Speed: +sp[Math.floor(sp.length * 0.95)].toFixed(2), maxSpeed: +sp[sp.length - 1].toFixed(2),
  zeroFrames: w.filter((s) => s.d < 1e-4).length, zeroPct: +(100 * w.filter((s) => s.d < 1e-4).length / w.length).toFixed(1),
  anims: [...new Set(w.map((s) => s.anim))], frameMs: gaps(smp.map((s) => s[0])), snapGapMs: gaps(arr.map((a) => a[0])),
}));
} finally {
  await Promise.allSettled(br.map((browser) => browser.close()));
}
