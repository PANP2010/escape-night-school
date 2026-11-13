import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { ClientMsg, ServerMsg } from '../../shared/protocol.ts';
import { shot } from './draw.ts';

const state = (page: Page) => page.evaluate(() => {
  const g = window.__escape.game()!;
  return { id: g.myId, p: [g.pos.x, g.body.y, g.pos.z], c: g.corrections, progress: g.loopPlayers.get(g.myId) };
});
async function walk(page: Page, points: [number, number][]) {
  await page.evaluate(points => {
    const g = window.__escape.game()!;
    window.__escape.autopilot([[g.pos.x, g.pos.z], ...points]);
  }, points);
  await expect.poll(() => page.evaluate(() => window.__escape.game()!.autopilotDone), { timeout: 30_000 }).toBe(true);
}

test('L3: return through 301 west door stays put; only a real westward corridor crossing loops', async ({ page }) => {
  test.setTimeout(120_000);
  const received: ServerMsg[] = [], sent: ClientMsg[] = [], errors: string[] = [];
  let snapshots = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', ws => {
    ws.on('framereceived', ({ payload }) => {
      const m = JSON.parse(String(payload)) as ServerMsg;
      if (m.t === 'snap') snapshots++;
      else if (m.t !== 'nav') received.push(m);
    });
    ws.on('framesent', ({ payload }) => sent.push(JSON.parse(String(payload)) as ClientMsg));
    ws.on('socketerror', error => errors.push(`WebSocket: ${error}`));
  });
  try {
    await page.goto('/?nodraw&steady');
    await page.fill('#name', '301西门回归'); await page.click('#create'); await page.click('#start');
    await page.waitForFunction(() => {
      const g = window.__escape.game(); return g?.presentationReady && !g.intro.active;
    });
    // Only choose the chapter and silence enemies. Puzzle progress, door use and every metre below use real inputs.
    await page.evaluate(() => window.__escape.debug('level', 2));
    await page.waitForFunction(() => {
      const g = window.__escape.game(); return g?.presentationReady && g.level.index === 2 && !g.intro.active;
    });
    await page.evaluate(() => window.__escape.debug('safe', 600));
    const init = snapshots;
    await expect.poll(() => snapshots).toBeGreaterThan(init + 2);
    received.length = 0; sent.length = 0;

    const doors = await page.evaluate(() => window.__escape.game()!.level.def.loop!.doors);
    const first = doors.filter(d => d.label === '303').at(-1)!;
    await walk(page, [[first.x, 84.2], [first.x, first.z - 1], [first.x, 84.2]]);
    await expect.poll(async () => (await state(page)).progress?.step).toBe(1);
    const east = doors.filter(d => d.label === '301').at(-1)!, west = doors.find(d => d.label === '301')!;
    await walk(page, [[east.x, 84.2], [east.x, east.z - 1], [west.x, west.z - 1], [west.x, 84.2]]);
    await expect.poll(async () => (await state(page)).progress?.step).toBe(2);
    expect((await state(page)).p[0]).toBeLessThan(17);
    expect((await state(page)).progress?.loops).toBe(0);
    expect(received.filter(m => m.t === 'warp')).toEqual([]);

    // Even standing/turning behind the line must not teleport; wait on real server snapshots rather than a timer.
    await page.evaluate(() => { const g = window.__escape.game()!; g.input.yaw += Math.PI; });
    const stopped = snapshots;
    await expect.poll(() => snapshots).toBeGreaterThan(stopped + 3);
    expect((await state(page)).p[0]).toBeLessThan(17);
    expect((await state(page)).progress).toMatchObject({ step: 2, loops: 0, mistakes: 0 });

    await walk(page, [[22, 84.2]]); // Eastward crossing is safe too.
    expect((await state(page)).progress?.loops).toBe(0);
    expect(received.filter(m => m.t === 'warp')).toEqual([]);
    const seam = await page.evaluate(() => {
      const g = window.__escape.game()!, seam = g.scene.getObjectByName('loop-seam')!;
      g.input.yaw = Math.PI / 2; g.input.pitch = -.5;
      return { p: seam.position.toArray(), endX: g.level.def.loop!.endX };
    });
    expect(seam.p[0]).toBe(seam.endX); expect(seam.p[1]).toBeCloseTo(7.225, 3);
    await shot(page, 'test-results/l3-door-return-seam.png');
    await walk(page, [[20.2, 84.2]]);
    await page.evaluate(() => { window.__escape.game()!.input.yaw = Math.PI / 2; });
    const before = await state(page);
    await page.evaluate(() => window.__escape.game()!.input.press('KeyW'));
    await expect.poll(() => received.filter(m => m.t === 'warp')).toHaveLength(1);
    await page.evaluate(() => window.__escape.game()!.input.release('KeyW'));
    await expect.poll(async () => (await state(page)).progress?.loops).toBe(1);
    const after = await state(page);
    expect(after.p[0]).toBeGreaterThan(53); // Real held movement can continue until the observed warp releases W.
    expect(after.progress).toMatchObject({ step: 2, loops: 1, mistakes: 0 });
    expect(after.c).toBe(before.c);
    expect(received.filter(m => m.t === 'correct')).toEqual([]);
    const warp = received.find((m): m is Extract<ServerMsg, { t: 'warp' }> => m.t === 'warp')!;
    expect(warp.id).toBe(before.id); expect(warp.p[0]).toBeGreaterThan(55); expect(warp.p[1]).toBeCloseTo(7.2, 3);
    await walk(page, [[50, 84.2]]);
    expect((await state(page)).progress?.loops).toBe(1);
    expect(sent.some(m => m.t === 'input' && m.c === warp.c && m.p[0] < 52)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    writeFileSync('test-results/l3-door-return-wire.json', JSON.stringify({ received, sent, snapshots, errors, state: await state(page).catch(() => null) }, null, 2));
  }
});
