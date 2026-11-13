import { browserArgs } from '../browser-args.mjs';
import { expect, test } from '@playwright/test';
import { shot } from './draw';

// Own spec + distinct launchOptions => its own browser: a second campus page in a reused software-WebGL browser dies (zygote reset).
test.use({
  viewport: { width: 320, height: 200 },
  launchOptions: { args: browserArgs(['--renderer-process-limit=1', '--disable-gpu-vsync']) },
});

// Capsule movement on the campus: spawn in 教学楼A's entrance hall facing in, autopilot along spawnRoute into
// the first 教室; the server must accept every predicted position (no corrections).
test('campus capsule walk: spawnRoute into the classroom with (almost) no corrections', async ({ page }) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?nodraw');
  await page.fill('#name', '甲');
  await page.click('#create');
  await page.click('#start');
  await expect(page.locator('#hud')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => window.__escape.game()!.snaps > 0, null, { timeout: 20_000 });
  const start = await page.evaluate(() => { const g = window.__escape.game()!; return { x: g.pos.x, y: g.body.y, z: g.pos.z, yaw: g.input.yaw }; });
  await page.evaluate(() => window.__escape.autopilot());
  await page.waitForFunction(() => window.__escape.game()!.autopilotDone, null, { timeout: 120_000, polling: 500 });
  const end = await page.evaluate(() => {
    const g = window.__escape.game()!;
    return { x: g.pos.x, y: g.body.y, z: g.pos.z, corrections: g.corrections, snaps: g.snaps, opened: g.doorOpen.filter(Boolean).length };
  });
  console.log('campus walk', JSON.stringify({ start, end }));
  await shot(page, 'test-results/campus-walk.png');
  const route = await page.evaluate(() => window.__escape.spawnRoute());
  const last = route[route.length - 1];
  expect(Math.hypot(end.x - last[0], end.z - last[1])).toBeLessThan(0.5);
  expect(Math.abs(end.y)).toBeLessThan(0.2);
  expect(end.opened).toBeGreaterThan(0); // the classroom door is shut: the autopilot opened it with E
  expect(end.corrections).toBeLessThanOrEqual(1); // a stalled swiftshader frame can overshoot the server's speed gate once; 0 in a normal run
  expect(errors).toEqual([]);
});
