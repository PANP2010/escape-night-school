// One-off probe (not in the gate): 3 chromiums on the real ws server (dist-server on PORT); each page logs 角色074's rendered
// position every rAF against Date.now() (same machine, one wall clock), then the three tracks are compared at 0.5 s marks:
// first while he stands (idle, before any summon), then while he chases B.   PORT=4179 node tests/probe-mob-sync.mjs
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { assertDebugAvailable } from './helpers.mjs';
const base = `http://127.0.0.1:${process.env.PORT ?? 4179}`;
const ARGS = browserArgs(['--disable-background-timer-throttling', '--disable-renderer-backgrounding', ...(process.env.XA ? process.env.XA.split(' ') : [])]);
const br = await Promise.all([0, 1, 2].map(() => chromium.launch({ args: ARGS })));
try {
const VP = [{ width: 960, height: 540 }, { width: 480, height: 270 }, { width: 480, height: 270 }];
const ctx = await Promise.all(br.map((b, i) => b.newContext({ baseURL: base, viewport: VP[i] })));
const pages = await Promise.all(ctx.map((c) => c.newPage()));
for (const p of pages) await p.addInitScript(() => { window.__gaps = []; let l = 0; const f = (t) => { if (l && t - l > 300) window.__gaps.push([Math.round(l), Math.round(t), document.getElementById('hud')?.className ?? '', (document.querySelector('.overlay:not(.hidden), [id$=screen]:not(.hidden)') || {}).id ?? '']); l = t; requestAnimationFrame(f); }; requestAnimationFrame(f); });
const T0 = Date.now(); const mark = {}; const M = (k) => { mark[k] = Date.now() - T0; };
const [A, B, C] = pages;
for (const p of pages) await p.goto(process.env.Q ?? '/?nodraw&steady');
for (const [p, n] of [[A, '甲'], [B, '乙'], [C, '丙']]) await p.fill('#name', n);
M('goto'); await A.click('#create');
const code = await A.evaluate(async () => { while (!window.__escape.code) await new Promise((r) => setTimeout(r, 50)); return window.__escape.code; });
for (const p of [B, C]) { await p.fill('#code', code); await p.click('#join'); }
await A.waitForSelector('#wait-members li:nth-child(3)');
await A.evaluate(() => document.getElementById('start').click());
for (const p of pages) await p.waitForFunction(() => window.__escape.game()?.spawnSynced, null, { timeout: 60_000 });
await assertDebugAvailable(B);
M('synced'); const anims = await A.evaluate(async () => { const out = []; for (let k = 0; k < 6; k++) { out.push(document.getAnimations().map((a) => `${a.effect?.target?.id || a.effect?.target?.className}:${a.animationName ?? a.constructor.name}:${a.playState}`).join(',')); await new Promise((r) => setTimeout(r, 500)); } return out; }); console.log('anims', anims); await A.waitForTimeout(Number(process.env.SETTLE ?? 3000)); M('settled');
for (const p of pages) await p.evaluate(() => {
  window.__trk = []; window.__on = true;
  const g = window.__escape.game();
  const f = () => { const o = g.mobs.byId.get(1); if (o) { const l = o.buf.s?.[o.buf.s.length - 1] ?? null; window.__trk.push([Date.now(), o.mesh.position.x, o.mesh.position.z, o.anim, o.clock.t, o.buf.lastT(), l && l.x, l && l.z]); } if (window.__on) requestAnimationFrame(f); };
  requestAnimationFrame(f);
  window.__iv = []; const h = setInterval(() => { const o = g.mobs.byId.get(1); window.__iv.push([Date.now(), g.last, o ? 1 : 0, document.visibilityState]); if (!window.__on) clearInterval(h); }, 250);
});
const span = async (ms) => { const a = Date.now(); await A.waitForTimeout(ms); return [a, Date.now()]; };
const idle = await span(5500);
// review-style: query the three clients one after another (each evaluate is a round trip)
const seq = [];
for (let k = 0; k < 4; k++) { const row = []; for (const p of pages) row.push(await p.evaluate(() => { const o = window.__escape.game().mobs.byId.get(1); return [Date.now(), o.mesh.position.x, o.mesh.position.z, o.anim]; })); seq.push(row); }
await B.waitForFunction(() => window.__escape.game().mobs.byId.get(1)?.anim !== 'catch', null, { timeout: 30_000 });
await B.evaluate((d) => window.__escape.debug('warden', d), Number(process.env.D ?? 20));
await A.waitForTimeout(300);
const chase = await span(5200);
const trk = await Promise.all(pages.map((p) => p.evaluate(() => { window.__on = false; return window.__trk; })));
const gaps = await Promise.all(pages.map((p) => p.evaluate(() => [performance.timeOrigin, window.__gaps])));
const iv = await Promise.all(pages.map((p) => p.evaluate(() => window.__iv)));
for (const c of ctx) await c.close();
for (const b of br) await b.close();
for (const row of seq) console.log('seq', row.map((x) => `[${x[1].toFixed(2)},${x[2].toFixed(2)} ${x[3]} +${x[0] - row[0][0]}ms]`).join(' '));
console.log('marks', mark, 'idle', idle[0] - T0, 'chase', chase[0] - T0); gaps.forEach(([o, g], i) => console.log('gaps', i, JSON.stringify(g.map(([a, b, h, s]) => [Math.round(o + a - T0), b - a, h, s]))));   iv.forEach((v, i) => console.log('iv', i, v.filter((_, k) => k % 4 === 0).map((r) => `${r[0] - idle[0]}:${Math.round(r[1])}:${r[2]}:${r[3][0]}`).join(' '))); for (const tr of trk) { const ts = tr.map((r) => r[0]); let gap = 0; for (let i = 1; i < ts.length; i++) gap = Math.max(gap, ts[i] - ts[i - 1]); console.log('trk', tr.length, ts[0], ts.at(-1), 'maxgap', gap); }
const at = (tr, t) => { let k = tr.findIndex((r) => r[0] >= t); if (k < 0) k = tr.length - 1; return tr[k]; };
for (const [name, [a]] of [['idle', idle], ['chase', chase]]) {
  let worst = 0;
  for (let t = a; t <= a + 5000; t += 500) {
    const r = trk.map((tr) => at(tr, t));
    let d = 0; for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) d = Math.max(d, Math.hypot(r[i][1] - r[j][1], r[i][2] - r[j][2]));
    worst = Math.max(worst, d);
    console.log(name, ((t - a) / 1000).toFixed(1), 'spread', d.toFixed(2), r.map((x) => `[${x[1].toFixed(2)},${x[2].toFixed(2)} ${x[3]} raw ${x[6]?.toFixed(2)},${x[7]?.toFixed(2)} lag ${(x[5] - x[4]).toFixed(0)}]`).join(' '));
  }
  console.log(name, 'WORST', worst.toFixed(2));
}
} finally {
  await Promise.allSettled(br.map((browser) => browser.close()));
}
