import { mkdir } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { captureJasminePair, jasminePixels, JASMINE_VIEWS, placeJasmine, prepareJasminePage } from '../shot-jasmine.mjs';
import { browserArgs } from '../browser-args.mjs';

test.use({ launchOptions: { args: browserArgs(['--mute-audio']) } });

test('jasmine remains above the real downed canvas filter', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const { page, context, errors } = await prepareJasminePage(browser, baseURL, JASMINE_VIEWS[0], { withTeammate: true });
  try {
    await placeJasmine(page, 3);
    await page.evaluate(() => window.__escape.debug('down', 30));
    await page.waitForFunction(() => {
      const g = window.__escape.game();
      return g.down && g.eye < 0.56 && getComputedStyle(g.renderer.domElement).filter !== 'none';
    });
    await placeJasmine(page, 3);
    await mkdir('test-results/jasmine-downed', { recursive: true });
    await page.screenshot({ path: 'test-results/jasmine-downed/desktop-3m.png' });
    const pair = await captureJasminePair(page, 'test-results/jasmine-downed/desktop-3m', 3);
    const pixels = await jasminePixels(page, pair);
    expect(pair.on.down).toBe(true);
    expect(pair.on.afterCanvas).toBe(true);
    expect(pixels.rim.changed).toBeGreaterThan(5);
    expect(errors).toEqual([]);
  } finally {
    await page.evaluate(() => clearInterval(window.__jasminePlacement)).catch(() => {});
    await context.close();
  }
});
