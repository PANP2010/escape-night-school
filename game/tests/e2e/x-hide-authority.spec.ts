import { expect, test } from '@playwright/test';
import { Flow } from '../fullflow/harness.ts';

for (const mode of ['desktop', 'mobile'] as const) {
  test(`${mode}: L4 locker exit and immediate walking preserve authority`, async ({ browser, baseURL }, info) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ baseURL, viewport: mode === 'mobile'
      ? { width: 844, height: 390 } : { width: 1280, height: 720 },
      isMobile: mode === 'mobile', hasTouch: mode === 'mobile' });
    const page = await context.newPage(), f = new Flow(page, info, mode);
    try {
      await page.goto('/?nodraw&steady'); await page.fill('#name', '柜子同步验收');
      await page.click('#create'); await page.click('#start'); await f.ready(0);
      // This focused regression selects L4 after its first intro; the continuous eight-chapter test selects no levels.
      await page.evaluate(() => window.__escape.debug('level', 3)); await f.ready(3);
      const hide = await page.evaluate(() => window.__escape.game()!.level.def.hides[0]);
      for (let attempt = 0; attempt < 3; attempt++) {
        await f.go({ x: hide.x, y: hide.y ?? 0, z: hide.z - .8 });
        await f.aim({ x: hide.x, y: (hide.y ?? 0) + 1, z: hide.z });
        await f.use('hide', 0);
        await expect.poll(() => page.evaluate(() => window.__escape.game()!.hiding)).toBe(0);
        if (attempt === 0) await f.photo(`l4-${mode}-locker-pin`);
        if (mode === 'mobile') await page.locator('.touch-btn.main').tap(); else await page.keyboard.press('KeyE');
        await expect.poll(() => page.evaluate(() => window.__escape.game()!.hiding)).toBe(-1);
        // Start real movement on the first available frame, with no settling sleep or synthetic body mutation.
        await f.go({ x: hide.x + .7, y: hide.y ?? 0, z: hide.z - .8 });
        await f.checkpoint(`L4-unhide-and-walk-${attempt + 1}`);
      }
      expect((await f.state()).corrections).toBe(0);
      f.assertTransport(); expect(f.errors).toEqual([]);
    } finally { await f.save(); await context.close(); }
  });
}
