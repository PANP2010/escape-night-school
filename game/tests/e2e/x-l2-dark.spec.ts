import { devices, expect, test, type Page } from '@playwright/test';
import { shot } from './draw.ts';

const { defaultBrowserType: _b, ...iphone } = devices['iPhone 13 landscape'];
const log = (...a: unknown[]) => console.log('L2DARK', ...a);

// 第 2 关最暗 (#231, 用户 10-28「第二层要保证最暗也能看到脚底的路」): 停电 + 跳闸 (debug power: out = 1) + torch off, standing
// in the corridor and in a dark 教室, desktop and phone. The floor in the frame's lower middle third must read (luma mean
// ≥ 22), brighter than the wall beside it, while the frame as a whole stays dark (mean ≤ 45, L1 is ~45).
const G = (p: Page) => p.evaluate(() => { const g = window.__escape.game() as any; return { x: g.pos.x, z: g.pos.z, y: g.body.y, out: g.campus.out, blackout: g.campus.blackout, light: g.light }; });

/** Luma (BT.601) means of a screenshot: the whole frame, the lower middle third, and the walls beside the floor (corridor). */
const stats = (p: Page, png: Buffer) => p.evaluate(async (b64) => {
  const img = new Image();
  img.src = `data:image/png;base64,${b64}`;
  await img.decode();
  const W = img.width, H = img.height, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, W, H).data;
  const mean = (x0: number, y0: number, x1: number, y1: number) => {
    let s = 0, n = 0;
    for (let y = Math.round(y0 * H); y < Math.round(y1 * H); y++) for (let x = Math.round(x0 * W); x < Math.round(x1 * W); x++) {
      const i = (y * W + x) * 4;
      s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++;
    }
    return +(s / n).toFixed(1);
  };
  // The narrower desktop aspect shows the nearby classroom door in the old right-hand strip.
  // Its pale painted leaf is not the lower wall. Keep both samples on the visible wall skirts;
  // the wider phone view needs the inner strips to stay clear of its outer touch controls.
  const wall = W / H < 2
    ? (mean(0.22, 0.68, 0.27, 0.78) + mean(0.75, 0.68, 0.80, 0.78)) / 2
    : (mean(0.27, 0.66, 0.32, 0.76) + mean(0.68, 0.66, 0.73, 0.76)) / 2;
  return { frame: mean(0, 0, 1, 1), floor: mean(1 / 3, 2 / 3, 2 / 3, 1), wall: +wall.toFixed(1) };
}, png.toString('base64'));

for (const [name, w, h] of [['desk', 1280, 720], ['phone', 844, 390]] as const) {
  test.describe(name, () => {
    if (name === 'phone') test.use({ ...iphone });
    test(`L2 darkest (停电 + 跳闸, no torch): the floor at your feet reads (${name})`, async ({ page }) => {
      test.setTimeout(180_000);
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.setViewportSize({ width: w, height: h });
      await page.goto('/?nodraw&steady');
      await page.fill('#name', '甲');
      await page.dispatchEvent('#create', 'click');
      await expect(page.locator('#wait-code')).not.toBeEmpty();
      await page.dispatchEvent('#start', 'click');
      await expect(page.locator('#hud')).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => page.evaluate(() => window.__escape.game()?.snaps ?? 0), { timeout: 15_000 }).toBeGreaterThan(1);
      await page.evaluate(() => { window.__escape.debug('key', -1); window.__escape.debug('tp', -61, 66); });
      await expect(page.locator('#room-code')).toContainText('第 2 关', { timeout: 30_000 });
      await page.waitForFunction(() => {
        const g = window.__escape.game(); return g?.presentationReady && g.level.index === 1 && !g.intro.active;
      });
      await page.evaluate(() => { window.__escape.debug('safe', 600, 1); window.__escape.debug('safe', 600, 2); });
      await expect.poll(async () => { const g = await G(page); return g.blackout && g.y > 3; }, { timeout: 15_000 }).toBe(true);
      await expect(page.locator('#fade-overlay')).toBeHidden({ timeout: 10_000 });
      for (const [spot, x, z, yaw] of [['corridor', 46, 84.2, Math.PI / 2], ['classroom', 36.4, 77.3, -Math.PI / 2]] as const) {
        await page.evaluate(([x, z]) => window.__escape.debug('tp', x, z), [x, z]);
        await expect.poll(async () => { const g = await G(page); return Math.hypot(g.x - x, g.z - z) < 0.3; }, { timeout: 15_000 }).toBe(true);
        await page.evaluate((yaw) => { const g = window.__escape.game() as any; g.light = false; g.input.yaw = yaw; g.input.pitch = -0.08; }, yaw);
        const file = `test-results/l2-dark-${name}-${spot}.png`;
        let s = { frame: 0, floor: 0, wall: 0 }, still = false;
        // Decode/paint and black-render/capture retries live in draw.ts for every screenshot spec. Only the
        // level-specific requirement (the power cut must still be active after capture) needs a retry here.
        for (let i = 0; i < 3 && !still; i++) {
          // a fresh 跳闸 on top of the blackout (1.6 s omen, then out for 30 s), not the last spot's; the eye adapts
          // (scene.ts EYE_ADAPT, 0.6 s time constant)
          const t0 = await page.evaluate(() => { window.__escape.debug('power', 30); return performance.now(); });
          await expect.poll(() => page.evaluate((t0) => {
            const g = window.__escape.game() as any, trip = g.trip;
            // The new message sets trip before update() clears the previous cut's out=1. Wait for this
            // trip's omen to finish too, or the second spot can pass on that stale darkness for one frame.
            return !!trip && trip.t0 > t0 && (performance.now() - trip.t0) / 1000 >= trip.omen
              && g.campus.out === 1 && g.campus.eye > 0.97;
          }, t0), { timeout: 15_000 }).toBe(true);
          const g = await G(page);
          expect(g.blackout && g.out === 1 && !g.light).toBe(true);
          const png = await shot(page, file);
          still = (await G(page)).out === 1; // rendered before the screenshot: still out after it, so out while drawn
          s = await stats(page, png);
        }
        log(name, spot, JSON.stringify(s), { still });
        expect(still, `${name} ${spot}: power cut stayed active during capture`).toBe(true);
        expect(s.floor, `${name} ${spot}: floor at the feet`).toBeGreaterThanOrEqual(22);
        expect(s.frame, `${name} ${spot}: the frame stays dark`).toBeLessThanOrEqual(45);
        if (spot === 'corridor') expect(s.floor, `${name} corridor: floor above the wall beside it`).toBeGreaterThan(s.wall * 1.15);
      }
      expect(errors).toEqual([]);
    });
  });
}
