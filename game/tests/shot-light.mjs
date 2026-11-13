// One-off check (not in the gate): night brightness without the torch (#218 光照节奏). L1 at spawn, then L2 (教学楼B 2F);
// a shot every ~10 s at turning yaws → test-results/light-<tag>-<lvl>-<i>.png with the frame mean (0–255) and the share
// of pixels with luma ≥ 25 ("readable"). MOB=1: phone viewport + touch. EVENT=1: also a shot ~3 s into a debug blackout.
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { assertDebugAvailable } from './helpers.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const base = `http://127.0.0.1:${process.env.PORT ?? 4218}`;
const MOB = process.env.MOB === '1', TAG = process.env.TAG ?? 'base', N = +(process.env.N ?? 4), GAP = +(process.env.GAP ?? 10_000);
const W = MOB ? 844 : 960, H = MOB ? 390 : 540;
const ARGS = browserArgs(['--disable-background-timer-throttling', '--disable-renderer-backgrounding']);
const br = await chromium.launch({ args: ARGS });
try {
const ctx = await br.newContext({ baseURL: base, viewport: { width: W, height: H }, ...(MOB ? { hasTouch: true, isMobile: true, deviceScaleFactor: 1 } : {}) });
const P = await ctx.newPage();
P.on('pageerror', (e) => console.log('pageerror', e.message));
await P.goto('/?nodraw');
await P.fill('#name', '甲'); await P.click('#create'); await P.click('#start');
await P.waitForFunction(() => window.__escape.game()?.spawnSynced, null, { timeout: 90_000 });
await assertDebugAvailable(P);
await P.evaluate(() => { window.__escape.debug('safe', 900, 1); window.__escape.debug('safe', 900, 2); });
mkdirSync('test-results', { recursive: true });
const stats = [];
const shot = async (name) => {
  await P.evaluate(() => { const g = window.__escape.game(); g.light = false; g.draw = true; });
  await P.waitForTimeout(1200);
  const file = `test-results/light-${TAG}-${name}.png`;
  await P.screenshot({ path: file });
  await P.evaluate(() => { window.__escape.game().draw = false; });
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  let s = 0, r = 0; for (const v of raw) { s += v; if (v >= 25) r++; }
  const st = await P.evaluate(() => { const g = window.__escape.game(); return { x: +g.pos.x.toFixed(1), z: +g.pos.z.toFixed(1), y: +g.body.y.toFixed(1), dark: +(g.campus.dark ?? 0).toFixed(2), bo: g.campus.blackout }; });
  const o = { name, mean: +(s / raw.length).toFixed(1), readable: +(r / raw.length).toFixed(2), ...st };
  stats.push(o); console.log(JSON.stringify(o));
};
const look = (yaw, pitch = -0.05) => P.evaluate(([y, p]) => { const g = window.__escape.game(); g.input.yaw = y; g.input.pitch = p; }, [yaw, pitch]);
const levels = (process.env.LVL ?? '1,2').split(',');
for (const lvl of levels) {
  if (lvl === '2') {
    await P.evaluate(() => { window.__escape.debug('key', -1); window.__escape.debug('tp', -61, 66); });
    await P.waitForFunction(() => { const g = window.__escape.game(); return g?.campus.blackout && g.body.y > 3; }, null, { timeout: 60_000 });
    await P.evaluate(() => { window.__escape.debug('safe', 900, 1); window.__escape.debug('safe', 900, 2); });
    await P.waitForTimeout(3000);
  }
  if (process.env.AT) { const [x, z] = process.env.AT.split(',').map(Number); await P.evaluate(([x, z]) => window.__escape.debug('tp', x, z), [x, z]); await P.waitForTimeout(800); }
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    await look((i * Math.PI) / 2 + (lvl === '2' ? Math.PI / 2 : 0));
    await shot(`L${lvl}-${i}`);
    const wait = t0 + (i + 1) * GAP - Date.now(); if (wait > 0 && i < N - 1) await P.waitForTimeout(wait);
  }
  if (process.env.EVENT === '1') {
    await P.evaluate(() => window.__escape.debug('power', 8));
    await P.waitForTimeout(3500);
    await shot(`L${lvl}-event`);
  }
}
const m = (a) => +(a.reduce((s, o) => s + o.mean, 0) / a.length).toFixed(1);
for (const lvl of levels) { const a = stats.filter((o) => o.name.startsWith(`L${lvl}-`) && !o.name.endsWith('event')); console.log(`L${lvl} mean ${m(a)} readable ${(a.reduce((s, o) => s + o.readable, 0) / a.length).toFixed(2)}`); }
await ctx.close(); await br.close();
} finally {
  await br.close();
}
