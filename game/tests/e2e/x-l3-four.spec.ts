import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { ClientMsg, ServerMsg } from '../../shared/protocol.ts';
import { frame, setDraw } from './draw.ts';

type Snap = Extract<ServerMsg, { t: 'snap' }>;
type Warp = Extract<ServerMsg, { t: 'warp' }>;
type Wire = { urls: string[]; sent: ClientMsg[]; received: ServerMsg[]; snap?: Snap; errors: string[]; renderer?: string };

// Observe the real transport; do not replace the client's message handler or inject loop state.
function observeWire(page: Page): Wire {
  const wire: Wire = { urls: [], sent: [], received: [], errors: [] };
  page.on('pageerror', (error) => wire.errors.push(error.message));
  page.on('websocket', (ws) => {
    wire.urls.push(ws.url());
    ws.on('framereceived', ({ payload }) => {
      const message = JSON.parse(payload.toString()) as ServerMsg;
      if (message.t === 'snap') wire.snap = message;
      else if (message.t !== 'nav') wire.received.push(message);
    });
    ws.on('framesent', ({ payload }) => wire.sent.push(JSON.parse(payload.toString()) as ClientMsg));
    ws.on('socketerror', (error) => wire.errors.push(`WebSocket: ${error}`));
  });
  return wire;
}

const state = (page: Page) => page.evaluate(() => {
  const game = window.__escape.game()!;
  return {
    id: game.myId, x: game.pos.x, y: game.body.y, z: game.pos.z, level: game.level.index,
    corrections: game.corrections, progress: game.loopPlayers.get(game.myId),
    players: [...game.loopPlayers].sort(([a], [b]) => a - b),
    spectate: game.spectate, down: game.down, completed: game.completed,
  };
});

async function walk(page: Page, points: [number, number][]) {
  await page.evaluate((points) => {
    const game = window.__escape.game()!;
    window.__escape.autopilot([[game.pos.x, game.pos.z], ...points]);
  }, points);
  await expect.poll(() => page.evaluate(() => window.__escape.game()!.autopilotDone), { timeout: 30_000 }).toBe(true);
}

async function capture(page: Page, file: string) {
  await frame(page);
  await page.evaluate(() => (document.getElementById('e2e-shot') as HTMLImageElement).decode()
    .then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
  await page.screenshot({ path: `test-results/${file}.png` });
  await page.evaluate(() => document.getElementById('e2e-shot')?.remove());
}

async function finishOpening(page: Page) {
  const drawing = await page.evaluate(() => window.__escape.game()!.draw);
  await setDraw(page, true);
  try {
    await page.keyboard.press('Shift'); // Real first input, without changing position or view.
    await page.waitForFunction(() => window.__escape.game()!.openingComplete || !document.getElementById('banner')!.hidden);
    await page.waitForFunction(() => window.__escape.game()!.openingComplete && document.getElementById('banner')!.hidden);
  } finally { await setDraw(page, drawing); }
}

test('four lobby players reach L3: distinct spawns, personal door progress, four clean warps and slot-four touch walking', async ({ browser, baseURL }) => {
  test.setTimeout(300_000);
  const desktop = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 } });
  const touch = await browser.newContext({ baseURL, viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  const pages = [await desktop.newPage(), await desktop.newPage(), await desktop.newPage(), await touch.newPage()];
  const wires = pages.map(observeWire), [a, , , phone] = pages;
  const evidence: Record<string, unknown> = {};
  try {
    for (const [i, page] of pages.entries()) {
      await page.goto('/?nodraw&steady');
      await page.fill('#name', ['四人甲', '四人乙', '四人丙', '触屏丁'][i]);
    }
    await a.click('#create');
    await expect(a.locator('#wait-code')).not.toBeEmpty();
    const code = await a.locator('#wait-code').innerText();
    // Join in order so the independent touch context really owns spawn slot four.
    for (const page of pages.slice(1)) {
      await page.fill('#code', code); await page.click('#join');
    }
    await expect(a.locator('#wait-members li')).toHaveCount(4);
    await a.click('#start');
    await Promise.all(pages.map((page) => page.waitForFunction(() => {
      const game = window.__escape.game(); return game?.presentationReady && !game.intro.active;
    })));

    // Only L1/L2 setup uses debug inventory / position. Both transitions use normal server exit flow.
    for (const page of pages) await page.evaluate(() => {
      window.__escape.debug('safe', 600);
      window.__escape.debug('key', -1);
      window.__escape.debug('tp', -61, 66);
    });
    for (const page of pages) {
      await expect(page.locator('#room-code')).toContainText('第 2 关', { timeout: 30_000 });
      await page.waitForFunction(() => {
        const game = window.__escape.game(); return game?.presentationReady && game.body.y > 3 && !game.intro.active;
      });
      await expect(page.locator('#fade-overlay')).toBeHidden();
    }
    // Isolate movement/puzzle transport from NPC pursuit; these L2 mob grace timers survive the level load.
    await a.evaluate(() => {
      window.__escape.debug('safe', 600, 1); window.__escape.debug('safe', 600, 2);
      window.__escape.debug('key', -2); window.__escape.debug('tp', 40, 85);
    });
    await expect.poll(async () => (await state(a)).x).toBeCloseTo(40, 0);
    // Teleporting only places the fixture; it does not acknowledge the new spawn incarnation.
    // Take a real step and observe it on the authority before sending the first puzzle action.
    const hostId = (await state(a)).id;
    await walk(a, [[40, 84.2]]);
    await expect.poll(() => wires[0].snap?.players.find(player => player.id === hostId)?.p[2]).toBeLessThan(84.6);
    await walk(a, [[40, 85]]);
    for (let i = 0; i < 3; i++) await a.evaluate(() => window.__escape.net.send({ t: 'act', kind: 'fuse', id: 0 }));
    await expect(a.locator('#objective .g')).toContainText('集合');
    for (const page of pages) await page.evaluate(() => window.__escape.debug('tp', 20, 84.2));
    for (const page of pages) {
      await expect.poll(async () => (await state(page)).x).toBeCloseTo(20, 0);
      await page.evaluate(() => { const game = window.__escape.game()!; game.input.yaw = Math.PI / 2; game.input.press('KeyW'); });
    }
    await expect(a.locator('#fade-overlay')).toBeVisible({ timeout: 10_000 });
    await Promise.all(pages.map((page) => page.evaluate(() => window.__escape.game()!.input.release('KeyW'))));
    for (const [i, page] of pages.entries()) {
      await expect(page.locator('#room-code')).toContainText('第 3 关', { timeout: 30_000 });
      await expect(page.locator('#room-code')).toContainText('· 4 人');
      await page.waitForFunction(() => {
        const game = window.__escape.game(); return game?.presentationReady && game.body.y > 7 && !game.intro.active;
      });
      await expect(page.locator('#fade-overlay')).toBeHidden();
      expect(wires[i].urls).toEqual([`${baseURL!.replace(/^http/, 'ws')}/ws`]);
      expect(wires[i].received.some((message) => message.t === 'fade' && !message.restart)).toBe(true);
      expect(wires[i].sent.some((message) => message.t === 'input' && message.p[1] > 3 && message.p[1] < 4 && message.p[0] < 19)).toBe(true);
      wires[i].sent.length = 0; wires[i].received.length = 0;
    }

    const spawnStates = await Promise.all(pages.map(state));
    const spawns = await a.evaluate(() => window.__escape.game()!.level.def.spawns);
    const ids = spawnStates.map((value) => value.id);
    expect(new Set(ids).size).toBe(4);
    expect(new Set(spawnStates.map((value) => value.x.toFixed(1))).size).toBe(4);
    for (const [i, value] of spawnStates.entries()) {
      expect(value.x).toBeCloseTo(spawns[i].x, 1); expect(value.y).toBeCloseTo(7.2, 1); expect(value.z).toBeCloseTo(spawns[i].z, 1);
      expect(value.progress).toEqual({ step: 0, loops: 0, mistakes: 0 });
      expect(value.spectate).toBe(false); expect(value.down).toBe(false);
    }
    evidence.spawns = spawnStates;
    await expect(phone.locator('#touch')).toBeVisible();
    await expect(phone.locator('#touch-map')).toBeVisible();
    expect(await phone.evaluate(() => ({ touch: navigator.maxTouchPoints > 0, mobile: document.body.classList.contains('touch'), width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth })))
      .toEqual({ touch: true, mobile: true, width: 844, height: 390, overflow: false });
    // Capture all four unmodified spawn views before approaching the clue or taking a step.
    for (const [i, page] of pages.entries()) {
      await finishOpening(page);
      wires[i].renderer = await page.evaluate(() => {
        const gl = window.__escape.game()!.renderer.getContext(), extension = gl.getExtension('WEBGL_debug_renderer_info');
        return String(gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
      });
      await capture(page, `l3-four-spawn-slot${i + 1}${i === 3 ? '-touch' : ''}`);
    }

    // Only A crosses 303; every browser must keep all four independent progress entries.
    const door = await a.evaluate(() => window.__escape.game()!.level.def.loop!.doors.filter((value) => value.label === '303').at(-1)!);
    await walk(a, [[door.x, 84.2], [door.x, door.z - 1], [door.x, 84.2]]);
    const independent = ids.map((id, i) => [id, { step: i === 0 ? 1 : 0, loops: 0, mistakes: 0 }]);
    for (const page of pages) await expect.poll(async () => (await state(page)).players).toEqual(independent);

    // Approach through the corridor with ordinary walking, then cross together using held movement.
    await Promise.all(pages.map((page) => walk(page, [[20.2, 84.2]])));
    const beforeWarp = await Promise.all(pages.map(state));
    evidence.beforeWarp = beforeWarp;
    await Promise.all(pages.map(async (page, i) => {
      await page.evaluate(() => { const game = window.__escape.game()!; game.input.yaw = Math.PI / 2; game.input.press('KeyW'); });
      await expect.poll(() => wires[i].received.some((message) => message.t === 'warp' && message.id === ids[i]), { timeout: 10_000 }).toBe(true);
      await page.evaluate(() => window.__escape.game()!.input.release('KeyW'));
    }));
    const ownWarps = ids.map((id, i) => wires[i].received.find((message): message is Warp => message.t === 'warp' && message.id === id)!);
    expect(ownWarps.every(Boolean)).toBe(true);
    for (const [i, warp] of ownWarps.entries()) {
      expect(warp.p[0]).toBeGreaterThan(55); expect(warp.p[0]).toBeLessThanOrEqual(55.5);
      expect(warp.p[1]).toBeCloseTo(7.2, 1); expect(warp.p[2]).toBeCloseTo(beforeWarp[i].z, 1);
      expect(warp.yaw).toBeCloseTo(Math.PI / 2, 3);
    }
    for (const wire of wires) {
      await expect.poll(() => wire.received.filter((message) => message.t === 'warp')).toHaveLength(4);
      const warps = wire.received.filter((message): message is Warp => message.t === 'warp').sort((left, right) => left.id - right.id);
      expect(warps).toEqual([...ownWarps].sort((left, right) => left.id - right.id));
    }
    const afterLoop = ids.map((id, i) => [id, { step: i === 0 ? 1 : 0, loops: 1, mistakes: 0 }]);
    for (const page of pages) await expect.poll(async () => (await state(page)).players).toEqual(afterLoop);
    await Promise.all(pages.map((page) => walk(page, [[50, 84.2]])));
    for (const [i, page] of pages.entries()) {
      await expect.poll(() => wires[i].snap?.players.find((value) => value.id === ids[i])?.p[0]).toBeLessThan(50.5);
      expect(wires[i].sent.some((message) => message.t === 'input' && message.c === ownWarps[i].c && message.p[0] < ownWarps[i].p[0] - 3)).toBe(true);
      expect((await state(page)).corrections).toBe(spawnStates[i].corrections);
    }

    // The fourth browser also walks via a real touch stream, rather than only an emulated viewport.
    const phoneBeforeTouch = await state(phone), cdp = await touch.newCDPSession(phone);
    await phone.evaluate(() => { window.__escape.game()!.input.yaw = Math.PI / 2; });
    const stickY = Math.round(390 * 0.7);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 90, y: stickY, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 90, y: stickY - 36, id: 1 }] });
    try {
      await expect.poll(async () => (await state(phone)).x, { timeout: 5_000 }).toBeLessThan(phoneBeforeTouch.x - 0.5);
    } finally {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    }
    await expect.poll(() => phone.evaluate(() => [...window.__escape.game()!.input.keys])).toEqual([]);
    for (const [i, page] of pages.entries()) {
      const final = await state(page);
      expect(final.progress).toEqual({ step: i === 0 ? 1 : 0, loops: 1, mistakes: 0 });
      expect(final.completed).toBe(false); expect(final.spectate).toBe(false); expect(final.down).toBe(false);
      expect(wires[i].sent.some((message) => message.t === 'debug')).toBe(false);
      expect(wires[i].received.filter((message) => message.t === 'correct' && !message.forced)).toEqual([]);
      expect(wires[i].received.filter((message) => message.t === 'warp')).toHaveLength(4);
      expect(wires[i].errors).toEqual([]);
    }
    evidence.ownWarps = ownWarps;
    evidence.phoneTouch = { before: phoneBeforeTouch, after: await state(phone) };
  } finally {
    evidence.finalStates = await Promise.all(pages.map((page) => state(page).catch(() => null)));
    writeFileSync('test-results/l3-four-browser-wire.json', JSON.stringify({ evidence, wires }, null, 2));
    await Promise.all([desktop.close(), touch.close()]);
  }
});
