// One-off probe (not in the gate): one chromium (swiftshader, 1280×720, drawing on) alone in a room on the real ws
// server (dist-server on PORT). Samples fps before the summon, then summons 角色074 D m ahead and logs every rAF's
// frame time with his distance: first frame after he appears, fps within 6 m / 6–14 m, and the shader program count.
//   PORT=4179 D=14 HOLD=10000 node tests/probe-fps.mjs
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { assertDebugAvailable } from './helpers.mjs';
import { mkdirSync } from 'node:fs';
const base = `http://127.0.0.1:${process.env.PORT ?? 4179}`;
const ARGS = browserArgs(['--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']);
const D = Number(process.env.D ?? 14), HOLD = Number(process.env.HOLD ?? 10000), MOB = process.env.MOB ?? 'warden';
const ID = MOB === 'warden' ? 1 : 2;
mkdirSync('test-results/probe-fps', { recursive: true });
const br = await chromium.launch({ args: ARGS });
const ctx = await br.newContext({ baseURL: base, viewport: { width: 1280, height: 720 } });
const A = await ctx.newPage();
try {
await A.goto('/');
await A.fill('#name', '甲');
await A.click('#create');
await A.waitForFunction(() => window.__escape.code);
await A.evaluate(() => document.getElementById('start').click());
await A.waitForFunction(() => window.__escape.game()?.spawnSynced, null, { timeout: 60_000 });
await assertDebugAvailable(A);
await A.evaluate((pr) => { const g = window.__escape.game(); g.input.yaw = 0; if (pr) g.renderer.setPixelRatio(pr); }, Number(process.env.PR ?? 0)); // PR=0.25: a cheap frame (swiftshader fill ~1.8 s/frame at 1), so a link stall stands out
const warmT = Date.now(); // Mobs.prewarm (level load) compiling the figures' shaders: wait it out before sampling
await A.evaluate(() => { const g = window.__escape.game(); return g.mobs.prewarm?.(g.renderer, g.camera); });
console.error('prewarm', Date.now() - warmT, 'ms');
const fps = () => A.evaluate(async () => { let fr = 0, on = true; const f = () => { fr++; if (on) requestAnimationFrame(f); }; requestAnimationFrame(f); await new Promise((r) => setTimeout(r, 2000)); on = false; return fr / 2; });
const warm = []; // until it settles: 2 s windows, at most WARM of them
for (let k = 0; k < Number(process.env.WARM ?? 8); k++) { warm.push(await fps()); if (warm.length >= 3 && Math.abs(warm.at(-1) - warm.at(-2)) < 0.15 * warm.at(-1) + 0.5) break; }
console.error('warm fps', warm.join(' '));
const before = warm.at(-1);
const progBefore = await A.evaluate(() => window.__escape.game().renderer.info.programs.length);
await A.evaluate(([id, mob, d]) => {
  const g = window.__escape.game(); window.__smp = []; window.__on = true;
  let last = performance.now();
  const f = (now) => {
    const o = g.mobs.byId.get(id), c = g.camera.position;
    window.__smp.push([now - last, o ? Math.hypot(o.mesh.position.x - c.x, o.mesh.position.z - c.z) : -1, g.renderer.info.programs.length]);
    last = now; if (window.__on) requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
  window.__escape.debug(mob, d);
}, [ID, MOB, D]);
await A.waitForTimeout(HOLD);
const smp = await A.evaluate(() => { window.__on = false; return window.__smp; });
await A.screenshot({ path: `test-results/probe-fps/${process.env.TAG ?? 'after'}.png`, timeout: 120_000 });
await br.close();
const seen = smp.findIndex((s) => s[1] >= 0);
const firstMs = seen >= 0 && seen + 1 < smp.length ? smp[seen + 1][0] : -1; // the frame that first drew him
const rate = (xs) => (xs.length ? +(1000 * xs.length / xs.reduce((s, x) => s + x[0], 0)).toFixed(1) : null);
const live = smp.slice(seen + 2);
console.log(JSON.stringify({
  mob: MOB, before, firstMs: +firstMs.toFixed(0), near6: rate(live.filter((s) => s[1] < 6)), mid14: rate(live.filter((s) => s[1] >= 6 && s[1] < 14)),
  far: rate(live.filter((s) => s[1] >= 14)), maxMs: +Math.max(...live.map((s) => s[0])).toFixed(0), frames: live.length,
  minDist: +Math.min(...live.map((s) => s[1])).toFixed(1), programs: [progBefore, smp[smp.length - 1]?.[2]],
}));
} finally { await br.close(); }
