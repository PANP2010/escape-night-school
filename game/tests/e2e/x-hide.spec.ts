import { browserArgs } from '../browser-args.mjs';
import { expect, test } from '@playwright/test';
import { clickCanvas, shot } from './draw';

test.use({
  viewport: { width: 480, height: 300 },
  launchOptions: { args: browserArgs(['--renderer-process-limit=1']) },
});

// Next to a 储物柜: prompt 「E 躲藏」; E hides (slit overlay, pinned), E again climbs out.
test('locker: E hides with a slit view, E climbs out', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  if (process.env.ESC_DRAW_TRACE) page.on('console', m => console.log(`[page ${Date.now()}] ${m.text()}`));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?nodraw');
  await page.fill('#name', '甲');
  await page.click('#create');
  await page.click('#start');
  await expect(page.locator('#hud')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => window.__escape.game()?.snaps ?? 0), { timeout: 15_000 }).toBeGreaterThan(1);
  await clickCanvas(page);
  // locker 0 stands against a wall; stand 0.8 m beside it in the room (the classroom's interior is +x of the 后黑板报 row) and face it
  const spot = await page.evaluate(() => {
    const g = window.__escape.game() as any;
    const h = g.level.def.hides[3];
    window.__escape.debug('tp', h.x + 0.8, h.z);
    return { x: h.x, z: h.z };
  });
  await expect.poll(() => page.evaluate((s) => { const g = window.__escape.game() as any; return Math.hypot(g.pos.x - s.x, g.pos.z - s.z); }, spot)).toBeLessThan(1.1);
  // the prompt is only refreshed by update() in the rAF loop, and headless swiftshader stalls rAF for 2–9 s early in a
  // session with the main thread idle (#187: g.last frozen 8.6 s right after clickCanvas) — hence 20 s like the hiding
  // polls below; aim on every poll too so a late pointer-lock mousemove can't turn the view. stall= shows rAF staleness.
  const aim = () => page.evaluate(() => {
    const g = window.__escape.game() as any;
    const h = g.level.def.hides[3];
    const yaw0 = g.input.yaw;
    g.input.yaw = Math.atan2(g.pos.x - h.x, g.pos.z - h.z);
    g.input.pitch = 0;
    const st = `d=${Math.hypot(g.pos.x - h.x, g.pos.z - h.z).toFixed(2)} yawFix=${(g.input.yaw - yaw0).toFixed(2)} hiding=${g.hiding} down=${g.down} stall=${(performance.now() - g.last).toFixed(0)}ms`;
    return `${document.getElementById('prompt')?.textContent} ${st}`;
  });
  await expect.poll(async () => (await aim()).startsWith('E 躲藏 '), { timeout: 20_000, message: 'prompt E 躲藏 facing locker 3' }).toBe(true)
    .catch(async (e) => { throw new Error(`${e.message}\nlast: ${await aim()}`); });
  await page.keyboard.press('KeyE');
  await expect.poll(() => page.evaluate(() => (window.__escape.game() as any).hiding), { timeout: 20_000 }).toBe(3);
  await expect(page.locator('#hide-overlay')).toBeVisible();
  await expect(page.locator('#prompt')).toHaveText('E 出来');
  await page.waitForTimeout(500);
  await shot(page, 'test-results/hide-locker.png');
  await page.keyboard.press('KeyE');
  await expect.poll(() => page.evaluate(() => (window.__escape.game() as any).hiding), { timeout: 20_000 }).toBe(-1);
  await expect(page.locator('#hide-overlay')).toBeHidden();
  expect(errors).toEqual([]);
});
