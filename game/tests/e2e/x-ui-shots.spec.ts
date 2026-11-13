import { devices, expect, test } from '@playwright/test';

const { defaultBrowserType: _b, ...iphone } = devices['iPhone 13 landscape'];
const tag = process.env.UI_TAG ?? 'ui';

// UI polish snapshots (iter-163): lobby, in-game HUD (prompt pill + subtitle) and the result/down overlays on desktop and phone.
for (const [name, w, h] of [['desk', 1280, 720], ['phone', 844, 390]] as const) {
  test.describe(name, () => {
    if (name === 'phone') test.use({ ...iphone });
    test(`ui shots ${name}`, async ({ page }) => {
      test.skip(!process.env.UI_TAG, 'screenshot tour: run with UI_TAG=<tag>');
      test.setTimeout(240_000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setViewportSize({ width: w, height: h });
      await page.goto('/');
      await page.fill('#name', '甲');
      await page.waitForTimeout(400);
      await page.screenshot({ path: `test-results/${tag}-${name}-lobby.png` });
      await page.dispatchEvent('#create', 'click');
      await expect(page.locator('#wait-code')).not.toBeEmpty();
      await page.dispatchEvent('#start', 'click');
      await expect(page.locator('#hud')).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => page.evaluate(() => window.__escape.game()?.snaps ?? 0), { timeout: 15_000 }).toBeGreaterThan(1);
      // stage a typical moment: an item under the crosshair and a voice line
      await page.evaluate(() => {
        const g = window.__escape.game() as any;
        g.promptText = () => 'E 拾取';
        const s = document.getElementById('subtitle')!;
        s.textContent = '角色074：谁还在走廊里？';
        s.className = '';
        g.setBattery?.(0.62);
        g.setStamina?.(0.7);
      });
      await page.waitForTimeout(800);
      await expect(page.locator('#prompt')).not.toBeEmpty();
      await page.screenshot({ path: `test-results/${tag}-${name}-game.png` });
      await page.evaluate(() => {
        const d = document.getElementById('down-overlay')!;
        d.hidden = false;
      });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `test-results/${tag}-${name}-down.png` });
      await page.evaluate(() => {
        document.getElementById('down-overlay')!.hidden = true;
        const f = document.getElementById('fade-overlay')!;
        f.textContent = '逃出去了……';
        f.hidden = false;
      });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `test-results/${tag}-${name}-result.png` });
      expect(errors).toEqual([]);
    });
  });
}
