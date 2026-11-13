// Equivalent validation of tests/e2e/x-bounds.spec.ts (SHA-256 2684ec96c1f0279b56e276e4890ad7824f7bb08e0d5ee236997087319dc520e8).
// All assertions, routes and views are retained. Two contexts share the one fixture browser session.
// The original spec itself is not executed by this independent config.
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync, statSync } from 'node:fs';
import { shot } from '../e2e/draw';

const log = (...a: unknown[]) => console.log('BOUNDS', ...a);

// 关卡区域收束: two real browsers over the real ws server walk (held W, not tp) into every barrier across the ways
// out of the L1 / L2 area and stay on the players' side; a debug tp out of the area is refused by the server.
// --disable-gpu-compositing: without it rAF stalls 7–26 s after some tps (the swiftshader GPU process, as x-mob-sync
// iter-207) and the first L2 stand after the level change ran past framesRun's 30 s (#228 gate 3/3, #229 repro 1/1).
let sharedBrowser: Browser;
const contexts: BrowserContext[] = [];
test.afterEach(async () => { await Promise.all(contexts.splice(0).map((c) => c.close())); });

async function open(baseURL: string, name: string): Promise<Page> {
  const ctx = await sharedBrowser.newContext({ baseURL, viewport: { width: 400, height: 260 }, deviceScaleFactor: 1 });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log(name, 'pageerror', e.message));
  page.on('crash', () => log(name, 'page crashed'));
  await page.goto('/?nodraw');
  await page.fill('#name', name);
  return page;
}

const G = (p: Page) => p.evaluate(() => {
  const g = window.__escape.game() as any;
  return { level: g.level.index, x: g.pos.x, z: g.pos.z, y: g.body.y };
});
const tp = (p: Page, x: number, z: number, f: number) => p.evaluate(([x, z, f]) => window.__escape.debug('tp', x, z, f), [x, z, f]);
const look = (p: Page, yaw: number, pitch = 0) => p.evaluate(([y, q]) => { const i = (window.__escape.game() as any).input; i.yaw = y; i.pitch = q; }, [yaw, pitch]);
/** Yaw facing along a level def direction (forward is (-sin yaw, -cos yaw)). */
const YAW = { 'x+': -Math.PI / 2, 'x-': Math.PI / 2, 'z+': Math.PI, 'z-': 0 } as const;

/** Two animation frames come within 250 ms: the frame loop runs (right after a tp it stalls for seconds while the new spot's world loads). */
const framesRun = (p: Page) => p.evaluate(() => new Promise<boolean>((r) => {
  const t0 = performance.now();
  setTimeout(() => r(false), 250);
  requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now() - t0 < 250)));
}));
/** tp to `at` and wait for the server's position and a running frame loop, so the walk starts from where the server has us. */
async function stand(p: Page, x: number, z: number, f: number) {
  await tp(p, x, z, f);
  await expect.poll(async () => { const g = await G(p); return Math.hypot(g.x - x, g.z - z) < 0.3; }, { timeout: 15_000 }).toBe(true);
  const t0 = Date.now();
  await expect.poll(async () => (await framesRun(p)) && (await framesRun(p)) && (await framesRun(p)), { timeout: 30_000 }).toBe(true);
  log('stand', [x, z, f], 'frames back after', Date.now() - t0, 'ms');
  await p.waitForTimeout(400);
}

interface Wall { name: string; at: [number, number, number]; dir: keyof typeof YAW; /** the barrier's near face */ face: number }
/** Hold W towards the barrier for 3 s: we got up to it (within 0.8 m of its face) and not one cm past. */
async function push(p: Page, w: Wall) {
  await stand(p, ...w.at);
  await look(p, YAW[w.dir]);
  // held W through the game's input (as x-multi: a page in the background gets no playwright key events)
  await p.evaluate(() => (window.__escape.game() as any).input.press('KeyW'));
  await p.waitForTimeout(3000);
  await p.evaluate(() => (window.__escape.game() as any).input.release('KeyW'));
  await p.waitForTimeout(600);
  const g = await G(p), axis = w.dir[0] === 'x' ? g.x : g.z, sign = w.dir[1] === '+' ? 1 : -1;
  const gap = sign * (w.face - axis); // > 0: still on the players' side
  if (Math.abs(gap) >= 0.8) log(w.name, 'state', await p.evaluate(() => { const g = window.__escape.game() as any; return JSON.stringify({ keys: [...g.input.keys], en: g.input.enabled, down: g.down, spec: g.spectate, hid: g.hiding, sync: g.spawnSynced, vis: document.visibilityState }); }));
  log(w.name, 'from', w.at, '->', [+g.x.toFixed(2), +g.y.toFixed(2), +g.z.toFixed(2)], 'gap', gap.toFixed(2));
  expect(gap, `${w.name}: walked past the barrier`).toBeGreaterThan(0);
  expect(gap, `${w.name}: never got to the barrier`).toBeLessThan(0.8);
}

/** A debug tp outside the area leaves us where we were. */
async function tpOut(p: Page, x: number, z: number, f: number) {
  const a = await G(p);
  await tp(p, x, z, f);
  await p.waitForTimeout(1200);
  const b = await G(p);
  log('tp out', [x, z, f], 'stayed', [+b.x.toFixed(2), +b.z.toFixed(2)]);
  expect(Math.hypot(b.x - a.x, b.z - a.z), 'server accepted a tp out of the area').toBeLessThan(0.3);
}

async function view(p: Page, x: number, z: number, f: number, dir: keyof typeof YAW | number, pitch: number, path: string) {
  await stand(p, x, z, f);
  await look(p, typeof dir === 'number' ? dir : YAW[dir], pitch);
  // 'safe' only stops the catching: wait until a wandering 角色074 is out of the shot (no 茉莉之夜 grain, < 15 m)
  await expect.poll(() => p.evaluate(() => +(document.getElementById('jasmine')?.style.opacity || 0)), { timeout: 90_000 }).toBeLessThan(0.05);
  // 值日生's 眨眼 blacks the whole screen (#blink-overlay) for a few seconds: shoot after it
  const blinkGone = () => expect.poll(() => p.evaluate(() => document.getElementById('blink-overlay')?.hidden !== false), { timeout: 30_000 }).toBe(true);
  await blinkGone();
  await shot(p, path, 3);
  // page.screenshot can come back blank (911 B) with other browsers about (#186), a blink can land mid-shot (2 KB black): shoot again
  for (let k = 0; k < 3 && statSync(path).size < 10_000; k++) await p.bringToFront(), await blinkGone(), await shot(p, path, 3);
  expect(statSync(path).size, `${path} is blank`).toBeGreaterThan(10_000);
}

test.skip(process.env.ESC_VISUAL_PHASE === 'baseline', 'Baseline collects fixed-camera images first.');

test('L1 / L2: every way out of the area is blocked by a barrier (walking), tp out is refused', async ({ browser, baseURL }) => {
  sharedBrowser = browser;
  mkdirSync('test-results/visual-atmosphere-bounds', { recursive: true });
  test.setTimeout(420_000);
  const readCode = (p: Page) => p.evaluate(async () => { while (!window.__escape.code) await new Promise((r) => setTimeout(r, 50)); return window.__escape.code; });
  const A = await open(baseURL!, '甲');
  await A.click('#create');
  const code = await readCode(A);
  const B = await open(baseURL!, '乙');
  await B.fill('#code', code);
  await B.click('#join');
  await expect(B.locator('#wait-members li')).toHaveCount(2);
  await A.click('#start');
  const pages = [A, B];
  for (const p of pages) await expect(p.locator('#hud')).toBeVisible({ timeout: 90_000 });
  for (const p of pages) await expect.poll(() => p.evaluate(() => (window.__escape.game() as any).spawnSynced), { timeout: 90_000 }).toBe(true);
  // 角色074 leaves us alone: this is about the walls, not about being caught while pushing into them
  await A.evaluate(() => window.__escape.debug('safe', 600));

  // L1 (A 楼一层): the main south entrance, the east side door, the SW stair up to 2F
  await push(A, { name: 'L1 main grate', at: [-40, 64.9, 0], dir: 'z-', face: 63.34 });
  await push(B, { name: 'L1 east desks', at: [-18.1, 73.9, 0], dir: 'x+', face: -16.5 });
  await push(A, { name: 'L1 stair grate', at: [-63.3, 67.5, 0], dir: 'x+', face: -61.95 });
  await tpOut(B, -40, 55, 0);
  await tpOut(A, -40, 70, 1);
  // the fallen desk closing the corridor's east end is solid too (client and server, not just a prop)
  await push(B, { name: 'L1 fallen desk', at: [-19, 74.4, 0], dir: 'z-', face: 72.9 });
  await stand(B, -40, 88, 0); // out of A's shots
  await view(A, -40, 66.8, 0, 'z-', -0.05, 'test-results/visual-atmosphere-bounds/l1-1.png');
  await view(A, -20.2, 73.9, 0, 'x+', -0.1, 'test-results/visual-atmosphere-bounds/l1-2.png');
  await view(A, -63.4, 67.5, 0, 'x+', -0.1, 'test-results/visual-atmosphere-bounds/l1-3.png');
  await view(A, -50, 73.6, 0, 'x-', -0.12, 'test-results/visual-atmosphere-bounds/l1-4.png'); // arrow, 楼梯间 sign, hydrant
  await view(A, -56.2, 70.5, 0, 'x-', -0.15, 'test-results/visual-atmosphere-bounds/l1-5.png'); // just inside: the lit stair room, tube and pool
  await view(A, -51.8, 95.3, 0, 2.17, -0.55, 'test-results/visual-atmosphere-bounds/l1-6.png'); // a dead end: fallen desk under its 应急灯

  // to L2: stair key, everyone into the exit
  await A.evaluate(() => window.__escape.debug('key', -1));
  const exit = await A.evaluate(() => (window.__escape.game() as any).level.exit);
  for (const [i, p] of pages.entries()) await tp(p, exit.x + 2, exit.z + (i - 0.5) * 0.8, Math.round(exit.y / 3.6));
  for (const p of pages) await expect.poll(async () => (await G(p)).level, { timeout: 60_000 }).toBe(1);
  await expect(A.locator('#room-code')).toContainText('第 2 关');
  for (const p of pages) await expect.poll(() => p.evaluate(() => (window.__escape.game() as any).spawnSynced), { timeout: 60_000 }).toBe(true);
  await A.evaluate(() => window.__escape.debug('safe', 600));

  // L2 (A 楼二层): the bridge west to the next building, the NE stair (both up and down)
  await push(B, { name: 'L2 west grate', at: [16.35, 84.25, 1], dir: 'x-', face: 14.75 });
  await push(A, { name: 'L2 NE desks', at: [54.6, 83, 1], dir: 'x+', face: 56.2 });
  await tpOut(A, 10, 84, 1);
  await tpOut(B, 40, 84, 2);
  await push(B, { name: 'L2 fallen desk', at: [58, 76.8, 1], dir: 'z-', face: 74.95 });
  await stand(B, 35, 79, 1); // out of A's shots
  await view(A, 18.6, 84.25, 1, 'x-', -0.05, 'test-results/visual-atmosphere-bounds/l2-1.png');
  await view(A, 52.6, 83, 1, 'x+', -0.1, 'test-results/visual-atmosphere-bounds/l2-2.png');
  await view(A, 50.2, 83.2, 1, 'x-', -0.45, 'test-results/visual-atmosphere-bounds/l2-3.png');
  await view(A, 24, 84.3, 1, 'x-', -0.1, 'test-results/visual-atmosphere-bounds/l2-4.png'); // 连廊 sign, arrow, the exit grate
  await view(A, 22.8, 82, 1, 0.85, -0.25, 'test-results/visual-atmosphere-bounds/l2-5.png'); // in at its east door: the lit classroom by the exit
  await view(A, 58, 77, 1, 'z-', -0.3, 'test-results/visual-atmosphere-bounds/l2-6.png'); // a dead end: fallen desk
});
