// A2c royale zone e2e (lane: playwright.royale.config.ts, 75 s grace / 20 s phases): two real browser contexts on one ws room.
// Startup walks with keyboard/touch before any debug. The zone test teleports and watches server-decided elimination.
import { test, expect, type Page } from '@playwright/test';
import { F_LIGHT, type ClientMsg, type ServerMsg } from '../../shared/protocol.ts';
import { gateStorageState } from '../gate-settings.ts';
import { frame } from './draw.ts';

test.describe.configure({ timeout: 240_000 });

const gameURL = process.env.ESC_GPU ? '/' : '/?nodraw';
const sceneShot = async (p: Page, path: string) => {
  // Zone fog and settlement panels intentionally cover the scene. Render a real frame beneath them.
  if (!process.env.ESC_GPU) await frame(p);
  try { return await p.screenshot({ path }); }
  finally { if (!process.env.ESC_GPU) await p.evaluate(() => document.getElementById('e2e-shot')?.remove()); }
};

/** Tap the real socket before start: a later debug teleport would repair the missing spawn epoch. */
function startupWire(p: Page) {
  const received: ServerMsg[] = [], inputs: Extract<ClientMsg, { t: 'input' }>[] = [];
  let warden: number[] | undefined;
  const wardenSamples: { p: number[]; tick: number }[] = [];
  p.on('websocket', ws => {
    ws.on('framereceived', ({ payload }) => {
      const m = JSON.parse(String(payload)) as ServerMsg;
      if (m.t === 'room' || m.t === 'correct') received.push(m);
      if (m.t === 'snap') {
        const mob = m.mobs.find(v => v.id === 1);
        if (mob) { warden = [...mob.p]; wardenSamples.push({ p: warden, tick: m.tick }); }
      }
    });
    ws.on('framesent', ({ payload }) => {
      const m = JSON.parse(String(payload)) as ClientMsg;
      if (m.t === 'input') inputs.push(m);
    });
  });
  return { received, inputs, warden: () => warden, wardenSamples };
}
const pose = (p: Page) => p.evaluate(() => {
  const g = window.__escape.game() as any;
  return { id: g.myId as number, local: [g.pos.x, g.body.y, g.pos.z] as number[],
    server: g.peers.get(g.myId)?.p as number[] | undefined, c: g.corrC as number, f: g.myF as number, light: g.light as boolean };
});
const distance = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]));

/** Real keyboard / stick input, trying another direction if the random spawn faces a wall. No debug calls. */
async function walkFromSpawn(p: Page, touch: boolean) {
  const before = await pose(p), cdp = touch ? await p.context().newCDPSession(p) : undefined;
  const sy = Math.round(p.viewportSize()!.height * 0.7);
  for (const [key, dx, dy] of [['w', 0, -45], ['s', 0, 45], ['a', -45, 0], ['d', 45, 0],
    ['wa', -45, -45], ['wd', 45, -45], ['sa', -45, 45], ['sd', 45, 45]] as const) {
    if (cdp) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 90, y: sy, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 90 + dx, y: sy + dy, id: 1 }] });
    } else for (const k of key) await p.keyboard.down(k);
    await p.waitForFunction(at => {
      const g = window.__escape.game() as any;
      return Math.hypot(g.pos.x - at[0], g.body.y - at[1], g.pos.z - at[2]) >= 3;
    }, before.local, { timeout: 4000 }).catch(error => { if (error.name !== 'TimeoutError') throw error; });
    if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    else for (const k of key) await p.keyboard.up(k);
    console.log('spawn walk', JSON.stringify({ touch, key, before, after: await pose(p) }));
    if (distance((await pose(p)).local, before.local) >= 3) break;
  }
  await cdp?.detach();
  expect(distance((await pose(p)).local, before.local), 'walk at least 3 m before the first debug teleport').toBeGreaterThanOrEqual(3);
  return before;
}

type ZoneState = { phase: number; center: [number, number]; radius: number; remainingMs: number; alive: number };
const zoneOf = (p: Page) => p.evaluate(() => (window.__escape.game() as any)?.royaleZone as ZoneState | undefined);
const hud = (p: Page) => p.evaluate(() => ({
  head: document.querySelector('.zh-head')?.textContent ?? '',
  status: document.querySelector('.zh-status')?.textContent ?? '',
  alive: document.querySelector('.zh-alive')?.textContent ?? '',
  state: document.getElementById('zone-hud')?.dataset.state ?? '',
  fog: parseFloat((document.getElementById('zone-fog') as HTMLElement | null)?.style.getPropertyValue('--zf') || '0'),
}));
/** Record every royale message this client receives (installed once; reads back via window.__royaleMsgs). */
const tap = (p: Page) => p.evaluate(() => {
  const w = window as any, net = window.__escape.net, prev = net.onMsg;
  w.__royaleMsgs = [];
  net.onMsg = (m: any) => { if (m.t === 'royale-eliminated' || m.t === 'royale-settle') w.__royaleMsgs.push(m); prev(m); };
});
const msgs = (p: Page) => p.evaluate(() => (window as any).__royaleMsgs as any[]);
/** Corners of the campus nav extent (x ±126, z -35.7..204.3), kept 3 m inside; the one farthest from a circle is a safe place to be out of it. */
const CAMPUS_CORNERS: [number, number][] = [[-123, 201], [123, 201], [-123, -32], [123, -32]];
const where = (p: Page) => p.evaluate(() => { const g = window.__escape.game() as any; return `pos ${g.pos.x.toFixed(1)},${g.pos.z.toFixed(1)}`; });
const tp = (p: Page, x: number, z: number) => p.evaluate(([a, b]) => window.__escape.debug('tp', a, b), [x, z]);
const ready = (p: Page) => p.waitForFunction(() => {
  const g = window.__escape.game() as any;
  return g?.presentationReady && !g.intro.active && g.snaps > 3 && g.royaleZone;
}, null, { timeout: 40_000 });

test('R41-1 / A1 royale: authoritative spawn movement, then Warden follows the campus route beyond L1', async ({ browser, baseURL }, testInfo) => {
  const storageState = gateStorageState(baseURL!);
  const motionVideo = !!process.env.ESC_ROYALE_VIDEO;
  const viewport = process.env.ESC_GPU ? { width: 1280, height: 720 } : { width: 640, height: 400 };
  const observerViewport = motionVideo && process.env.ESC_GPU ? { width: 1280, height: 720 } : { width: 640, height: 400 };
  const ctxIn = await browser.newContext({ viewport,
    storageState });
  const ctxOut = await browser.newContext({ viewport: observerViewport, isMobile: true, hasTouch: true, storageState,
    recordVideo: process.env.ESC_ROYALE_VIDEO ? { dir: 'test-results/a2c-videos', size: observerViewport } : undefined });
  const inPg = await ctxIn.newPage();
  const videoOpened = Date.now();
  const outPg = await ctxOut.newPage();
  const wires = [startupWire(inPg), startupWire(outPg)];

  try {
    await inPg.goto(gameURL);
    await inPg.fill('#name', 'Inside');
    await inPg.selectOption('#mode-selector', 'royale');
    await inPg.click('#create');
    const code = await inPg.evaluate(async () => { while (!window.__escape.code) await new Promise(r => setTimeout(r, 50)); return window.__escape.code; });
    await outPg.goto(gameURL);
    await outPg.fill('#name', 'Outside');
    await outPg.fill('#code', code);
    await outPg.click('#join');
    await expect(inPg.locator('#wait-members li')).toHaveCount(2);
    await inPg.click('#start');
    await Promise.all([ready(inPg), ready(outPg)]);

    // R41-1: verify the initial correction and authoritative movement/light BEFORE any debug command.
    for (const [i, p, other] of [[0, inPg, outPg], [1, outPg, inPg]] as const) {
      const before = await walkFromSpawn(p, i === 1);
      if (i === 1) await p.locator('.touch-btn', { hasText: '手电' }).tap();
      else await p.keyboard.press('f');
      await expect.poll(async () => (await pose(p)).light).toBe(true);
      console.log('royale startup before debug', JSON.stringify({ client: i, before, observed: await pose(p),
        inputEpochs: wires[i].inputs.map(m => m.c), received: wires[i].received }));
      await expect.poll(async () => {
        const s = await pose(p);
        return distance(s.server!, before.server!);
      }, { message: 'server must accept movement before the first debug teleport' }).toBeGreaterThanOrEqual(3);
      await expect.poll(async () => { const s = await pose(p); return distance(s.local, s.server!); }).toBeLessThan(0.5);
      await expect.poll(async () => (await pose(p)).f & F_LIGHT, { message: 'server F_LIGHT must follow the torch' }).toBe(F_LIGHT);
      const after = await pose(p);
      await expect.poll(() => other.evaluate(({ id, at }) => {
        const r = (window.__escape.game() as any).remotes.get(id);
        return r ? Math.hypot(r.mesh.position.x - at[0], r.mesh.position.y - at[1], r.mesh.position.z - at[2]) : Infinity;
      }, { id: after.id, at: after.server! })).toBeLessThan(0.5);
      await expect.poll(async () => (await other.evaluate(id => (window.__escape.game() as any).remotes.get(id)?.f ?? 0, after.id)) & F_LIGHT).toBe(F_LIGHT);
      const wire = wires[i], room = wire.received.findIndex(m => m.t === 'room' && m.started);
      const correction = wire.received.findIndex((m, index) => index > room && m.t === 'correct' && m.forced);
      const spawn = wire.received[correction];
      expect(room).toBeGreaterThanOrEqual(0);
      expect(correction, 'started room must arm pending before the initial correct').toBeGreaterThan(room);
      if (spawn.t !== 'correct') throw new Error('Expected spawn correction');
      expect(spawn.c).toBeGreaterThan(0);
      expect(after.c, 'spawn correction must be applied').toBe(spawn.c);
      expect(wire.inputs.length).toBeGreaterThan(0);
      expect(wire.inputs.every(m => m.c === spawn.c), 'all inputs must carry the current spawn epoch').toBe(true);
      await testInfo.attach(`startup-${i === 0 ? 'desktop' : 'mobile'}`, { body: JSON.stringify({ before, after, spawn,
        messages: wire.received, inputEpochs: wire.inputs.map(m => m.c) }, null, 2), contentType: 'application/json' });
    }

    // A1: an explicit last-known target, not supernatural sight across the campus. Summon Warden at
    // A's south entrance, 64 m from the target and beyond sight, so his remembered route must cross the L1 boundary.
    await tp(inPg, -40, 0);
    await tp(outPg, -34, motionVideo ? 57 : 50);
    await expect.poll(async () => distance((await pose(inPg)).server!, [-40, 0, 0])).toBeLessThan(0.5);
    // The nearby observer is protected; the explicit summon below clears only its target's protection.
    await inPg.evaluate(() => window.__escape.debug('safe', 600));
    const lookAtWarden = (at: number[]) => outPg.evaluate(at => {
      const g = window.__escape.game() as any;
      g.input.yaw = Math.atan2(-(at[0] - g.pos.x), -(at[2] - g.pos.z)); g.input.pitch = 0;
    }, at);
    await lookAtWarden([-40, 0, 64]);
    await inPg.evaluate(() => { const g = window.__escape.game() as any; g.input.yaw = Math.PI; g.input.pitch = 0; });
    await expect.poll(() => inPg.evaluate(() => (window.__escape.game() as any).peers.get((window.__escape.game() as any).myId)?.yaw))
      .toBeCloseTo(Math.PI, 1);
    if (motionVideo && !process.env.ESC_GPU) {
      // Keep the real scene/simulation, but reduce only its backing buffer on this CPU renderer.
      // The recording still includes the full HUD; frame timing below decides whether motion is usable.
      await outPg.evaluate(async () => {
        const g = window.__escape.game() as any;
        g.renderer.setPixelRatio(0.375);
        // ?nodraw skips the normal startup warmup; compile Warden before timing his first visible walk.
        await g.mobs.prewarm(g.renderer, g.camera);
      });
      await frame(outPg);
      await outPg.evaluate(() => {
        document.getElementById('e2e-shot')?.remove();
        const g = window.__escape.game() as any;
        g.draw = true; g.renderer.domElement.style.visibility = '';
      });
    }
    if (motionVideo) await outPg.evaluate(() => {
      const g = window.__escape.game() as any, w = window as any;
      const render = g.renderer.render;
      const capture = w.__a1Motion = { active: false, stopped: false, raf: [] as number[], renders: [] as number[],
        restore: () => { g.renderer.render = render; } };
      g.renderer.render = function (this: any, ...args: any[]) {
        const result = render.apply(this, args);
        if (capture.active) capture.renders.push(performance.now());
        return result;
      };
      const observe = (t: number) => {
        if (capture.stopped) return;
        if (capture.active) capture.raf.push(t);
        requestAnimationFrame(observe);
      };
      requestAnimationFrame(observe);
    });
    const summonFrom = wires[0].wardenSamples.length, observerSummonFrom = wires[1].wardenSamples.length, started = Date.now();
    await inPg.evaluate(() => { window.__escape.debug('safe', 600, 2); window.__escape.debug('warden', 64); });
    // A slow rendered frame may deliver several real WS snapshots together. Preserve the actual spawn sample.
    const summoned = () => wires[0].wardenSamples.slice(summonFrom).find(s => distance(s.p, [-40, 0, 64]) < 1);
    await expect.poll(summoned).toBeDefined();
    const target = [-40, 0, 0], initial = [...summoned()!.p];
    const samples = [{ ms: 0, p: initial }];
    if (motionVideo) {
      // Both sockets must have seen the summon before the observer starts following its live route.
      await expect.poll(() => wires[1].wardenSamples.slice(observerSummonFrom).find(s => distance(s.p, [-40, 0, 64]) < 1)).toBeDefined();
      const clipStarted = await outPg.evaluate(() => {
        const capture = (window as any).__a1Motion;
        capture.active = true; capture.startedWallMs = Date.now(); capture.startedPerformanceMs = performance.now();
        return capture.startedWallMs as number;
      });
      let following = false;
      while (Date.now() - clipStarted < 15_000) {
        const at = wires[1].warden()!;
        await lookAtWarden(at);
        const d = distance((await pose(outPg)).local, at);
        if (d > 9 && !following) { await outPg.keyboard.down('w'); following = true; }
        else if (d < 7 && following) { await outPg.keyboard.up('w'); following = false; }
        samples.push({ ms: Date.now() - started, p: [...wires[0].warden()!] });
        await outPg.waitForTimeout(Math.max(0, Math.min(100, 15_000 - (Date.now() - clipStarted))));
      }
      await outPg.keyboard.up('w');
      const frames = await outPg.evaluate(() => {
        const capture = (window as any).__a1Motion;
        capture.active = false; capture.stopped = true; capture.restore();
        const g = window.__escape.game() as any, gl = g.renderer.getContext();
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        return { renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          width: g.renderer.domElement.width, height: g.renderer.domElement.height,
          calls: g.renderer.info.render.calls, triangles: g.renderer.info.render.triangles,
          startedWallMs: capture.startedWallMs, startedPerformanceMs: capture.startedPerformanceMs,
          endedWallMs: Date.now(), endedPerformanceMs: performance.now(), raf: capture.raf, renders: capture.renders };
      });
      const timing = { videoOpenedWallMs: videoOpened, clipStartedWallMs: frames.startedWallMs, clipEndedWallMs: frames.endedWallMs,
        startSeconds: (frames.startedWallMs - videoOpened) / 1000, endSeconds: (frames.endedWallMs - videoOpened) / 1000,
        durationSeconds: (frames.endedWallMs - frames.startedWallMs) / 1000 };
      const maxGap = (times: number[]) => times.reduce((max, t, i) => i ? Math.max(max, t - times[i - 1]) : max, 0);
      await testInfo.attach('A1-motion-video', { body: JSON.stringify({ ...timing, frames }, null, 2), contentType: 'application/json' });
      console.log('A1 motion video timing', JSON.stringify({ ...timing, rafFrames: frames.raf.length, renderFrames: frames.renders.length,
        maxRafGapMs: maxGap(frames.raf), maxRenderGapMs: maxGap(frames.renders) }));
    } else {
      for (let i = 0; i < 15; i++) {
        await inPg.waitForTimeout(1000);
        samples.push({ ms: Date.now() - started, p: [...wires[0].warden()!] });
        await lookAtWarden(wires[0].warden()!);
      }
    }
    const final = wires[0].warden()!;
    const finalTick = wires[0].wardenSamples.at(-1)!.tick;
    await testInfo.attach('A1-campus-route', { body: JSON.stringify({ target, initial, final, samples }, null, 2), contentType: 'application/json' });
    console.log('A1 campus route', JSON.stringify({ initial, final, improvement: distance(initial, target) - distance(final, target), videoOffsetSeconds: (started - videoOpened) / 1000 }));
    expect(distance(initial, target) - distance(final, target), 'Warden must approach the remembered target along the real campus route').toBeGreaterThanOrEqual(10);
    expect(final[2], 'Warden must pass beyond the L1 south boundary').toBeLessThan(60);
    await expect.poll(() => {
      const other = wires[1].wardenSamples.find(s => s.tick === finalTick);
      return other ? distance(other.p, final) : Infinity;
    }, { message: 'both independent clients receive the same authoritative Warden position at the same server tick' }).toBeLessThan(0.5);
    await sceneShot(outPg, 'test-results/a1-campus-route.png');

    // The client must agree with authority about the removed campaign grate as well.
    await inPg.evaluate(() => window.__escape.debug('safe', 600));
    await tp(inPg, -40, 60);
    await expect.poll(async () => distance((await pose(inPg)).server!, [-40, 0, 60])).toBeLessThan(0.5);
    await inPg.keyboard.down('Shift'); await inPg.keyboard.down('w');
    try {
      await inPg.waitForFunction(() => (window.__escape.game() as any).pos.z > 65, null, { timeout: 10_000 });
    } finally {
      await inPg.keyboard.up('w'); await inPg.keyboard.up('Shift');
    }
    await expect.poll(async () => (await pose(inPg)).server![2]).toBeGreaterThan(65);
    await expect.poll(async () => { const s = await pose(inPg); return distance(s.local, s.server!); }).toBeLessThan(0.5);
  } finally {
    await outPg.keyboard.up('w').catch(() => {});
    await ctxIn.close(); await ctxOut.close();
    if (outPg.video()) console.log('A1 recording', await outPg.video()!.path());
  }
});

test('A2c royale: the circle shrinks, the player left outside is eliminated by the server, the one inside wins', async ({ browser, baseURL }) => {
  const storageState = gateStorageState(baseURL!);
  const ctxIn = await browser.newContext({ viewport: { width: 640, height: 400 }, storageState });
  const ctxOut = await browser.newContext({ viewport: { width: 640, height: 400 }, storageState });
  const inPg = await ctxIn.newPage(), outPg = await ctxOut.newPage();

  await inPg.goto(gameURL);
  await inPg.fill('#name', 'Inside');
  await inPg.selectOption('#mode-selector', 'royale');
  await inPg.click('#create');
  const code = await inPg.evaluate(async () => { while (!window.__escape.code) await new Promise(r => setTimeout(r, 50)); return window.__escape.code; });
  await outPg.goto(gameURL);
  await outPg.fill('#name', 'Outside');
  await outPg.fill('#code', code);
  await outPg.click('#join');
  await expect(inPg.locator('#wait-members li')).toHaveCount(2);
  await inPg.click('#start');
  await Promise.all([ready(inPg), ready(outPg)]);
  await tap(inPg); await tap(outPg);
  // This case exercises the zone timer; campus-wide NPC pursuit is covered above.
  await inPg.evaluate(() => window.__escape.debug('safe', 600));

  // Phase 0: the big circle [0,100] r145. Immediately bring both players to its centre (they spawn randomly, might be outside).
  const z0 = (await zoneOf(inPg))!;
  expect(z0.phase, 'clients took longer than the 75 s grace to load').toBe(0);
  expect(z0.remainingMs).toBeGreaterThan(20_000);
  await tp(inPg, z0.center[0], z0.center[1]);
  await tp(outPg, z0.center[0], z0.center[1] - 10);
  await inPg.waitForTimeout(1500);
  await outPg.waitForTimeout(1500);
  // Both should now be inside and alive
  await inPg.waitForFunction(() => (document.querySelector('.zh-alive')?.textContent || '').includes('存活 2'), null, { timeout: 5_000 });
  expect((await hud(outPg)).state).not.toBe('out');
  expect((await hud(outPg)).alive).toMatch(/存活 2/);

  // 1/3 outside: the second player is sent beyond the rim and the HUD turns red with fog; P-in stays calm.
  const far0 = CAMPUS_CORNERS.map(([x, z]) => ({ x, z, d: Math.hypot(x - z0.center[0], z - z0.center[1]) })).sort((a, b) => b.d - a.d)[0];
  expect(far0.d, 'a campus corner outside the initial circle').toBeGreaterThan(z0.radius + 5);
  await tp(outPg, far0.x, far0.z);
  await outPg.waitForTimeout(2500);
  const out1 = await hud(outPg), in1 = await hud(inPg);
  expect(out1.state, `after tp to ${far0.x},${far0.z}: ${await where(outPg)}`).toBe('out'); expect(out1.status).toMatch(/圈外/); expect(out1.fog).toBeGreaterThan(0.3);
  expect(in1.state).not.toBe('out'); expect(in1.fog).toBeLessThan(0.3);
  await sceneShot(outPg, 'test-results/a2c-1-outside.png');

  // 2/3 back inside: the timer clears, the fog recedes.
  await tp(outPg, z0.center[0], z0.center[1] - 10);
  await outPg.waitForTimeout(2500);
  const back = await hud(outPg);
  expect(back.state).not.toBe('out'); expect(back.fog).toBeLessThan(0.3);
  expect(await msgs(outPg)).toEqual([]); // 2.5 s out never reached the 8 s limit
  await sceneShot(outPg, 'test-results/a2c-2-reentered.png');

  // 3/3 new circle: after the grace the server switches phase; both clients follow it from the snap alone.
  const remaining = (await zoneOf(inPg))!.remainingMs;
  await inPg.waitForFunction(() => (window.__escape.game() as any).royaleZone.phase === 1, null, { timeout: remaining + 5_000 });
  await outPg.waitForFunction(() => (window.__escape.game() as any).royaleZone.phase === 1, null, { timeout: 5_000 });
  const z1 = (await zoneOf(inPg))!;
  expect(z1.radius).toBeLessThan(z0.radius);
  expect(z1.remainingMs).toBeGreaterThan(8_000); // a fresh 20 s countdown
  await tp(inPg, z1.center[0], z1.center[1]); await tp(outPg, z1.center[0], z1.center[1] + 5);
  await inPg.waitForTimeout(1200);
  expect((await hud(inPg)).head).toMatch(/收缩|缩圈|圈/);
  await inPg.keyboard.press('m');
  await inPg.waitForTimeout(600);
  await sceneShot(inPg, 'test-results/a2c-3-new-circle-map.png');
  await inPg.keyboard.press('m');

  // Elimination: the second player walks out of the new circle and just stays there; no client report is sent.
  const far1 = CAMPUS_CORNERS.map(([x, z]) => ({ x, z, d: Math.hypot(x - z1.center[0], z - z1.center[1]) })).sort((a, b) => b.d - a.d)[0];
  expect(far1.d, 'a campus corner outside the new circle').toBeGreaterThan(z1.radius + 5);
  await tp(outPg, far1.x, far1.z);
  await outPg.waitForFunction(() => (window as any).__royaleMsgs.some((m: any) => m.t === 'royale-eliminated'), null, { timeout: 15_000 });
  const gone = (await msgs(outPg)).find(m => m.t === 'royale-eliminated');
  expect(gone).toMatchObject({ rank: 2, alive: 1 });
  expect((await msgs(inPg)).find(m => m.t === 'royale-eliminated')).toMatchObject({ id: gone.id, rank: 2, alive: 1 });
  // the survivor won; the loser is spectating and was not touched by anything the survivor did
  await inPg.waitForFunction(() => (window as any).__royaleMsgs.some((m: any) => m.t === 'royale-settle'), null, { timeout: 5_000 });
  expect((await msgs(inPg)).find(m => m.t === 'royale-settle').ranking).toEqual(expect.arrayContaining([{ id: gone.id, rank: 2 }]));
  expect(await outPg.evaluate(() => (window.__escape.game() as any).spectate)).toBe(true);
  expect(await inPg.evaluate(() => (window.__escape.game() as any).spectate)).toBe(false);
  await sceneShot(outPg, 'test-results/a2c-4-eliminated.png');

  await ctxIn.close(); await ctxOut.close();
});

/** Observe only safe gameplay metadata; never attach the socket's hello/resume credentials. */
function settlementWire(p: Page) {
  const received: Extract<ServerMsg, { t: 'royale-eliminated' | 'royale-settle' }>[] = [];
  const sent: string[] = [];
  p.on('websocket', ws => {
    ws.on('framereceived', ({ payload }) => {
      const m = JSON.parse(String(payload)) as ServerMsg;
      if (m.t === 'royale-eliminated' || m.t === 'royale-settle') received.push(m);
    });
    ws.on('framesent', ({ payload }) => {
      const m = JSON.parse(String(payload)) as ClientMsg;
      if (m.t === 'input' || m.t === 'act' || m.t === 'use' || m.t === 'ping') sent.push(m.t);
    });
  });
  return { received, sent };
}

async function startSettlementRoom(host: Page, guest: Page) {
  await host.goto(gameURL);
  await host.fill('#name', '桌面队员');
  await host.selectOption('#mode-selector', 'royale');
  await host.click('#create');
  await expect(host.locator('#waiting')).toBeVisible();
  const code = await host.evaluate(() => window.__escape.code);
  await guest.goto(gameURL);
  await guest.fill('#name', '手机冠军');
  await guest.fill('#code', code);
  await guest.locator('#join').tap();
  await expect(host.locator('#wait-members li')).toHaveCount(2);
  await host.click('#start');
  await Promise.all([ready(host), ready(guest)]);
  await host.evaluate(() => window.__escape.debug('safe', 600));
  return code;
}

const hasResume = (p: Page) => p.evaluate(() => ({
  session: sessionStorage.getItem('escape.resume') !== null,
  persistent: localStorage.getItem('escape.resume') !== null,
}));

test('R41-2 royale: both ranks settle, freeze controls and return to fresh rooms on desktop and mobile', async ({ browser, baseURL }, testInfo) => {
  const storageState = gateStorageState(baseURL!);
  const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 720 }, storageState,
    recordVideo: process.env.ESC_ROYALE_VIDEO ? { dir: 'test-results/a2c-videos', size: { width: 1280, height: 720 } } : undefined });
  const mobileContext = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, storageState });
  const videoStartedAt = Date.now();
  const desktop = await desktopContext.newPage(), mobile = await mobileContext.newPage();
  const desktopWire = settlementWire(desktop), mobileWire = settlementWire(mobile);
  const errors: string[] = [];
  for (const p of [desktop, mobile]) p.on('pageerror', e => errors.push(e.message));

  try {
    const code = await startSettlementRoom(desktop, mobile);
    const zone = (await zoneOf(mobile))!;
    await tp(mobile, zone.center[0], zone.center[1]);
    await tp(desktop, zone.center[0], zone.center[1] - 10);
    const far = CAMPUS_CORNERS.map(([x, z]) => ({ x, z, d: Math.hypot(x - zone.center[0], z - zone.center[1]) })).sort((a, b) => b.d - a.d)[0];
    expect(far.d).toBeGreaterThan(zone.radius + 5);
    await tp(desktop, far.x, far.z);
    await expect.poll(() => desktopWire.received.some(m => m.t === 'royale-settle'), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => mobileWire.received.some(m => m.t === 'royale-settle')).toBe(true);
    if (process.env.ESC_ROYALE_VIDEO) console.log('R41-2 video timing', JSON.stringify({ event: 'settled', offsetS: (Date.now() - videoStartedAt) / 1000 }));
    const desktopId = (await pose(desktop)).id, mobileId = (await pose(mobile)).id;
    for (const wire of [desktopWire, mobileWire]) {
      expect(wire.received.find(m => m.t === 'royale-eliminated')).toMatchObject({ id: desktopId, rank: 2, alive: 1 });
      expect(wire.received.find(m => m.t === 'royale-settle')).toMatchObject({ ranking: expect.arrayContaining([
        { id: desktopId, rank: 2 }, { id: mobileId, rank: 1 },
      ]) });
    }
    await testInfo.attach('royale-settlement-wire', { body: JSON.stringify({ desktop: desktopWire.received, mobile: mobileWire.received }, null, 2), contentType: 'application/json' });
    // Capture the old HUD as well when running this regression against the unfixed build.
    await sceneShot(desktop, 'test-results/iter-43-desktop-royale-settle.png');
    await sceneShot(mobile, 'test-results/iter-43-mobile-royale-settle.png');
    for (const [p, rank] of [[desktop, 2], [mobile, 1]] as const) {
      await expect(p.locator('#finale-result')).toBeVisible();
      await expect(p.locator('#finale-result .ft')).toContainText('大逃杀');
      await expect(p.locator('#finale-summary')).toContainText(/冠军[：:]?\s*手机冠军/);
      await expect(p.locator('#finale-summary')).toContainText(new RegExp(`你的名次[：:]?\\s*第 ${rank} 名`));
      await expect(p.locator('#finale-restart')).toBeHidden();
      await expect(p.locator('#royale-return')).toHaveText('返回大厅');
      await expect(p.locator('#royale-return')).toBeInViewport();
      expect(await hasResume(p)).toEqual({ session: false, persistent: false });
    }

    const before = await Promise.all([pose(desktop), pose(mobile)]);
    const cameraBefore = await Promise.all([desktop, mobile].map(p => p.evaluate(() => (window.__escape.game() as any).camera.position.toArray())));
    const sentBefore = [desktopWire.sent.length, mobileWire.sent.length];
    const framesBefore = await Promise.all([desktop, mobile].map(p => p.evaluate(() => (window.__escape.game() as any).last as number)));
    await desktop.keyboard.down('w');
    await desktop.keyboard.press('e');
    await desktop.keyboard.press('f');
    const cdp = await mobileContext.newCDPSession(mobile);
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 80, y: 290, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 80, y: 240, id: 1 }] });
      await Promise.all([desktop, mobile].map((p, i) => p.waitForFunction(last => (window.__escape.game() as any).last >= last + 1200,
        framesBefore[i], { timeout: 15_000 })));
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await desktop.keyboard.up('w'); await cdp.detach(); }
    const after = await Promise.all([pose(desktop), pose(mobile)]);
    for (const [i, p] of [desktop, mobile].entries()) {
      expect(after[i].local).toEqual(before[i].local);
      expect(after[i].light).toBe(before[i].light);
      expect(await p.evaluate(() => (window.__escape.game() as any).camera.position.toArray())).toEqual(cameraBefore[i]);
      expect(await p.evaluate(() => (window.__escape.game() as any).input.enabled)).toBe(false);
    }
    expect([desktopWire.sent.length, mobileWire.sent.length]).toEqual(sentBefore);

    const newCodes: string[] = [];
    for (const [i, p] of [desktop, mobile].entries()) {
      if (process.env.ESC_ROYALE_VIDEO && i === 0) console.log('R41-2 video timing', JSON.stringify({ event: 'return', offsetS: (Date.now() - videoStartedAt) / 1000 }));
      if (i === 0) await p.locator('#royale-return').click();
      else await p.locator('#royale-return').tap();
      await expect(p.locator('#entry')).toBeVisible();
      await expect(p.locator('#waiting')).toBeHidden();
      await expect.poll(() => p.evaluate(() => window.__escape.game() === null)).toBe(true);
      await p.reload();
      await expect(p.locator('#entry')).toBeVisible();
      await expect(p.locator('#waiting')).toBeHidden();
      expect(await hasResume(p)).toEqual({ session: false, persistent: false });
      await p.fill('#name', `新局${i}`);
      await p.selectOption('#mode-selector', 'royale');
      if (i === 0) await p.locator('#create').click();
      else await p.locator('#create').tap();
      await expect(p.locator('#waiting')).toBeVisible();
      const fresh = await p.evaluate(() => window.__escape.code);
      expect(fresh).not.toBe(code); expect(fresh).not.toBe('');
      newCodes.push(fresh);
    }
    expect(newCodes[0]).not.toBe(newCodes[1]);
    expect(errors).toEqual([]);
    await testInfo.attach('fresh-rooms', { body: JSON.stringify({ ended: code, fresh: newCodes }), contentType: 'application/json' });
  } finally {
    await desktopContext.close(); await mobileContext.close();
    if (process.env.ESC_ROYALE_VIDEO) console.log('R41-2 settlement video', await desktop.video()!.path());
  }
});

test('R41-2 royale: a mobile survivor sees the champion after a disconnect and refresh opens the lobby', async ({ browser, baseURL }, testInfo) => {
  const storageState = gateStorageState(baseURL!);
  const desktopContext = await browser.newContext({ viewport: { width: 640, height: 400 }, storageState });
  const mobileContext = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, storageState });
  const desktop = await desktopContext.newPage(), mobile = await mobileContext.newPage();
  const wire = settlementWire(mobile);
  try {
    const code = await startSettlementRoom(desktop, mobile);
    const id = (await pose(mobile)).id, zone = (await zoneOf(mobile))!;
    await tp(mobile, zone.center[0], zone.center[1]);
    await desktopContext.close();
    await expect.poll(() => wire.received.some(m => m.t === 'royale-settle'), { timeout: 35_000 }).toBe(true);
    expect(wire.received.find(m => m.t === 'royale-settle')).toMatchObject({ ranking: expect.arrayContaining([{ id, rank: 1 }]) });
    await expect(mobile.locator('#finale-result')).toBeVisible();
    await expect(mobile.locator('#finale-summary')).toContainText(/冠军[：:]?\s*手机冠军/);
    await expect(mobile.locator('#finale-summary')).toContainText(/你的名次[：:]?\s*第 1 名/);
    await expect(mobile.locator('#royale-return')).toBeInViewport();
    expect(await hasResume(mobile)).toEqual({ session: false, persistent: false });
    await sceneShot(mobile, 'test-results/iter-43-mobile-disconnect-settle.png');
    await testInfo.attach('disconnect-settlement-wire', { body: JSON.stringify(wire.received, null, 2), contentType: 'application/json' });
    // Refresh directly from settlement, without invoking the return button first.
    await mobile.reload();
    await expect(mobile.locator('#entry')).toBeVisible();
    await expect(mobile.locator('#waiting')).toBeHidden();
    expect(await mobile.evaluate(() => window.__escape.code)).not.toBe(code);
    expect(await mobile.evaluate(() => window.__escape.game())).toBeNull();
  } finally { await desktopContext.close(); await mobileContext.close(); }
});
