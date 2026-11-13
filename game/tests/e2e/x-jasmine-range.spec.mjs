import { expect, test } from '@playwright/test';
import { captureJasmine, JASMINE_VIEWS } from '../shot-jasmine.mjs';
import { browserArgs } from '../browser-args.mjs';

test.use({ launchOptions: { args: browserArgs(['--mute-audio']) } });

for (const view of JASMINE_VIEWS) {
  test(`jasmine has a visible 15 m approach on ${view.name}, with a clear centre`, async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const report = await captureJasmine(browser, baseURL, `jasmine-fixed-${view.name}`, { views: [view] });
    const [row] = report.views;
    expect(row.errors).toEqual([]);
    const [outside, far, middle, near] = row.samples;
    expect(outside.opacity).toBe(0);
    expect(outside.pixels.rim.changed).toBe(0);
    for (const sample of [far, middle, near]) {
      expect(Math.abs(sample.wd - sample.target)).toBeLessThan(0.3);
      expect(Math.abs(sample.snapDistance - sample.target)).toBeLessThan(0.3);
      expect(sample.overlayCount).toBe(1);
      expect(sample.afterCanvas).toBe(true);
      expect(sample.fakeShot).toBe(false);
      expect(sample.bgSize).toBe('256px 256px');
      expect(sample.opacity).toBeGreaterThan(0);
      expect(sample.pixels.rim.changed).toBeGreaterThan(5);
      expect(sample.pixels.centre.count).toBeGreaterThan(5000);
      expect(sample.pixels.centre.changed).toBe(0);
      expect(sample.audio.state).toBe('running');
      expect(sample.audio.active).toBe(true);
    }
    // Compare pixel energy, not just CSS opacity: once opacity reaches 1 density still increases.
    expect(middle.pixels.rim.mean).toBeGreaterThan(far.pixels.rim.mean * 2);
    expect(near.pixels.rim.mean).toBeGreaterThan(middle.pixels.rim.mean * 1.5);
    expect(near.audio.near).toBeGreaterThan(middle.audio.near);
    expect(middle.audio.near).toBeGreaterThan(far.audio.near);
    for (const edge of ['top', 'bottom', 'left', 'right']) {
      expect(middle.pixels[edge].changed, `${view.name} straight ${edge} edge`).toBeGreaterThan(0);
    }
  });
}
