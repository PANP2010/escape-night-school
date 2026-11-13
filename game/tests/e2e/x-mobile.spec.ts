import { browserArgs } from '../browser-args.mjs';
import { devices, expect, test } from '@playwright/test';
import { shot } from './draw';

const { defaultBrowserType: _b, ...iphone } = devices['iPhone 13 landscape'];
test.use({
  ...iphone,
  launchOptions: { args: browserArgs(['--renderer-process-limit=1']) },
});

// Mobile layouts: landscape (844×390) and portrait (390×844) both create a room and enter level 1 without errors; portrait shows the rotate gate.
for (const [name, w, h] of [['landscape', 844, 390], ['portrait', 390, 844]] as const) {
  test(`mobile ${name}: lobby → level, no overflow`, async ({ page }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/?nodraw');
    await page.fill('#name', '甲');
    await page.screenshot({ path: `test-results/mobile-${name}-lobby.png` });
    await page.dispatchEvent('#create', 'click'); // the portrait gate covers the lobby
    await page.dispatchEvent('#start', 'click');
    await expect(page.locator('#hud')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => window.__escape.game()?.snaps ?? 0), { timeout: 15_000 }).toBeGreaterThan(1);
    expect(await page.locator('#rotate').isVisible()).toBe(name === 'portrait');
    expect(await page.evaluate(() => devicePixelRatio >= 1 && window.__escape.game()!.renderer.getPixelRatio())).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await shot(page, `test-results/mobile-${name}.png`);
    expect(errors).toEqual([]);
  });
}
