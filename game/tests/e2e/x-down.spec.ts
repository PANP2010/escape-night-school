import { expect, test } from '@playwright/test';
import { shot } from './draw';
import WebSocket from 'ws';
import { assertDebugAvailable, nearPosition } from '../helpers.mjs';
import type { ServerMsg } from '../../shared/protocol.ts';

// 倒地 / 救援 / 观察者. debug('down') downs the page's own player; a Node ws bot walks up and holds `act revive` for 3 s.
test('downed player is revived by a teammate holding E (ws bot)', async ({ page, baseURL }) => {
  test.setTimeout(90_000);
  await page.goto('/?nodraw');
  await page.fill('#name', '甲');
  await page.click('#create');
  const code = await page.evaluate(async () => { while (!window.__escape.code) await new Promise((r) => setTimeout(r, 50)); return window.__escape.code; });

  const ws = new WebSocket(baseURL!.replace('http', 'ws') + '/ws');
  try {
  let myId = -1;
  const pos = new Map<number, { p: number[]; st: number }>();
  const states: { id: number; st: number; tick: number }[] = [];
  let incarnation = 0, readyIncarnation = 0;
  ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.t === 'welcome') myId = m.id;
    if (m.t === 'room' && m.started) incarnation = m.incarnation;
    if (m.t === 'event' && m.kind === 'intro' && !m.ended) ws.send(JSON.stringify({ t: 'intro-skip', id: m.id }));
    if (m.t === 'snap') for (const q of m.players) {
      pos.set(q.id, { p: q.p, st: q.st ?? 0 });
      states.push({ id: q.id, st: q.st ?? 0, tick: m.tick });
    }
    if (m.t === 'snap' && incarnation && readyIncarnation !== incarnation && pos.get(myId)?.st === 0) {
      readyIncarnation = incarnation;
      ws.send(JSON.stringify({ t: 'ready', incarnation }));
    }
  });
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ t: 'hello', name: 'bot' }));
  ws.send(JSON.stringify({ t: 'join', code }));
  await expect.poll(() => page.locator('#wait-members li').count()).toBe(2);
  await page.click('#start');
  await expect(page.locator('#hud')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => (window.__escape.game() as unknown as { spawnSynced: boolean })?.spawnSynced), { timeout: 15_000 }).toBe(true);
  await page.waitForFunction(() => !window.__escape.game()!.intro.active);
  await assertDebugAvailable(page);
  await page.evaluate(() => window.__escape.debug('safe', 600, 1));
  await expect.poll(() => pos.size, { timeout: 10_000 }).toBe(2);
  const host = [...pos.keys()].find((id) => id !== myId)!;
  // the level area is small now, so 角色074 patrols past the spawn and can catch the idle bot mid-test; this tests the revive, not him
  ws.send(JSON.stringify({ t: 'debug', op: 'safe', s: 600 }));

  await expect(page.locator('#banner')).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('#fade-overlay')).toBeHidden({ timeout: 10_000 });
  await page.evaluate(() => window.__escape.debug('down'));
  await expect(page.locator('#down-overlay')).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(500); // let the grey view and overlay settle for the screenshot
  await shot(page, 'test-results/iter-130-down.png');
  // bot stands next to the downed player, then holds revive for ~3.4 s
  const [x, y, z] = pos.get(host)!.p;
  const area = await page.evaluate(() => window.__escape.game()!.level.def.area);
  const target = nearPosition({ x, y, z }, area, 1, 0);
  ws.send(JSON.stringify({ t: 'debug', op: 'tp', x: target.x, z: target.z, floor: Math.round(target.y / 3.6) }));
  await expect.poll(() => { const p = pos.get(myId)?.p; return p ? Math.hypot(p[0] - target.x, p[1] - target.y, p[2] - target.z) : Infinity; },
    { timeout: 2500, message: 'server snapshot confirms the rescuer position' }).toBeLessThan(0.08);
  const t0 = Date.now();
  while (Date.now() - t0 < 3_600 && pos.get(host)!.st === 1) {
    ws.send(JSON.stringify({ t: 'act', kind: 'revive', id: host }));
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(Date.now() - t0).toBeGreaterThan(2_800); // it takes the full hold, not a tap
  await expect.poll(() => pos.get(host)!.st, { timeout: 3_000 }).toBe(0);
  const revivedAt = states.length;
  await expect(page.locator('#down-overlay')).toBeHidden({ timeout: 3_000 });
  await page.waitForTimeout(2000);
  expect(pos.get(host)!.st).toBe(0);
  const afterRevive = states.slice(revivedAt).filter((s) => s.id === host);
  expect(afterRevive.length).toBeGreaterThan(20);
  expect(afterRevive.every((s) => s.st === 0)).toBe(true);
  expect(await page.evaluate(() => window.__escape.game()!.spectate)).toBe(false);
  } finally { ws.close(); }
});

// With no standing rescuer, a full 30-second down timer must immediately lead to the same-seed retry.
test('lone downed player immediately wipes and restarts with the same seed', async ({ page }) => {
  test.setTimeout(120_000);
  const wire: { at: number; message: ServerMsg }[] = [];
  page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
    wire.push({ at: Date.now(), message: JSON.parse(payload.toString()) as ServerMsg });
  }));
  await page.goto('/?nodraw');
  await page.fill('#name', '甲');
  await page.click('#create');
  await page.click('#start');
  await expect(page.locator('#hud')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => window.__escape.game()?.snaps ?? 0), { timeout: 15_000 }).toBeGreaterThan(5);
  await page.waitForFunction(() => !window.__escape.game()!.intro.active);
  await assertDebugAvailable(page);
  await page.evaluate(() => window.__escape.debug('safe', 600, 1));
  const before = await page.evaluate(() => {
    const g = window.__escape.game() as any; return { seed: g.level.seed, level: g.level.index, incarnation: g.loadedIncarnation };
  });
  const started = Date.now();
  await page.evaluate(() => window.__escape.debug('down', 30));
  await expect(page.locator('#fade-overlay')).toBeVisible({ timeout: 2_000 });
  const fade = wire.find(({ at, message }) => at >= started && message.t === 'fade');
  expect(fade?.message).toMatchObject({ t: 'fade', restart: true });
  expect(fade!.at - started).toBeLessThan(1_000);
  await expect(page.locator('#fade-overlay')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('#down-overlay')).toBeHidden({ timeout: 10_000 });
  // the fade timer (client) and the first post-restart snap (server) land within a tick of each other, so poll
  await expect.poll(() => page.evaluate(() => (window.__escape.game() as unknown as { spectate: boolean }).spectate), { timeout: 15_000 }).toBe(false);
  expect(await page.evaluate(() => {
    const g = window.__escape.game() as any; return { seed: g.level.seed, level: g.level.index, incarnation: g.loadedIncarnation };
  })).toEqual({ ...before, incarnation: before.incarnation + 1 });
});
