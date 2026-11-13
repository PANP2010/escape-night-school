import { browserArgs } from '../browser-args.mjs';
import { copyFileSync, mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { shot } from './draw';

// A worker-scoped option that differs from playwright.config forces a fresh worker + browser: the
// one reused through smoke died mid-test here (zygote reset; campus costs ~500 ms/frame, ~8 s/shot in swiftshader).
// /?nodraw + shot(): only the screenshot frames are drawn (1.2 min → 40 s, #186); stats() reads the shot's last render.
test.use({
  viewport: { width: 480, height: 300 },
  launchOptions: { args: browserArgs(['--renderer-process-limit=1']) },
});

// Night campus screenshots (docs/shots/campus/): fixed views of 教学楼A through window.__escape.views().
// Also covers the door: a campus door is a hinged leaf with a 把手; shut it faces the viewer, opened (client-side flip)
// it swings about its hinge. Shares this page load (a second campus page in a reused software-WebGL browser dies).
test('campus renders at night: outdoor, corridor, classroom, stairs, door', async ({ page }) => {
  test.setTimeout(170_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?nodraw&steady'); // steady: the 日光灯 flicker can't flash a corridor/classroom shot (#190)
  await page.fill('#name', '甲');
  await page.click('#create');
  await page.click('#start');
  await expect(page.locator('#hud')).toBeVisible({ timeout: 20_000 });
  mkdirSync('../docs/shots/campus', { recursive: true });
  for (const name of ['outdoor', 'corridor', 'classroom', 'stairs'] as const) {
    await page.evaluate((n) => { const g = window.__escape.game()!; g.view = window.__escape.views()[n]; g.light = true; }, name);
    await page.waitForTimeout(400);
    const out = `test-results/campus-${name}.png`;
    await shot(page, out);
    if (name === 'corridor') {
      // indoors only the building (and what the doorways show) is drawn: trees, outskirts and props are culled
      await page.waitForTimeout(1500);
      await shot(page, out);
      const s = await page.evaluate(() => window.__escape.stats());
      console.log('corridor triangles', s.triangles, 'calls', s.calls);
      // ?steady reached the built client: 2 s of updates later the clock still sits between bursts (scene.ts STEADY_T)
      expect(await page.evaluate(() => (window.__escape.game()!.campus as unknown as { time: number }).time)).toBe(3);
      expect(s.triangles).toBeLessThanOrEqual(60_000);
    }
    copyFileSync(out, `../docs/shots/campus/${name}.png`);
  }
  await page.waitForFunction(() => window.__escape.game()!.snaps > 0, null, { timeout: 20_000 });
  const id = await page.evaluate(() => {
    const g = window.__escape.game()!;
    const near = [...g.doors].filter((d) => d.y0 !== undefined && Math.abs(d.y0 - g.body.y) < 1)
      .sort((a, b) => Math.hypot(a.x - g.pos.x, a.z - g.pos.z) - Math.hypot(b.x - g.pos.x, b.z - g.pos.z))[0];
    const eye = near.y0! + 1.5;
    g.view = near.alongX ? { x: near.x, y: eye, z: near.z + 2, yaw: 0, pitch: 0 } : { x: near.x + 2, y: eye, z: near.z, yaw: Math.PI / 2, pitch: 0 };
    return near.id;
  });
  await page.waitForTimeout(400);
  await shot(page, 'test-results/campus-door-shut.png');
  await page.evaluate((i) => { window.__escape.game()!.doorOpen[i] = true; }, id);
  await page.waitForTimeout(700);
  await shot(page, 'test-results/campus-door-open.png');
  const s = await page.evaluate(() => window.__escape.stats());
  console.log('campus draw calls', s.calls, 'triangles', s.triangles);
  expect(s.triangles).toBeGreaterThan(1000);
  expect(errors).toEqual([]);
});
