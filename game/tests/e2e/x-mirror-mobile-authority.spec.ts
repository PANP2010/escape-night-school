import { expect, test } from '@playwright/test';
import { Flow } from '../fullflow/harness.ts';
import { mirrorChapter } from '../fullflow/future.ts';

test('mobile taps the real reflected key and both secret-wall surfaces clear of the HUD', async ({ browser, baseURL }, info) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
  const page = await context.newPage(), f = new Flow(page, info, 'mobile');
  try {
    await page.goto('/?nodraw&steady'); await page.fill('#name', '镜廊触摸验收');
    await page.click('#create'); await page.click('#start'); await f.ready(0);
    await page.evaluate(() => window.__escape.debug('level', 6)); await f.ready(6);
    await mirrorChapter(f);
    expect((await f.state()).corrections).toBe(0);
    f.assertTransport(); expect(f.errors).toEqual([]);
  } finally { await f.save(); await context.close(); }
});
