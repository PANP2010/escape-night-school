import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { ClientMsg, ServerMsg } from '../../shared/protocol.ts';
import { frame, setDraw } from './draw.ts';

type Snap = Extract<ServerMsg, { t: 'snap' }>;
type Wire = { urls: string[]; received: ServerMsg[]; sent: ClientMsg[]; snap?: Snap; errors: string[]; renderer?: string };
// Observe the actual WebSocket transport, without replacing Net.onMsg or injecting puzzle state.
function observeWire(p: Page): Wire {
  const w: Wire = { urls: [], received: [], sent: [], errors: [] };
  p.on('pageerror', (e) => w.errors.push(e.message));
  p.on('websocket', (ws) => {
    w.urls.push(ws.url());
    ws.on('framereceived', ({ payload }) => {
      const m = JSON.parse(payload.toString()) as ServerMsg;
      if (m.t === 'snap') w.snap = m;
      else if (m.t !== 'nav') w.received.push(m);
    });
    ws.on('framesent', ({ payload }) => w.sent.push(JSON.parse(payload.toString()) as ClientMsg));
    ws.on('socketerror', (error) => w.errors.push(`WebSocket: ${error}`));
  });
  return w;
}

const state = (p: Page) => p.evaluate(() => {
  const g = window.__escape.game()!;
  return { x: g.pos.x, y: g.body.y, z: g.pos.z, id: g.myId, level: g.level.index, c: g.corrections,
    cameraY: g.camera.position.y, spectate: g.spectate,
    progress: g.loopPlayers.get(g.myId), players: [...g.loopPlayers], completed: g.completed };
});
async function walk(p: Page, points: [number, number][]) {
  await p.evaluate((points) => {
    const g = window.__escape.game()!;
    window.__escape.autopilot([[g.pos.x, g.pos.z], ...points]);
  }, points);
  await expect.poll(() => p.evaluate(() => window.__escape.game()!.autopilotDone), { timeout: 30_000 }).toBe(true);
}
async function capture(p: Page, file: string) {
  await frame(p);
  await p.evaluate(() => (document.getElementById('e2e-shot') as HTMLImageElement).decode()
    .then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
  await p.screenshot({ path: `test-results/${file}.png` });
  await p.evaluate(() => document.getElementById('e2e-shot')?.remove());
}
async function finishOpening(p: Page) {
  const drawing = await p.evaluate(() => window.__escape.game()!.draw);
  await setDraw(p, true);
  try {
    await p.keyboard.press('Shift'); // Real first input, without changing position or view.
    await p.waitForFunction(() => window.__escape.game()!.openingComplete || !document.getElementById('banner')!.hidden);
    await p.waitForFunction(() => window.__escape.game()!.openingComplete && document.getElementById('banner')!.hidden);
  } finally { await setDraw(p, drawing); }
}
async function enter(p: Page, label: string) {
  const d = await p.evaluate((label) => window.__escape.game()!.level.def.loop!.doors.filter((d) => d.label === label).at(-1)!, label);
  // Autopilot stops within 0.3 m: leave enough clearance beyond the 0.39 m counting plane.
  await walk(p, [[d.x, 84.2], [d.x, d.z - 1], [d.x, 84.2]]);
}

test('L1 → L2 → L3 → L4: real door sequences, independent loops, observer and clean handoffs', async ({ browser, baseURL }) => {
  test.setTimeout(360_000);
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 } });
  const a = await context.newPage(), b = await context.newPage(), c = await context.newPage();
  const aw = observeWire(a), bw = observeWire(b), cw = observeWire(c);
  try {
    for (const [p, name] of [[a, '甲'], [b, '乙']] as const) {
      await p.goto('/?nodraw&steady'); await p.fill('#name', name);
    }
    await a.click('#create'); await expect(a.locator('#wait-code')).not.toBeEmpty();
    await b.fill('#code', await a.locator('#wait-code').innerText()); await b.click('#join');
    await expect(a.locator('#wait-members li')).toHaveCount(2); await a.click('#start');
    for (const p of [a, b]) await p.waitForFunction(() => {
      const g = window.__escape.game(); return g?.presentationReady && !g.intro.active;
    });
    // Set up L1/L2 inventory only; level progression itself goes through the ordinary authoritative exit flow.
    for (const p of [a, b]) await p.evaluate(() => { window.__escape.debug('safe', 600); window.__escape.debug('key', -1); window.__escape.debug('tp', -61, 66); });
    for (const p of [a, b]) {
      await expect(p.locator('#room-code')).toContainText('第 2 关', { timeout: 30_000 });
      await p.waitForFunction(() => {
        const g = window.__escape.game(); return g?.presentationReady && g.body.y > 3 && !g.intro.active;
      });
      await expect(p.locator('#fade-overlay')).toBeHidden();
      await p.evaluate(() => window.__escape.debug('safe', 600));
    }
    await a.evaluate(() => { window.__escape.debug('key', -2); window.__escape.debug('tp', 40, 85); });
    await expect.poll(() => {
      const p = aw.snap?.players.find(p => p.id === aw.received.find(m => m.t === 'welcome')?.id)?.p;
      return p ? Math.hypot(p[0] - 40, p[1] - 3.6, p[2] - 85) : Infinity;
    }).toBeLessThan(.08);
    await expect.poll(() => a.evaluate(() => (window.__escape.game() as any).bag.fuse)).toBe(3);
    for (let i = 1; i <= 3; i++) {
      await a.evaluate(() => window.__escape.net.send({ t: 'act', kind: 'fuse', id: 0 }));
      await expect.poll(() => a.evaluate(() => (window.__escape.game() as any).fusesIn)).toBe(i);
    }
    await expect(a.locator('#objective .g')).toContainText('集合');
    for (const p of [a, b]) await p.evaluate(() => window.__escape.debug('tp', 20, 84.2));
    // The last metres use held movement. Release on fade: an old waypoint must not run into the next level.
    for (const p of [a, b]) {
      await expect.poll(async () => (await state(p)).x).toBeCloseTo(20, 0);
      await p.evaluate(() => { const g = window.__escape.game()!; g.input.yaw = Math.PI / 2; g.input.press('KeyW'); });
    }
    await expect(a.locator('#fade-overlay')).toBeVisible({ timeout: 10_000 });
    await expect(a.locator('#fade-overlay')).toContainText('第 2 关 通过');
    for (const p of [a, b]) await p.evaluate(() => window.__escape.game()!.input.release('KeyW'));
    for (const [p, w] of [[a, aw], [b, bw]] as const) {
      await expect(p.locator('#room-code')).toContainText('第 3 关', { timeout: 30_000 });
      await p.waitForFunction(() => {
        const g = window.__escape.game(); return g?.presentationReady && g.body.y > 7 && !g.intro.active;
      });
      await expect(p.locator('#fade-overlay')).toBeHidden();
      expect(w.urls).toEqual([`${baseURL!.replace(/^http/, 'ws')}/ws`]);
      expect(w.received.some((m) => m.t === 'fade' && !m.restart)).toBe(true);
      expect(w.received.some((m) => m.t === 'room' && m.started && m.level === 2)).toBe(true);
      expect(w.sent.some((m) => m.t === 'input' && m.p[1] > 3 && m.p[1] < 4 && m.p[0] < 19)).toBe(true);
      expect(await p.evaluate(() => {
        const g = window.__escape.game()!, clue = g.level.def.loop!.clue;
        return Math.cos(g.input.yaw - Math.atan2(g.pos.x - clue.x, g.pos.z - clue.z));
      })).toBeCloseTo(1, 3);
      await p.evaluate(() => window.__escape.debug('safe', 600));
      w.sent.length = 0; w.received.length = 0;
    }
    await expect(a.locator('#objective .tip')).toContainText('303 → 301 → 304 → 302');
    await expect(a.locator('#objective .got')).toContainText('个人进度：门序 0/4');
    // Keep the actual spawn view as evidence: a later approach to the board could hide opening-camera clipping.
    for (const [p, w, file] of [[a, aw, 'l3-start-slot1'], [b, bw, 'l3-start-slot2']] as const) {
      await finishOpening(p);
      w.renderer = await p.evaluate(() => {
        const gl = window.__escape.game()!.renderer.getContext();
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return String(gl.getParameter(ext?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
      });
      await capture(p, file);
    }
    // Then read the clue and a numbered door from the corridor.
    await walk(a, [[54.7, 83.6]]);
    await a.evaluate(() => { const g = window.__escape.game()!; g.input.yaw = Math.PI; g.input.pitch = 0; });
    await capture(a, 'l3-clue-desktop');
    await a.setViewportSize({ width: 844, height: 390 });
    await capture(a, 'l3-clue-phone');
    await a.setViewportSize({ width: 1280, height: 720 });
    const firstDoor = await a.evaluate(() => window.__escape.game()!.level.def.loop!.doors.filter((d) => d.label === '303').at(-1)!);
    await walk(a, [[firstDoor.x, 84.2]]);
    await a.evaluate(() => { const g = window.__escape.game()!; g.input.yaw = 0; g.input.pitch = 0.18; });
    await capture(a, 'l3-door-desktop');
    // Door toggles alone must not count: progress requires crossing the real aperture.
    for (const open of [true, false]) {
      await a.evaluate((id) => window.__escape.net.send({ t: 'door', id }), firstDoor.id);
      await expect.poll(() => a.evaluate((id) => window.__escape.game()!.doorOpen[id], firstDoor.id)).toBe(open);
      expect((await state(a)).progress?.step).toBe(0);
    }
    await enter(a, '303'); expect((await state(a)).progress?.step).toBe(1);
    const aId = (await state(a)).id;
    // A third browser joins only now: it receives the existing personal states and watches from the real 3F eye height.
    await c.goto('/?nodraw&steady'); await c.fill('#name', '旁观丙');
    await c.fill('#code', await a.evaluate(() => window.__escape.code)); await c.click('#join');
    await expect(c.locator('#room-code')).toContainText('第 3 关');
    for (const p of [a, b, c]) await expect(p.locator('#room-code')).toContainText('· 3 人');
    await c.waitForFunction(() => {
      const g = window.__escape.game();
      return (g as any)?.spawnSynced && g!.spectate && g!.camera.position.y > 7;
    });
    await expect(c.locator('#spec-bar')).toBeVisible();
    await expect(c.locator('#spec-bar')).toContainText('自由飞行');
    expect((await state(c)).progress).toMatchObject({ step: 0, loops: 0, mistakes: 0 });
    await expect.poll(async () => (await state(c)).players).toEqual((await state(a)).players);
    // The late observer has no player opening banner. Its real spectator camera and synchronized
    // personal states above are ready; waiting for openingComplete would wait on a deliberately
    // suppressed banner forever (tickObjectiveBanner excludes spectate).
    await expect(c.locator('#banner')).toBeHidden();
    await capture(c, 'l3-late-observer');
    const bInitial = (await state(b)).progress;
    await enter(a, '302'); expect((await state(a)).progress).toMatchObject({ step: 0, mistakes: 1 });
    await expect.poll(async () => (await state(c)).players.find(([id]) => id === aId)?.[1]).toMatchObject({ step: 0, mistakes: 1 });
    expect((await state(b)).progress).toEqual(bInitial);
    await expect(a.locator('#objective .got')).toContainText('门序 0/4');
    await expect(a.locator('#objective .g')).toContainText('303');
    await enter(a, '303');
    const aProgress = (await state(a)).progress;
    await enter(b, '304'); expect((await state(b)).progress).toMatchObject({ step: 0, mistakes: 1 });
    expect((await state(a)).progress).toEqual(aProgress);
    await walk(a, [[20.2, 84.2]]);
    const before = await state(a), beforeB = await state(b);
    const seam = await a.evaluate(() => window.__escape.game()!.level.def.loop!);
    const sentBeforeWarp = aw.sent.length;
    // Cross the seam by holding movement, then stop after receiving its actual WebSocket event.
    await a.evaluate(() => { const g = window.__escape.game()!; g.input.yaw = Math.PI / 2; g.input.press('KeyW'); });
    await expect.poll(async () => (await state(a)).progress?.loops).toBe(1);
    await a.evaluate(() => window.__escape.game()!.input.release('KeyW'));
    expect((await state(a)).x).toBeGreaterThan(seam.endX + seam.shiftX - 2); expect((await state(a)).progress?.step).toBe(1);
    expect((await state(b)).progress).toEqual(beforeB.progress);
    await expect.poll(() => b.evaluate((id) => window.__escape.game()!.remotes.get(id)?.mesh.position.x ?? 0, before.id)).toBeGreaterThan(seam.endX + seam.shiftX - 2);
    const warp = aw.received.find((m): m is Extract<ServerMsg, { t: 'warp' }> => m.t === 'warp' && m.id === before.id);
    expect(warp).toBeDefined();
    expect(warp!.p[0]).toBeGreaterThan(seam.endX + seam.shiftX - 0.5); expect(warp!.p[0]).toBeLessThanOrEqual(seam.endX + seam.shiftX);
    expect(warp!.p[1]).toBeCloseTo(before.y, 1); expect(warp!.p[2]).toBeCloseTo(before.z, 1);
    expect(warp!.yaw).toBeCloseTo(Math.PI / 2, 3);
    expect(bw.received.find((m) => m.t === 'warp' && m.id === before.id)).toEqual(warp);
    expect(cw.received.find((m) => m.t === 'warp' && m.id === before.id)).toEqual(warp);
    await walk(a, [[50, 84.2]]);
    const afterWarp = await state(a);
    await expect.poll(() => aw.snap?.players.find((p) => p.id === before.id)?.p[0]).toBeCloseTo(afterWarp.x, 0);
    expect(aw.sent.slice(sentBeforeWarp).some((m) => m.t === 'input' && m.c === warp!.c && m.p[0] < warp!.p[0] - 3)).toBe(true);
    expect((await state(a)).c).toBe(before.c);
    expect(aw.received.filter((m) => m.t === 'correct')).toEqual([]);
    await expect(b.locator('#objective .got')).toContainText('门序 0/4');
    for (const n of ['301', '304', '302']) await enter(a, n);
    await expect(a.locator('#objective .g')).toContainText('所有人到西端绿色出口集合');
    await expect(a.locator('#objective .got')).toContainText('门序 4/4');
    await expect(a.locator('#objective .tip')).toContainText('你的循环已解除，等待队友');
    await walk(a, [[17.5, 84.2]]);
    expect((await state(a)).x).toBeLessThan(18);
    expect((await state(a)).progress?.loops).toBe(1);
    expect((await state(a)).completed).toBe(false);
    expect(aw.received.filter((m) => m.t === 'warp')).toHaveLength(1);
    await b.evaluate(() => window.__escape.game()!.input.press('Tab'));
    await expect(b.locator('#team')).toContainText('门序 4/4');
    await b.evaluate(() => window.__escape.game()!.input.release('Tab'));
    // Second player must independently do the whole sequence; no shared unlock.
    for (const n of ['303', '301', '304', '302']) await enter(b, n);
    await expect.poll(async () => (await state(a)).players.find(([id]) => id === beforeB.id)?.[1].step).toBe(4);
    await walk(b, [[17.5, 84.2]]);
    for (const [p, w] of [[a, aw], [b, bw], [c, cw]] as const) {
      await expect(p.locator('#room-code')).toContainText('第 4 关', { timeout: 15_000 });
      await p.waitForFunction(() => {
        const g = window.__escape.game(); return g?.presentationReady && g.level.index === 3 && !g.intro.active;
      });
      await expect(p.locator('#fade-overlay')).toBeHidden();
      await expect(p.locator('#objective .g')).toContainText('贴纸 0/4');
      await expect(p.locator('#broadcast-status')).toContainText('午夜广播');
      expect((await state(p)).level).toBe(3); expect((await state(p)).completed).toBe(false);
      expect(w.received.filter((m) => m.t === 'complete')).toEqual([]);
      expect(w.received.filter((m) => m.t === 'room').at(-1)).toMatchObject({ level: 3 });
      expect(w.received.filter((m) => m.t === 'broadcast').at(-1)).toMatchObject({ off: false, clues: [null, null, null, null] });
      expect(w.sent.some((m) => m.t === 'debug')).toBe(false);
      const forced = w.received.filter((m): m is Extract<ServerMsg, { t: 'correct' }> => m.t === 'correct');
      expect(forced).toHaveLength(2); // authoritative chapter spawn, then the intro's fresh prediction epoch
      for (const correction of forced) {
        expect(correction).toMatchObject({ forced: true }); expect(correction.ack).toBeUndefined();
        expect(correction.p[1]).toBeCloseTo(7.2, 1); expect(correction.p[0]).toBeLessThan(-17);
      }
      expect(forced[1].p).toEqual(forced[0].p);
      expect(forced[1].c).toBe(forced[0].c! + 1);
      expect(w.errors).toEqual([]);
    }
    expect((await state(a)).c).toBe(before.c); expect((await state(b)).c).toBe(beforeB.c);
    expect((await state(c)).cameraY).toBeGreaterThan(7);
    expect((await state(c)).progress).toBeUndefined();
    await expect.poll(async () => (await state(c)).players).toEqual((await state(a)).players);
    await capture(a, 'l3-to-l4-mainline');
  } finally {
    const finalStates = await Promise.all([a, b, c].map((p) => state(p).catch(() => null)));
    writeFileSync('test-results/l3-browser-wire.json', JSON.stringify({ a: aw, b: bw, c: cw, finalStates }, null, 2));
    await context.close();
  }
});
