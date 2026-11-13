import { browserArgs } from '../browser-args.mjs';
import { expect, test } from '@playwright/test';
import { clickCanvas, shot } from './draw';

test.use({
  viewport: { width: 480, height: 300 },
  launchOptions: { args: browserArgs(['--renderer-process-limit=1']) },
});

// The flashlight starts off (design); turn it on, then the server drains its charge and the HUD shows it falling.
test('flashlight on drains the battery', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?nodraw');
  await page.fill('#name', '甲');
  await page.click('#create');
  await page.click('#start');
  await expect(page.locator('#hud')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => window.__escape.game()?.snaps ?? 0), { timeout: 15_000 }).toBeGreaterThan(1);
  await clickCanvas(page);
  await page.evaluate(() => { window.__escape.game()!.light = true; });
  await expect.poll(() => page.evaluate(() => (window.__escape.game() as any).battery), { timeout: 20_000 }).toBeLessThan(0.99);
  await expect(page.locator('#battery')).toHaveText(/^手电 \d+%$/);
  await shot(page, 'test-results/battery.png');
  expect(errors).toEqual([]);
});
