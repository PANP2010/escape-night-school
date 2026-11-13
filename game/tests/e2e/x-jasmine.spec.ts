import { expect, test } from '@playwright/test';
import { shot } from './draw';

// 角色074 within 15 m → pale-yellow grain overlay (#jasmine) fades in.
test('jasmine grain appears when 角色074 is near', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/?nodraw');
  await page.fill('#name', '甲');
  await page.click('#create');
  await page.click('#start');
  await expect(page.locator('#hud')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => window.__escape.game()?.snaps ?? 0), { timeout: 15_000 }).toBeGreaterThan(5);
  await page.evaluate(() => window.__escape.debug('warden', 6));
  // 30 s: right after the campus specs the software-GL page is starved and snaps arrive seconds late
  await expect.poll(() => page.evaluate(() => document.getElementById('jasmine')?.style.opacity), { timeout: 30_000 }).toBe('1');
  await page.waitForTimeout(800);
  await shot(page, 'test-results/iter-139-jasmine.png');
});
