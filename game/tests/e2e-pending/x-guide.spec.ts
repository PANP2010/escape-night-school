import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { clickCanvas, shot } from '../e2e/draw';

// #221 B 验收: an 「只读 HUD」 bot. Two players clear L1 and L2 within 5 min reading only the objective panel text,
// the goal arrow (#goal-arrow: edge angle data-a / on-screen marker position, the distance) and the E prompt; it
// never reads level coordinates. Its only outputs are what a player has: keys and the look (input.yaw / pitch).
const ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'];
const launched: Browser[] = [];
test.afterEach(async () => { await Promise.all(launched.splice(0).map((b) => b.close())); });

const log = (...a: unknown[]) => console.log('GUIDE', ...a);
const ACT = ['E 拾取', 'E 打开', 'E 插入保险丝', 'E 搀扶'];

async function open(baseURL: string, name: string): Promise<Page> {
  const browser = await chromium.launch({ args: ARGS });
  launched.push(browser);
  const ctx = await browser.newContext({ baseURL, viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log(name, 'pageerror', e.message));
  await page.goto('/?nodraw');
  await page.fill('#name', name);
  return page;
}

/** One look: the HUD as a player sees it, and the turn towards the arrow (yaw by its edge angle / marker offset). */
const look = (p: Page) => p.evaluate(() => {
  const el = document.getElementById('goal-arrow')!, r = el.getBoundingClientRect(), w = innerWidth, h = innerHeight;
  const on = el.classList.contains('on'), a = Number(el.dataset.a ?? 0), m = /(\d+) m/.exec(el.querySelector('.d')!.textContent ?? '');
  const fade = document.getElementById('fade-overlay')!;
  const hud = { arrow: !el.hidden, on, a, d: m ? Number(m[1]) : NaN, rough: (el.querySelector('.d')!.textContent ?? '').startsWith('约'),
    here: (el.querySelector('.d')!.textContent ?? '') === '到了，等队友',
    goal: document.querySelector('#objective .g')!.textContent ?? '', head: document.querySelector('#objective .h')!.textContent ?? '',
    prompt: document.getElementById('prompt')!.textContent ?? '', fade: fade.hidden ? '' : fade.textContent ?? '' };
  const inp = (window.__escape.game() as any).input;
  if (hud.arrow && on) {
    const dx = (r.left + r.width / 2 - w / 2) / (w / 2), dy = (r.top + r.height / 2 - h / 2) / (h / 2);
    inp.yaw -= dx * 0.5;
    inp.pitch = Math.max(-1.2, Math.min(1.2, inp.pitch - dy * 0.3));
  } else if (hud.arrow) {
    inp.yaw -= Math.max(-0.6, Math.min(0.6, (a * Math.PI) / 180 * 0.5));
    inp.pitch *= 0.7;
  }
  return hud;
});

type Hud = Awaited<ReturnType<typeof look>>;

/** Follows the arrow until the level fades out ('逃出去了……'); returns the HUD history's step texts. */
async function bot(p: Page, name: string, until: number, onStep?: (n: number) => Promise<void>): Promise<string[]> {
  const steps: string[] = [];
  let best = Infinity, bestAt = Date.now(), goal = '', unstick = 0;
  const kb = p.keyboard;
  await kb.down('KeyW');
  try {
    while (Date.now() < until) {
      const h: Hud = await look(p);
      if (h.fade.startsWith('逃出去了')) return steps;
      if (h.goal !== goal) { goal = h.goal; steps.push(`${h.head} ${h.goal}`); log(name, h.head, h.goal); await onStep?.(steps.length); best = Infinity; bestAt = Date.now(); }
      // in the exit zone (the arrow says so): stand and wait for the others
      if (h.here) { await kb.up('KeyW'); await kb.up('ShiftLeft'); bestAt = Date.now(); await p.waitForTimeout(150); continue; }
      // E landed on a locker (the look turned between reading 「E 拾取」 and the key press): get out, as a player would
      if (h.prompt === 'E 出来') { await kb.press('KeyE'); log(name, 'E', h.prompt, h.d); await p.waitForTimeout(300); continue; }
      if (ACT.includes(h.prompt)) { await kb.press('KeyE'); log(name, 'E', h.prompt, h.d); await p.waitForTimeout(300); continue; }
      // near an item / the fuse box: stop and aim at it (the marker), creep in if no prompt yet
      const near = h.arrow && h.on && !h.rough && h.d <= 2;
      if (near) { await kb.up('KeyW'); await kb.up('ShiftLeft'); await p.waitForTimeout(80); await kb.press('KeyW', { delay: 60 }); }
      else { await kb.down('KeyW'); if (h.d > 6) await kb.down('ShiftLeft'); else await kb.up('ShiftLeft'); }
      if (h.d < best - 0.9) { best = h.d; bestAt = Date.now(); }
      else if (Date.now() - bestAt > (h.rough ? 7000 : 4000)) { // no closer for a while: back off and sidestep
        // diagnostics only (never steers): where it got stuck and what the guide pointed at
        log(name, 'stuck', h.goal, h.d, await p.evaluate(() => { const g = window.__escape.game() as any; return JSON.stringify({ p: [g.pos.x, g.body.y, g.pos.z].map((v: number) => v.toFixed(1)), w: g.guide && [g.guide.x, g.guide.y, g.guide.z].map((v: number) => v.toFixed(1)), yaw: g.input.yaw.toFixed(2), pr: document.getElementById('prompt')!.textContent }); }));
        await kb.up('KeyW');
        await kb.down('KeyS'); await p.waitForTimeout(500); await kb.up('KeyS');
        const side = unstick++ % 2 ? 'KeyA' : 'KeyD';
        await kb.down(side); await p.waitForTimeout(700); await kb.up(side);
        await kb.down('KeyW');
        best = Infinity; bestAt = Date.now();
      }
      await p.waitForTimeout(near ? 60 : 100);
    }
    throw new Error(`${name}: out of time at ${goal}`);
  } finally { await kb.up('KeyW'); await kb.up('ShiftLeft'); }
}

test('只读 HUD bot: two players follow the goal arrow through L1 and L2 in 5 min', async ({ baseURL }) => {
  test.setTimeout(420_000);
  const [A, B] = await Promise.all([open(baseURL!, '甲'), open(baseURL!, '乙')]);
  await A.click('#create');
  await expect(A.locator('#wait-code')).not.toBeEmpty();
  const code = await A.evaluate(() => window.__escape.code);
  await B.fill('#code', code);
  await B.click('#join');
  await expect(A.locator('#wait-members li')).toHaveCount(2);
  await A.click('#start');
  for (const p of [A, B]) {
    await expect(p.locator('#hud')).toBeVisible({ timeout: 30_000 });
    await expect(p.locator('#goal-arrow')).not.toHaveAttribute('hidden', { timeout: 30_000 }); // 0×0 anchor: never 'visible'
    await clickCanvas(p);
  }
  const safe = () => Promise.all([A, B].map((p) => p.evaluate(() => window.__escape.debug('safe', 600))));
  const t0 = Date.now(), until = t0 + 300_000;
  for (const lv of ['L1', 'L2']) {
    await safe();
    const snap = async (n: number) => { if (n <= 2) await shot(A, `test-results/guide-${lv}-${n}.png`, 1); };
    const [sa] = await Promise.all([bot(A, '甲', until, snap), bot(B, '乙', until)]);
    log(lv, 'cleared at', Math.round((Date.now() - t0) / 1000), 's', sa);
    // the next level's start (the fade is LEVEL_FADE_S): the panel restarts at step 1
    for (const p of [A, B]) await expect(p.locator('#fade-overlay')).toBeHidden({ timeout: 15_000 });
  }
  expect(Date.now() - t0).toBeLessThan(300_000);
});
