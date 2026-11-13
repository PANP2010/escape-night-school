import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import WebSocket from 'ws';
import type { ServerMsg, Vec3 } from '../../shared/protocol.ts';

test('one rendered player and two real websocket peers witness the unforced L1 opening', async ({ page, baseURL }) => {
  test.setTimeout(110_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const Original = window.WebSocket;
    (window as any).__sightingPackets = [];
    (window as any).__sightingJumps = [];
    let previousWarden: number[] | undefined;
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', event => {
          const message = JSON.parse(String(event.data));
          if (message.t === 'snap') {
            const warden = message.mobs.find((mob: any) => mob.id === 1);
            if (warden) {
              if (previousWarden && Math.hypot(warden.p[0] - previousWarden[0], warden.p[2] - previousWarden[2]) > 3) {
                (window as any).__sightingJumps.push({ tick: message.tick, from: previousWarden, to: warden.p });
              }
              previousWarden = warden.p;
            }
          }
          (window as any).__sightingPackets.push({ at: performance.now(), message });
        });
      }
    };
  });
  await page.goto('/?steady');
  await page.fill('#name', '目击甲');
  await page.click('#create');
  await expect(page.locator('#waiting')).toBeVisible();
  const code = await page.evaluate(() => window.__escape.code);
  const peerPackets: { peer: number; message: ServerMsg }[] = [];
  const peers: { ws: WebSocket; interval: ReturnType<typeof setInterval>; state: () => unknown }[] = [];
  try {
    for (let peer = 2; peer <= 3; peer++) {
      const ws = new WebSocket(baseURL!.replace('http', 'ws') + '/ws');
      let id = -1, p: Vec3 | undefined, epoch = 0, seq = 0, targetZ: number | undefined;
      ws.on('message', raw => {
        const m = JSON.parse(String(raw)) as ServerMsg;
        if (m.t === 'welcome') id = m.id;
        if (m.t === 'correct') { p = m.p; epoch = m.c ?? epoch; }
        if (m.t === 'snap') { p = m.players.find(player => player.id === id)?.p ?? p; }
        peerPackets.push({ peer, message: m });
      });
      await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
      ws.send(JSON.stringify({ t: 'hello', name: `目击${peer}` }));
      ws.send(JSON.stringify({ t: 'join', code }));
      const interval = setInterval(() => {
        if (p && ws.readyState === WebSocket.OPEN) {
          targetZ ??= p[2] + (peer === 2 ? .6 : .8); // stay inside the corridor's capsule clearance.
          const next: Vec3 = [p[0], p[1], p[2] + Math.min(0.12, Math.max(0, targetZ - p[2]))];
          ws.send(JSON.stringify({ t: 'input', seq: ++seq, c: epoch, p: next, yaw: Math.PI / 2, pitch: 0, f: 0 }));
        }
      }, 50);
      peers.push({ ws, interval, state: () => ({ id, p, epoch, seq, targetZ, readyState: ws.readyState }) });
    }
    await expect(page.locator('#wait-members li')).toHaveCount(3);
    await page.click('#start');
    await expect(page.locator('#hud')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => window.__escape.game()?.presentationReady), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.remotes.size)).toBe(2);

    // Check the actual interpolated mesh against the real camera and collision slabs; a projected figure behind a wall
    // cannot trigger the screenshot. The standalone Room suite separately measures every peer's sustained view.
    const handle = await page.waitForFunction(() => {
      const g = window.__escape.game() as any, mob = g?.mobs.byId.get(1);
      const packets = (window as any).__sightingPackets;
      const relocations = (window as any).__sightingJumps;
      const last = packets.findLast((packet: any) => packet.message.t === 'snap')?.message;
      if (!mob || !last || !relocations.length || last.tick < 600 || g.down || g.spectate) return false;
      const feet = mob.mesh.position, camera = g.camera;
      const center = feet.clone().add({ x: 0, y: 1.1, z: 0 }).project(camera);
      const head = feet.clone().add({ x: 0, y: 1.75, z: 0 }).project(camera);
      const bottom = feet.clone().project(camera);
      const heightPx = Math.abs(head.y - bottom.y) * 360;
      if (Math.abs(center.x) >= 0.95 || Math.abs(center.y) >= 0.95 || center.z < -1 || center.z > 1 || heightPx <= 40) return false;
      const a = camera.position, b = feet.clone().add({ x: 0, y: 1.1, z: 0 });
      const origin = [a.x, a.y, a.z], delta = [b.x - a.x, b.y - a.y, b.z - a.z];
      for (const box of g.campus.collision.query(Math.min(a.x, b.x), Math.min(a.z, b.z), Math.max(a.x, b.x), Math.max(a.z, b.z))) {
        const lo = [box.minX, box.minY, box.minZ], hi = [box.maxX, box.maxY, box.maxZ];
        let t0 = 0, t1 = 1, hit = true;
        for (let k = 0; k < 3; k++) {
          if (Math.abs(delta[k]) < 1e-9) { if (origin[k] <= lo[k] || origin[k] >= hi[k]) { hit = false; break; } continue; }
          const u = (lo[k] - origin[k]) / delta[k], v = (hi[k] - origin[k]) / delta[k];
          t0 = Math.max(t0, Math.min(u, v)); t1 = Math.min(t1, Math.max(u, v));
          if (t0 >= t1) { hit = false; break; }
        }
        if (hit) return false;
      }
      return { tick: last.tick, atS: last.tick * 0.05, heightPx, feet: [feet.x, feet.y, feet.z], anim: mob.anim,
        yaw: g.input.yaw, relocations, teammateModels: [...g.remotes.values()].filter((remote: any) => remote.mesh.visible).length };
    }, undefined, { timeout: 65_000, polling: 'raf' });
    const firstVisible = await handle.jsonValue();
    mkdirSync('test-results', { recursive: true });
    await page.waitForTimeout(400);
    await page.screenshot({ path: 'test-results/safe-sighting-first-visible.png' });
    const browserPackets = await page.evaluate(() => (window as any).__sightingPackets);
    writeFileSync('test-results/safe-sighting-browser.json', JSON.stringify({ firstVisible, errors, browserPackets, peerPackets }, null, 2));
    expect((firstVisible as any).atS).toBeLessThanOrEqual(60);
    expect((firstVisible as any).teammateModels).toBe(2);
    const spawnSnapshots = browserPackets.filter((packet: any) => packet.message.t === 'snap' && packet.message.tick <= 400);
    expect(spawnSnapshots.some((packet: any) => packet.message.tick === 400), 'the first 20 server seconds were observed').toBe(true);
    expect(spawnSnapshots.flatMap((packet: any) => packet.message.players.filter((player: any) => (player.st ?? 0) !== 0))).toEqual([]);
    expect(browserPackets.filter((packet: any) => packet.message.t === 'caught')).toEqual([]);
    expect(peerPackets.filter(packet => packet.message.t === 'caught')).toEqual([]);
    expect(errors).toEqual([]);
  } catch (error) {
    await saveFailure(page, 'safe-sighting-browser-failure', { error: String(error), errors, peerPackets, peers: peers.map(peer => peer.state()) });
    throw error;
  } finally {
    for (const peer of peers) { clearInterval(peer.interval); peer.ws.close(); }
  }
});

async function saveFailure(page: Page, name: string, extra: unknown) {
  mkdirSync('test-results', { recursive: true });
  const observed = await page.evaluate(() => {
    const w = window as any, g = window.__escape?.game() as any;
    return { packets: w.__sightingPackets, jumps: w.__sightingJumps, rendered: w.__sightingRendered,
      game: g ? { myId: g.myId, body: [g.body.x, g.body.y, g.body.z], yaw: g.input.yaw, pitch: g.input.pitch,
        corrC: g.corrC, seq: g.seq, down: g.down, spectate: g.spectate, presentationReady: g.presentationReady,
        keys: [...g.input.keys], mobs: [...g.mobs.byId.values()].map((mob: any) => ({ p: [mob.mesh.position.x, mob.mesh.position.y, mob.mesh.position.z], anim: mob.anim })) } : null };
  }).catch(error => ({ collectionError: String(error) }));
  writeFileSync(`test-results/${name}.json`, JSON.stringify({ extra, observed }, null, 2));
  await page.screenshot({ path: `test-results/${name}.png`, timeout: 5_000 }).catch(() => {});
}

/** Observe real rendered figures without changing game input, camera, monster state or simulation time. */
async function recordRenderedOpening(page: Page) {
  await page.addInitScript(() => {
    const Original = window.WebSocket, w = window as any;
    const evidence = w.__sightingRendered = {
      packets: [] as any[], jumps: [] as any[], frames: [] as any[], firstVisible: null as any,
      longestWindowMs: 0, current: null as any,
    };
    let latest: any, previousWarden: number[] | undefined, since = 0, sinceTick = 0, previousFrame = 0;
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', event => {
          const message = JSON.parse(String(event.data));
          if (message.t === 'snap') {
            latest = message;
            const warden = message.mobs.find((mob: any) => mob.id === 1);
            if (warden) {
              if (previousWarden && Math.hypot(warden.p[0] - previousWarden[0], warden.p[2] - previousWarden[2]) > 3) {
                evidence.jumps.push({ tick: message.tick, from: previousWarden, to: warden.p });
              }
              previousWarden = warden.p;
            }
          }
          evidence.packets.push({ at: performance.now(), message });
        });
      }
    };
    const sample = (now: number) => {
      const g = window.__escape?.game() as any, mob = g?.mobs.byId.get(1);
      let visible = false, row: any;
      if (g?.presentationReady && mob?.mesh.visible && latest?.tick >= 600 && evidence.jumps.length && !g.down && !g.spectate) {
        const feet = mob.mesh.position, camera = g.camera;
        const center = feet.clone().add({ x: 0, y: 1.1, z: 0 }).project(camera);
        const head = feet.clone().add({ x: 0, y: 1.75, z: 0 }).project(camera);
        const bottom = feet.clone().project(camera);
        const heightPx = Math.abs(head.y - bottom.y) * innerHeight / 2;
        visible = Math.abs(center.x) < .95 && Math.abs(center.y) < .95 && center.z >= -1 && center.z <= 1 && heightPx > 40;
        const a = camera.position, b = feet.clone().add({ x: 0, y: 1.1, z: 0 });
        const origin = [a.x, a.y, a.z], delta = [b.x - a.x, b.y - a.y, b.z - a.z];
        if (visible) for (const box of g.campus.collision.query(Math.min(a.x, b.x), Math.min(a.z, b.z), Math.max(a.x, b.x), Math.max(a.z, b.z))) {
          const lo = [box.minX, box.minY, box.minZ], hi = [box.maxX, box.maxY, box.maxZ];
          let t0 = 0, t1 = 1, hit = true;
          for (let k = 0; k < 3; k++) {
            if (Math.abs(delta[k]) < 1e-9) { if (origin[k] <= lo[k] || origin[k] >= hi[k]) { hit = false; break; } continue; }
            const u = (lo[k] - origin[k]) / delta[k], v = (hi[k] - origin[k]) / delta[k];
            t0 = Math.max(t0, Math.min(u, v)); t1 = Math.min(t1, Math.max(u, v));
            if (t0 >= t1) { hit = false; break; }
          }
          if (hit) { visible = false; break; }
        }
        // A teammate standing directly in front of the camera must not count as an unobstructed teacher.
        if (visible) for (const remote of g.remotes.values()) {
          if (!remote.mesh.visible || remote.out) continue;
          const p = remote.mesh.position, dd = delta[0] ** 2 + delta[2] ** 2;
          const t = ((p.x - a.x) * delta[0] + (p.z - a.z) * delta[2]) / dd;
          if (t <= 0 || t >= 1) continue;
          const rayY = a.y + delta[1] * t;
          if (rayY > p.y && rayY < p.y + 1.8 && Math.hypot(a.x + delta[0] * t - p.x, a.z + delta[2] * t - p.z) < .35) { visible = false; break; }
        }
        row = { tick: latest.tick, atS: latest.tick * .05, heightPx, feet: [feet.x, feet.y, feet.z], anim: mob.anim,
          camera: [a.x, a.y, a.z], yaw: g.input.yaw, pitch: g.input.pitch,
          teammateModels: [...g.remotes.values()].filter((remote: any) => remote.mesh.visible).length, visible };
      }
      if (visible) {
        if (!since || now - previousFrame > 250) { since = now; sinceTick = latest.tick; }
        const windowMs = Math.min(now - since, (latest.tick - sinceTick) * 50);
        evidence.longestWindowMs = Math.max(evidence.longestWindowMs, windowMs);
        evidence.firstVisible ??= row;
        row.windowMs = windowMs;
        // Keep every visible frame and the server tick, so the sustained view can be reviewed after the run.
        evidence.frames.push(row);
      } else since = 0;
      evidence.current = visible ? row : null;
      previousFrame = now;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

test('three real clients each render the safe first-minute crossing without a spawn catch', async ({ page, browser, baseURL }) => {
  test.setTimeout(120_000);
  const contexts = [];
  const pages = [page];
  const errors: { client: number; message: string }[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
      contexts.push(context);
      pages.push(await context.newPage());
    }
    await Promise.all(pages.map(async (p, client) => {
      p.on('pageerror', error => errors.push({ client, message: error.message }));
      await recordRenderedOpening(p);
      await p.goto(`${baseURL}/?steady`);
      await p.fill('#name', `实画目击${client + 1}`);
    }));
    await page.click('#create');
    await expect(page.locator('#waiting')).toBeVisible();
    const code = await page.evaluate(() => window.__escape.code);
    for (const p of pages.slice(1)) { await p.fill('#code', code); await p.click('#join'); }
    for (const p of pages) await expect(p.locator('#wait-members li')).toHaveCount(3);
    await page.click('#start');
    await Promise.all(pages.map(async p => {
      await expect(p.locator('#hud')).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => p.evaluate(() => window.__escape.game()?.presentationReady), { timeout: 30_000 }).toBe(true);
      await expect.poll(() => p.evaluate(() => window.__escape.game()!.remotes.size)).toBe(2);
    }));

    // Ordinary keyboard side-steps clear the initial line of teammates; yaw stays at the real spawn direction.
    const sidesteps = [];
    for (const [i, p] of pages.slice(1).entries()) {
      const from = await p.evaluate(() => (window.__escape.game() as any).body.z);
      const key = 'KeyA', distance = i === 0 ? .4 : .8;
      await p.bringToFront();
      await p.keyboard.down(key);
      try {
        await p.waitForFunction(({ from, distance }) => (window.__escape.game() as any).body.z - from >= distance,
          { from, distance }, { timeout: 5_000 });
      } finally { await p.keyboard.up(key); }
      const to = await p.evaluate(() => (window.__escape.game() as any).body.z);
      expect(to - from).toBeGreaterThanOrEqual(distance);
      sidesteps.push({ client: i + 2, from, to, key });
    }

    mkdirSync('test-results', { recursive: true });
    for (let client = 0; client < pages.length; client++) {
      const p = pages[client];
      await p.waitForFunction(() => (window as any).__sightingRendered.current, undefined, { timeout: 65_000, polling: 'raf' });
      const shot = await p.screenshot({ path: `test-results/safe-sighting-client-${client + 1}.png` });
      expect(shot.byteLength, `client ${client + 1}: screenshot has actual rendered content`).toBeGreaterThan(10_000);
    }
    await Promise.all(pages.map(p => p.waitForFunction(() => (window as any).__sightingRendered.longestWindowMs >= 1_000,
      undefined, { timeout: 10_000, polling: 'raf' })));
    const clients = await Promise.all(pages.map(p => p.evaluate(() => (window as any).__sightingRendered)));
    writeFileSync('test-results/safe-sighting-multiplayer-browser.json', JSON.stringify({ errors, sidesteps, clients }, null, 2));
    for (let i = 0; i < clients.length; i++) {
      const client = clients[i], packets = client.packets;
      expect(client.firstVisible.atS, `client ${i + 1}: first scripted sight`).toBeLessThanOrEqual(60);
      expect(client.firstVisible.heightPx).toBeGreaterThan(40);
      expect(client.firstVisible.teammateModels).toBe(2);
      expect(client.longestWindowMs, `client ${i + 1}: sustained rendered view`).toBeGreaterThanOrEqual(1_000);
      const first20 = packets.filter((packet: any) => packet.message.t === 'snap' && packet.message.tick <= 400);
      expect(first20.some((packet: any) => packet.message.tick === 400), `client ${i + 1}: first 20 server seconds observed`).toBe(true);
      expect(first20.flatMap((packet: any) => packet.message.players.filter((player: any) => (player.st ?? 0) !== 0)), `client ${i + 1}: spawn states`).toEqual([]);
      expect(packets.filter((packet: any) => packet.message.t === 'caught')).toEqual([]);
      expect(client.jumps).toHaveLength(1);
    }
    expect(clients[1].jumps).toEqual(clients[0].jumps);
    expect(clients[2].jumps).toEqual(clients[0].jumps);
    expect(errors).toEqual([]);
  } catch (error) {
    for (let client = 0; client < pages.length; client++) await saveFailure(pages[client], `safe-sighting-multiplayer-failure-${client + 1}`, { error: String(error), errors });
    throw error;
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});
