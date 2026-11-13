import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import type { ServerMsg } from '../../shared/protocol.ts';

const view = (page: Page) => page.evaluate(() => {
  const g = window.__escape.game()!;
  return { body: [g.body.x, g.body.y, g.body.z], camera: g.camera.position.toArray(),
    direction: g.camera.getWorldDirection(g.camera.position.clone()).toArray(),
    active: g.intro.active, remaining: g.intro.remaining, draw: g.draw,
    renderedFrames: g.renderer.info.render.frame };
});

test('L1 real opening camera faces the western stairwell while the player stays at spawn', async ({ page }) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1280, height: 720 });
  const errors: string[] = [], intros: Extract<ServerMsg, { t: 'event'; kind: 'intro' }>[] = [];
  const spawns: Extract<ServerMsg, { t: 'correct' }>[] = [];
  let id = 0, serverBody: number[] | undefined;
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', ws => ws.on('framereceived', ({ payload }) => {
    const m = JSON.parse(String(payload)) as ServerMsg;
    if (m.t === 'welcome') id = m.id;
    if (m.t === 'snap') serverBody = m.players.find(p => p.id === id)?.p;
    if (m.t === 'correct' && m.forced) spawns.push(m);
    if (m.t === 'event' && m.kind === 'intro') intros.push(m);
  }));
  await mkdir('test-results/run-modes', { recursive: true });
  let initial: Awaited<ReturnType<typeof view>> | undefined;
  let flight: Awaited<ReturnType<typeof view>> | undefined;
  let finished: Awaited<ReturnType<typeof view>> | undefined;
  try {
    // Real WebGL rendering throughout: the screenshot captures the live cinematic camera.
    await page.goto('/?steady');
    await page.fill('#name', '西侧楼梯开场验收'); await page.click('#create'); await page.click('#start');
    await page.waitForFunction(() => {
      const g = window.__escape.game(); return g?.presentationReady && g.intro.active;
    });
    initial = await view(page);
    expect(initial.draw).toBe(true); expect(initial.renderedFrames).toBeGreaterThan(0);
    expect(initial.remaining).toBeGreaterThan(3.5);
    const plan = intros.find(m => !m.ended)!;
    expect(plan.route.at(-1)![0]).toBeLessThan(-50);
    expect(plan.silhouette![0]).toBeLessThan(-55);
    expect(Math.hypot(plan.silhouette![0] + 61, plan.silhouette![2] - 66)).toBeLessThan(12);
    await page.keyboard.down('KeyW'); // A genuine held movement key cannot move the body during the intro.
    await page.waitForFunction(() => {
      const g = window.__escape.game(); return g?.intro.active && g.intro.remaining < 2.75 && g.intro.remaining > 2.4;
    });
    flight = await view(page);
    await page.screenshot({ path: 'test-results/run-modes/l1-western-stairwell-5s.png' });
    await page.keyboard.up('KeyW');
    expect(flight.body).toEqual(initial.body); expect(serverBody).toEqual(initial.body);
    expect(flight.camera[0]).toBeLessThan(-50);
    expect(flight.camera[0]).toBeLessThan(initial.body[0] - 8);
    expect(flight.direction[0]).toBeLessThan(0); expect(flight.direction[2]).toBeLessThan(-.65);
    const dx = plan.silhouette![0] - flight.camera[0], dz = plan.silhouette![2] - flight.camera[2];
    expect((flight.direction[0] * dx + flight.direction[2] * dz) / Math.hypot(dx, dz)).toBeGreaterThan(.99);
    await page.waitForFunction(() => !window.__escape.game()!.intro.active, null, { timeout: 15_000 });
    await expect.poll(async () => {
      const s = await view(page); return Math.hypot(s.camera[0] - s.body[0], s.camera[2] - s.body[2]);
    }).toBeLessThan(.02);
    finished = await view(page);
    expect(finished.body).toEqual(spawns.at(-1)!.p); expect(finished.active).toBe(false);
    // Snapshots round positions to centimetres; the end event restores the exact server-issued spawn.
    expect(Math.hypot(...finished.body.map((n, i) => n - initial!.body[i]))).toBeLessThan(.01);
    expect(finished.camera[1] - finished.body[1]).toBeGreaterThan(1);
    expect(intros.at(-1)).toMatchObject({ ended: true, skipped: [] });
    expect(errors).toEqual([]);
  } finally {
    await page.keyboard.up('KeyW');
    await writeFile('test-results/run-modes/l1-intro-camera.json', JSON.stringify({ initial, flight, finished, intros, spawns, serverBody, errors }, null, 2));
  }
});
