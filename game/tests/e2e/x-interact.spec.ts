import { browserArgs } from '../browser-args.mjs';
import { expect, test } from '@playwright/test';
import { clickCanvas, shot } from './draw';

// Fresh worker/browser like x-campus: the reused software-WebGL browser died on screenshot here.
test.use({
  viewport: { width: 480, height: 300 },
  launchOptions: { args: browserArgs(['--renderer-process-limit=1']) },
});

// Crosshair on a key lying beside the spawn: the prompt shows 「E 拾取」; E sends `act` and the key is picked up.
test('crosshair prompt on a key, E picks it up', async ({ page }) => {
  test.setTimeout(100_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/?nodraw');
  await page.fill('#name', '甲');
  await page.click('#create');
  await page.click('#start');
  await expect(page.locator('#hud')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => window.__escape.game()?.snaps ?? 0), { timeout: 15_000 }).toBeGreaterThan(1);
  await clickCanvas(page);
  // the keys lie in lectern drawers (drawn per seed): stand 0.8 m from the nearest one, then aim at its middle
  await page.evaluate(() => {
    const g = window.__escape.game() as any;
    const keys = (g.items as { kind: string; p: number[] }[]).filter((i) => i.kind === 'door_key');
    const k = keys.reduce((a, b) => (Math.hypot(a.p[0] - g.pos.x, a.p[2] - g.pos.z) < Math.hypot(b.p[0] - g.pos.x, b.p[2] - g.pos.z) ? a : b));
    window.__escape.debug('tp', k.p[0] + 0.8, k.p[2]);
  });
  await expect.poll(() => page.evaluate(() => { const g = window.__escape.game() as any; return g.items.some((k: any) => k.kind === 'door_key' && Math.hypot(k.p[0] - g.pos.x, k.p[2] - g.pos.z) < 1.2); }), { timeout: 15_000 }).toBe(true);
  await page.evaluate(() => {
    const g = window.__escape.game() as any;
    const k = (g.items as { kind: string; p: number[] }[]).find((i) => i.kind === 'door_key' && Math.hypot(i.p[0] - g.pos.x, i.p[2] - g.pos.z) < 1.2)!;
    const dx = k.p[0] - g.pos.x, dz = k.p[2] - g.pos.z;
    g.input.yaw = Math.atan2(-dx, -dz);
    g.input.pitch = Math.atan2(k.p[1] + 0.6 - (g.body.y + g.eye), Math.hypot(dx, dz));
  });
  await expect(page.locator('#prompt')).toHaveText('E 拾取', { timeout: 20_000 });
  await shot(page, 'test-results/interact-prompt.png');
  await page.keyboard.press('KeyE');
  await expect(page.locator('#keys')).toContainText('钥匙 ×1', { timeout: 20_000 });
  await expect(page.locator('#prompt')).not.toHaveText('E 拾取', { timeout: 10_000 }); // (a desk next to the key may offer 「E 躲藏」)
  expect(errors).toEqual([]);
});
