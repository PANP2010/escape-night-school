import { browserArgs } from '../browser-args.mjs';
import { writeFileSync } from 'node:fs';
import { chromium, expect, test, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { TICK_MS } from '../../shared/constants.ts';

const log = (...a: unknown[]) => console.log('REPRO', ...a);

// 审查 #205: three clients read 角色074's mesh.position 0.8–2.7 m apart. Cause (iter-207): headless swiftshader stalls every
// page's rAF for 5–11 s right after load/spawn with the main thread idle (CDP profile), so each mesh froze wherever its
// last frame left it. Interpolation itself is fine (≤ 0.13 m while rAF runs). --disable-gpu-compositing removes the stall
// (spawn 13.8 s → 6.6 s on one client), so this spec measures the sync and not the GPU process.
const ARGS = browserArgs(['--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows', '--disable-gpu-compositing']);
const launched: Browser[] = [];
test.afterEach(async () => { await Promise.all(launched.splice(0).map((b) => b.close())); });
test.describe.configure({ retries: 2 });

async function open(baseURL: string, name: string, storageState: BrowserContextOptions['storageState']): Promise<Page> {
  const browser = await chromium.launch({ args: ARGS });
  launched.push(browser);
  const ctx = await browser.newContext({ baseURL, storageState, viewport: { width: 400, height: 260 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log(name, 'pageerror', e.message));
  page.on('crash', () => log(name, 'page crashed'));
  // every rAF: [Date.now(), x, z, anim] of mob 1 (all pages share one wall clock on this box)
  await page.addInitScript(() => {
    const w = window as any; w.__trk = []; w.__raf = [];
    const f = () => {
      const now = Date.now(); w.__raf.push(now); if (w.__raf.length > 400) w.__raf.shift();
      const g = w.__escape?.game(), o = g?.mobs.byId.get(1);
      if (o && w.__rec) w.__trk.push([now, o.mesh.position.x, o.mesh.position.z, o.anim, {
        now: performance.now(), playback: o.clock.t, newest: o.buf.lastT(), target: o.at,
        samples: o.buf.s.slice(-2), tick: g.lastSnapTick,
      }]);
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  await page.goto('/?nodraw');
  await page.fill('#name', name);
  return page;
}

type TrackState = { now: number; playback: number; newest: number; target: number[];
  samples: { t: number; x: number; z: number }[]; tick: number };
type PositionRow = [number, number, number, string];
type Row = [...PositionRow, TrackState];
/** Position at wall time t, linear between the two rAF rows around t (null if t is not covered within 150 ms). */
function at(tr: Row[], t: number): PositionRow | null {
  const k = tr.findIndex((r) => r[0] >= t);
  if (k <= 0) return null;
  const [a, b] = [tr[k - 1], tr[k]];
  if (b[0] - a[0] > 150) return null;
  const u = (t - a[0]) / Math.max(1, b[0] - a[0]);
  return [t, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, b[3]];
}

/** Records [t0, t0 + 5 s] on all pages and returns the worst three-way spread over the eleven 0.5 s samples. */
async function sample(pages: Page[], what: string) {
  await Promise.all(pages.map((p) => p.evaluate(() => { (window as any).__trk = []; (window as any).__rec = true; })));
  const t0 = Date.now() + 200;
  await pages[0].waitForTimeout(5400);
  const trk: Row[][] = await Promise.all(pages.map((p) => p.evaluate(() => { (window as any).__rec = false; return (window as any).__trk; })));
  writeFileSync(test.info().outputPath(`${what}-tracks.json`), JSON.stringify({ t0, trk }));
  for (const tr of trk) for (const [, , , , state] of tr) {
    if (state.samples.length === 2) expect(state.samples[1].t - state.samples[0].t,
      `${what}: loading and delivery backlogs must not compress server ticks`).toBeGreaterThanOrEqual(TICK_MS);
  }
  let worst = 0; const anims: string[] = [];
  for (let k = 0; k <= 10; k++) {
    const r = trk.map((tr) => at(tr, t0 + k * 500));
    expect(r.every(Boolean), `${what} ${k * 0.5}s: every client rendered a frame around the sample`).toBe(true);
    let d = 0;
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) d = Math.max(d, Math.hypot(r[i]![1] - r[j]![1], r[i]![2] - r[j]![2]));
    log(what, (k * 0.5).toFixed(1), 'spread', d.toFixed(2), r.map((x) => `${x![1].toFixed(2)},${x![2].toFixed(2)} ${x![3]}`).join(' | '));
    worst = Math.max(worst, d); anims.push(r.map((x) => x![3]).join('/'));
  }
  return { worst, anims };
}

test('3 browsers: 角色074 is at the same place on every client, standing and chasing', async ({ baseURL, storageState }) => {
  test.setTimeout(240_000);
  const [A, B, C] = await Promise.all([open(baseURL!, '甲', storageState), open(baseURL!, '乙', storageState), open(baseURL!, '丙', storageState)]);
  const pages = [A, B, C];
  await A.click('#create');
  const code = await A.evaluate(async () => { while (!window.__escape.code) await new Promise((r) => setTimeout(r, 50)); return window.__escape.code; });
  for (const p of [B, C]) { await p.fill('#code', code); await p.click('#join'); }
  await expect(A.locator('#wait-members li')).toHaveCount(3);
  await A.evaluate(() => document.getElementById('start')!.click());
  for (const p of pages) await p.waitForFunction(() => {
    const g = window.__escape.game(); return g?.presentationReady && !g.intro.active;
  }, null, { timeout: 60_000 });
  // rAF live everywhere: the last 2 s of frames without a gap > 250 ms
  for (const p of pages) await p.waitForFunction(() => {
    const r: number[] = (window as any).__raf; const now = Date.now();
    if (!r.length || now - r[0] < 2000 || now - r[r.length - 1] > 250) return false;
    for (let i = r.length - 1; i > 0 && r[i] > now - 2000; i--) if (r[i] - r[i - 1] > 250) return false;
    return true;
  }, null, { timeout: 60_000, polling: 200 });

  // not chasing anyone: he patrols / stands
  const idle = await sample(pages, 'idle');
  expect(idle.anims.some((a) => a.includes('chase') || a.includes('catch')), 'idle span has no chase').toBe(false);
  expect(idle.worst, 'idle: same 角色074 on all three clients (m)').toBeLessThan(0.3);

  // summon him 30 m from 乙 so the run takes longer than the 5 s span
  await B.waitForFunction(() => (window.__escape.game() as any).mobs.byId.get(1)?.anim !== 'catch', null, { timeout: 30_000 });
  await B.evaluate(() => window.__escape.debug('warden', 30));
  await B.waitForFunction(() => (window.__escape.game() as any).mobs.byId.get(1)?.anim === 'chase', null, { timeout: 10_000 });
  const chase = await sample(pages, 'chase');
  expect(chase.anims.filter((a) => a === 'chase/chase/chase').length, 'chasing on all clients for most samples').toBeGreaterThanOrEqual(8);
  expect(chase.worst, 'chase: same 角色074 on all three clients (m)').toBeLessThan(0.6);
});
