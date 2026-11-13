import { browserArgs } from '../browser-args.mjs';
import { devices, expect, test } from '@playwright/test';
import { showCanvas, shot } from './draw';

const { defaultBrowserType: _b, ...iphone } = devices['iPhone 13 landscape']; // landscape + hasTouch + isMobile (run on chromium)
test.use({
  ...iphone,
  launchOptions: { args: browserArgs(['--renderer-process-limit=1']) },
});

// Touch: the left stick walks (WASD), the right half drags the view (0.004 rad/px), buttons tap E/F/…; two fingers work at once.
test('touch: stick moves, drag turns, buttons toggle the torch', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?nodraw');
  await page.fill('#name', '甲');
  await page.click('#create');
  await page.click('#start');
  await expect(page.locator('#hud')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => window.__escape.game()?.snaps ?? 0), { timeout: 15_000 }).toBeGreaterThan(1);
  await expect(page.locator('#touch')).toBeVisible();
  await expect(page.locator('#hint')).toBeVisible();
  await expect(page.locator('#hint')).toContainText('左侧拖动');
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', pts: { x: number; y: number; id: number }[]) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : pts.map((p) => ({ x: p.x, y: p.y, id: p.id })) });
  const st = () => page.evaluate(() => { const g = window.__escape.game() as any; return { x: g.pos.x, z: g.pos.z, yaw: g.input.yaw as number, keys: [...g.input.keys] as string[], light: g.light as boolean }; });
  const vp = page.viewportSize()!;
  const sy = Math.round(vp.height * 0.7);

  // tapping the (visible) canvas must not request pointer lock
  await showCanvas(page, true);
  await page.touchscreen.tap(vp.width * 0.6, vp.height * 0.3);
  expect(await page.evaluate(() => document.pointerLockElement === null)).toBe(true);
  await showCanvas(page, false);

  // stick forward + a second finger dragging the view at the same time (identifiers tracked separately)
  const a = await st();
  await touch('touchStart', [{ x: 90, y: sy, id: 1 }]);
  await touch('touchMove', [{ x: 90, y: sy - 55, id: 1 }]); // pushed ~0.9+ of the radius: forward + run
  const lx = Math.round(vp.width * 0.65), ly = Math.round(vp.height * 0.3);
  await touch('touchStart', [{ x: 90, y: sy - 55, id: 1 }, { x: lx, y: ly, id: 2 }]);
  await touch('touchMove', [{ x: 90, y: sy - 55, id: 1 }, { x: lx - 100, y: ly, id: 2 }]);
  await page.waitForTimeout(900);
  const b = await st();
  expect(b.keys).toContain('KeyW');
  expect(b.keys).toContain('ShiftLeft');
  expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeGreaterThan(0.5);
  expect(b.yaw - a.yaw).toBeGreaterThan(0.3); // 100 px × 0.004 = 0.4 rad (dragging left turns left)
  expect(b.yaw - a.yaw).toBeLessThan(0.5);
  await shot(page, 'test-results/touch-play.png');
  await touch('touchEnd', []);
  await expect.poll(async () => (await st()).keys).toEqual([]);

  // buttons: F toggles the torch
  const f = page.locator('.touch-btn', { hasText: '手电' });
  await f.tap();
  await expect.poll(async () => (await st()).light, { timeout: 20_000 }).toBe(!a.light);
  await f.tap();
  await expect.poll(async () => (await st()).light, { timeout: 20_000 }).toBe(a.light);
  expect(errors).toEqual([]);
});
