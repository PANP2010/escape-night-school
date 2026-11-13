import { expect, test } from '@playwright/test';

// 角色074 model turntable (/?warden=1): front/side/back/face/far-silhouette shots → test-results/warden-*.png, triangle budget;
// with WARDEN_SHOTS=1 also 3 frozen frames per action clip → test-results/warden-anim-<clip>-<i>.png (copied to docs/shots/warden/);
// view/torch shots also only with WARDEN_SHOTS (gate time); off in the gate (npm run check is close to its 5 min limit), one pose is still smoke-tested.
const FRAMES: Record<string, number[]> = {
  idle: [0.5, 3.4, 5.5], walk: [0, 0.25, 0.5], look: [0.1, 1.5, 3.8], investigate: [1.5, 4.6, 5.8],
  chase: [0, 0.25, 0.5], catch: [0.3, 0.9, 2], joke: [0.4, 1.6, 3.5], peek: [0.5, 1.5, 3.5],
};
test.use({ viewport: { width: 360, height: 480 } });
test('warden model shots', async ({ page }) => {
  test.setTimeout(process.env.WARDEN_SHOTS ? 900_000 : 120_000); // ~60 software-rendered shots at 360x480 need far more than 120 s
  await page.goto('/?warden=1');
  await page.waitForFunction(() => '__warden' in window);
  await expect.poll(() => page.evaluate(() => (window as any).__warden.triangles()), { timeout: 15_000 }).toBeGreaterThan(0);
  if (process.env.WARDEN_SHOTS) {
  for (const v of ['front', 'side', 'back', 'face', 'profile', 'face34', 'far', 'lineup']) {
    await page.evaluate((v) => (window as any).__warden.view(v), v);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `test-results/warden-${v}.png` });
  }
  // flashlight at night (how players actually see him): front/side/back standing + a walk frame
  for (const [v, clip, t] of [['front', 'idle', 0.5], ['side', 'idle', 0.5], ['back', 'idle', 0.5], ['hands', 'idle', 0.5], ['act', 'walk', 0.3], ['walk0', 'walk', 0], ['walk1', 'walk', 0.25], ['walk2', 'walk', 0.5]] as const) {
    await page.evaluate(([v, c, t]) => { const w = (window as any).__warden; w.view(v.startsWith('walk') ? 'act' : v); w.pose(c, t); w.torch(true); }, [v, clip, t] as const);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/warden-torch-${v}.png` });
  }
  }
  // 角色074 vs the 值日生 (its own upright, tall, thin, faceless build): front + side
  for (const v of ['duo', 'duoside']) {
    await page.evaluate((v) => (window as any).__warden.view(v), v);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `test-results/iter-158-${v}.png` });
  }
  await page.evaluate(() => { const w = (window as any).__warden; w.torch(false); w.pose('idle', 0); });
  await page.evaluate(() => (window as any).__warden.view('front'));
  await page.waitForTimeout(500);
  const tris = await page.evaluate(() => (window as any).__warden.triangles());
  expect(tris).toBeGreaterThan(3000);
  expect(tris).toBeLessThan(9000 + 2); // + floor
  if (!process.env.WARDEN_SHOTS) {
    await page.evaluate(() => (window as any).__warden.pose('catch', 2));
    return;
  }
  for (const [clip, ts] of Object.entries(FRAMES)) {
    await page.evaluate((v) => (window as any).__warden.view(v), clip === 'peek' ? 'peek' : clip === 'joke' ? 'face' : 'act');
    for (const [i, t] of ts.entries()) {
      await page.evaluate(([c, t]) => (window as any).__warden.pose(c, t), [clip, t] as const);
      await page.waitForTimeout(120);
      await page.screenshot({ path: `test-results/warden-anim-${clip}-${i}.png` });
    }
  }
});
