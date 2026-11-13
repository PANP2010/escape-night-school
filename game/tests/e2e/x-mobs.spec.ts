import { browserArgs } from '../browser-args.mjs';
import { expect, test } from '@playwright/test';
import { shot } from './draw';
import WebSocket from 'ws';
import { TPS } from '../../shared/constants.ts';
import { WARDEN_PATROL_SPEED } from '../../server/ai/warden.ts';

// Node ws bot (no browser): a campus room's snapshots carry the wandering placeholder 角色074, and it moves.
test('campus snapshot has a mob that walks', async ({ baseURL }) => {
  const ws = new WebSocket(`${baseURL!.replace('http', 'ws')}/ws`);
  const seen: { p: number[]; form: string; anim: string }[] = [];
  let active = false, form = '', anim = '';
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.t === 'welcome') { ws.send(JSON.stringify({ t: 'hello', name: '机器人' })); ws.send(JSON.stringify({ t: 'create' })); ws.send(JSON.stringify({ t: 'start' })); }
    if (m.t === 'event' && m.kind === 'intro') {
      active = m.ended;
      if (!m.ended) ws.send(JSON.stringify({ t: 'intro-skip', id: m.id }));
    }
    if (m.t === 'snap' && m.mobs.length) {
      // Mob fields are deltas; the first post-intro frame need not repeat its form / animation.
      form = m.mobs[0].form ?? form; anim = m.mobs[0].anim ?? anim;
      if (active) seen.push({ ...m.mobs[0], form, anim });
    }
  });
  await expect.poll(() => seen.length, { timeout: 15_000 }).toBeGreaterThan(40);
  ws.close();
  expect(seen[0]).toMatchObject({ form: 'normal', anim: 'patrol' });
  // path length (a random walk may turn back, so not the displacement): 2 m/s at 20 TPS = 0.1 m per snapshot
  const per = WARDEN_PATROL_SPEED / TPS;
  let len = 0;
  for (let i = 1; i < seen.length; i++) len += Math.hypot(...seen[i].p.map((v, k) => v - seen[i - 1].p[k]) as [number, number, number]);
  expect(len / (seen.length - 1)).toBeGreaterThan(0.75 * per);
  expect(len / (seen.length - 1)).toBeLessThan(1.25 * per);
});

// Page: the placeholder capsule shows up where the snapshot says (screenshot test-results/mob.png, 3 m in front of it).
test.use({
  viewport: { width: 480, height: 300 },
  launchOptions: { args: browserArgs(['--renderer-process-limit=1']) },
});
{
  test('mob capsule is in the scene', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/?nodraw');
    await page.fill('#name', '甲');
    await page.click('#create');
    await page.click('#start');
    await expect(page.locator('#hud')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.mobs.byId.size), { timeout: 15_000 }).toBe(1);
    // freeze the capsule where it is (swiftshader frames take ~0.5 s, it walks ~0.8 m per frame) and look at it from 1 m
    await page.evaluate(() => {
      const g = window.__escape.game()!, o = g.mobs.byId.get(1)!.mesh, m = o.position, y = o.rotation.y;
      g.mobs.update = () => {};
      g.light = true;
      g.view = { x: m.x - Math.sin(y) * 1.0, y: m.y + 1.4, z: m.z - Math.cos(y) * 1.0, yaw: y + Math.PI, pitch: -0.15 };
    });
    await page.waitForTimeout(1500);
    await shot(page, 'test-results/mob.png');
    expect(await page.evaluate(() => window.__escape.game()!.mobs.byId.get(1)!.mesh.visible)).toBe(true);
  });
}
