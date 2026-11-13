import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import WebSocket from 'ws';
import { moveCapsule, type Body, type CollisionWorld } from '../../shared/campus/collision.ts';
import { SPEED, TICK_MS } from '../../shared/constants.ts';
import type { CampaignMirrorSnap } from '../../shared/l7-campaign.ts';
import { L7_CAPSULE, L7_EXIT, l7World } from '../../shared/levels/l7.ts';
import { ST_OK, ST_SPECTATE, type ClientMsg, type ServerMsg, type Vec3 } from '../../shared/protocol.ts';
import { frame } from '../e2e/draw.ts';

type Snap = Extract<ServerMsg, { t: 'snap' }>;
type Room = Extract<ServerMsg, { t: 'room' }>;
type Point = [number, number];

/** Real /ws participant: same collision and input packets as the page, no second rendered campus. */
class Teammate {
  readonly received: ServerMsg[] = [];
  readonly sent: ClientMsg[] = [];
  id = 0;
  room?: Room;
  snap?: Snap;
  mirror?: CampaignMirrorSnap;
  private body?: Body;
  private world?: CollisionWorld;
  private doors = '';
  private epoch = 0;
  private seq = 0;
  private route: Point[] = [];
  private yaw = 0;
  private readonly socket: WebSocket;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on('message', raw => {
      const message = JSON.parse(String(raw)) as ServerMsg;
      if (message.t === 'snap') this.snap = message;
      else if (message.t !== 'nav') this.received.push(message);
      if (message.t === 'welcome') this.id = message.id;
      if (message.t === 'room') this.room = message;
      if (message.t === 'correct') {
        this.epoch = message.c ?? this.epoch;
        this.body = { x: message.p[0], y: message.p[1], z: message.p[2], vy: 0, grounded: true };
      }
      if (message.t === 'l7') {
        this.mirror = message;
        const doors = message.openDoors.join(',');
        if (!this.world || doors !== this.doors) { this.world = l7World(message.openDoors); this.doors = doors; }
      }
    });
    this.timer = setInterval(() => this.input(), TICK_MS);
  }

  send(message: ClientMsg) {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Teammate socket is not open');
    this.sent.push(message); this.socket.send(JSON.stringify(message));
  }

  walk(points: Point[]) { this.route = points.map(p => [p[0], p[1]]); }
  get arrived() { return this.route.length === 0; }
  get state() { return this.snap?.players.find(p => p.id === this.id); }

  private input() {
    if (!this.body || !this.room?.started || this.socket.readyState !== WebSocket.OPEN) return;
    if (this.route.length && this.world && this.room.level === 6) {
      let next = this.route[0];
      while (next && Math.hypot(next[0] - this.body.x, next[1] - this.body.z) < .2) { this.route.shift(); next = this.route[0]; }
      if (next) {
        const dx = next[0] - this.body.x, dz = next[1] - this.body.z, distance = Math.hypot(dx, dz);
        this.yaw = Math.atan2(-dx, -dz);
        const step = Math.min(distance, SPEED.walk * TICK_MS / 1000);
        moveCapsule(this.world, this.body, dx / distance * step, dz / distance * step, TICK_MS / 1000, L7_CAPSULE);
      }
    }
    this.send({ t: 'input', seq: ++this.seq, p: [this.body.x, this.body.y, this.body.z], yaw: this.yaw, pitch: 0, f: 0, c: this.epoch });
  }

  async close() {
    clearInterval(this.timer);
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>(resolve => { this.socket.once('close', () => resolve()); this.socket.close(); });
  }
}

async function join(url: string, code: string, name: string) {
  const teammate = new Teammate(url);
  try {
    await expect.poll(() => teammate.id).toBeGreaterThan(0);
    teammate.send({ t: 'hello', name }); teammate.send({ t: 'join', code });
    await expect.poll(() => teammate.room?.code).toBe(code);
    return teammate;
  } catch (error) { await teammate.close(); throw error; }
}

async function walk(page: Page, points: Point[]) {
  await page.evaluate(points => {
    const game = window.__escape.game()!;
    window.__escape.autopilot([[game.pos.x, game.pos.z], ...points]);
  }, points);
  await expect.poll(() => page.evaluate(() => window.__escape.game()!.autopilotDone), { timeout: 30_000 }).toBe(true);
}

async function look(page: Page, yaw: number, pitch = 0) {
  await page.evaluate(({ yaw, pitch }) => { const game = window.__escape.game()!; game.input.yaw = yaw; game.input.pitch = pitch; }, { yaw, pitch });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function capture(page: Page, path: string) {
  await frame(page);
  await page.evaluate(async () => {
    await (document.getElementById('e2e-shot') as HTMLImageElement).decode();
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await page.screenshot({ path });
  await page.evaluate(() => document.getElementById('e2e-shot')?.remove());
}

async function tapWorld(page: Page, p: Vec3) {
  const point = await page.evaluate(p => {
    const game = window.__escape.game()!, rect = game.renderer.domElement.getBoundingClientRect();
    game.camera.updateMatrixWorld();
    const v = new window.__escape.THREE.Vector3(...p).project(game.camera);
    return { x: rect.left + (v.x + 1) * rect.width / 2, y: rect.top + (1 - v.y) * rect.height / 2, depth: v.z };
  }, p);
  expect(point.depth).toBeGreaterThan(-1); expect(point.depth).toBeLessThan(1);
  expect(point.x).toBeGreaterThan(0); expect(point.x).toBeLessThan(844);
  expect(point.y).toBeGreaterThan(0); expect(point.y).toBeLessThan(390);
  await page.touchscreen.tap(point.x, point.y);
  return point;
}

test('one phone and three /ws teammates share campaign identity, reflected key, real walls, stairs and exit', async ({ page, baseURL }, testInfo) => {
  const errors: string[] = [], urls: string[] = [], sent: ClientMsg[] = [], received: ServerMsg[] = [];
  const peers: Teammate[] = [];
  const evidence: Record<string, unknown> = {};
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(`Console: ${message.text()}`); });
  page.on('websocket', socket => {
    urls.push(socket.url());
    socket.on('framesent', ({ payload }) => sent.push(JSON.parse(String(payload)) as ClientMsg));
    socket.on('framereceived', ({ payload }) => {
      const message = JSON.parse(String(payload)) as ServerMsg;
      if (message.t !== 'snap' && message.t !== 'nav' && message.t !== 'l7') received.push(message);
    });
    socket.on('socketerror', error => errors.push(`WebSocket: ${error}`));
  });
  try {
    await page.goto('/?nodraw&steady');
    await page.fill('#name', '镜廊手机'); await page.click('#create');
    await expect(page.locator('#wait-code')).not.toBeEmpty();
    const code = await page.locator('#wait-code').innerText(), url = `${baseURL!.replace(/^http/, 'ws')}/ws`;
    peers.push(await join(url, code, '镜廊甲'), await join(url, code, '镜廊乙'));
    await expect(page.locator('#wait-members li')).toHaveCount(3); await page.click('#start');
    await page.waitForFunction(() => window.__escape.game()?.presentationReady && !window.__escape.game()!.intro.active);
    const ownId = await page.evaluate(() => window.__escape.game()!.myId);
    await page.evaluate(async () => {
      if (document.fullscreenElement) await document.exitFullscreen();
      window.__escape.debug('safe', 600); window.__escape.debug('level', 6);
    });
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForFunction(() => window.__escape.game()?.presentationReady && window.__escape.game()!.level.index === 6 && !!window.__escape.game()!.mirrorState && !window.__escape.game()!.intro.active);
    // Ignore catch damage during route assertions; the reflected figures still run their real state machine.
    await page.evaluate(() => window.__escape.debug('safe', 600));
    await expect(page.locator('#banner')).toBeHidden({ timeout: 15_000 });
    await expect(page.locator('#touch')).toBeVisible();
    expect(await page.evaluate(() => ({ id: window.__escape.game()!.myId, touch: document.body.classList.contains('touch'), overflow: document.documentElement.scrollWidth > innerWidth })))
      .toEqual({ id: ownId, touch: true, overflow: false });
    for (const peer of peers) {
      await expect.poll(() => peer.room?.level).toBe(6);
      expect(peer.room).toMatchObject({ code, host: ownId });
      await expect.poll(() => peer.state?.st ?? ST_OK).toBe(ST_OK);
    }
    expect(new Set([ownId, ...peers.map(peer => peer.id)]).size).toBe(3);
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.remotes.size)).toBe(2);
    const renderer = await page.evaluate(() => {
      const gl = window.__escape.game()!.renderer.getContext(), extension = gl.getExtension('WEBGL_debug_renderer_info');
      return String(gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
    });
    expect(renderer).toMatch(/Metal/i);
    evidence.renderer = renderer;

    // Directed entry is the only chapter setup. Key, secret walls, ascent and final exit use live interactions/input.
    await page.evaluate(() => window.__escape.debug('tp', -80.4, 143.4, 0));
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.pos.x)).toBeCloseTo(-80.4, 1);
    await look(page, Math.PI / 2, -.1);
    await page.evaluate(() => { window.__escape.game()!.renderer.domElement.style.visibility = ''; });
    const ownPhase = () => page.evaluate(id => window.__escape.game()!.mirrorState!.mirrors.find(actor => actor.id === id)?.phase, ownId);
    const warningChannels: unknown[] = [];
    for (const [phase, tip] of [
      ['still', '倒影停住 · 背对镜子离开'],
      ['chase', '镜中人出来了 · 背对镜子离开镜廊'],
    ] as const) {
      await expect.poll(ownPhase, { timeout: 10_000, intervals: [50] }).toBe(phase);
      await expect(page.locator('#objective .tip')).toHaveText(tip);
      // Mirror phases occupy the panel's one tip line. Goal progress may still use its normal banner.
      for (const channel of ['#subtitle', '#banner']) {
        await expect(page.locator(channel)).not.toContainText(/倒影停住|镜中人出来了/);
      }
      warningChannels.push(await page.evaluate(phase => ({
        phase, tip: document.querySelector('#objective .tip')?.textContent,
        channels: ['subtitle', 'banner'].map(id => {
          const element = document.getElementById(id)!;
          return { id, hidden: element.hidden, text: element.textContent };
        }),
      }), phase));
    }
    evidence.warningChannels = warningChannels;
    await capture(page, testInfo.outputPath('phone-mirror-chase-warning.png'));
    const keyWindow = () => page.evaluate(() => {
      const game = window.__escape.game()!, yaw = game.mirrorState!.key.guard.yaw;
      // Sample the leading half of the fully exposed pouch, leaving time for a real browser touch round trip.
      return -Math.sin(yaw) > .98 && Math.cos(yaw) < 0 ? game.mirrorView?.keyHitTarget() ?? null : null;
    });
    await expect.poll(keyWindow, { timeout: 12_000, intervals: [50] }).not.toBeNull();
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.mirrorState!.revealedDoors)).toEqual([1]);
    for (const peer of peers) await expect.poll(() => peer.mirror?.revealedDoors).toEqual([1]);
    await capture(page, testInfo.outputPath('phone-reflected-key-window.png'));
    // A screenshot can outlast the turn window; reacquire a live target before the actual finger stream.
    await expect.poll(keyWindow, { timeout: 12_000, intervals: [50] }).not.toBeNull();
    const key = await page.evaluate(() => window.__escape.game()!.mirrorView!.keyHitTarget());
    expect(key).not.toBeNull();
    const yaw = await page.evaluate(() => window.__escape.game()!.input.yaw);
    await page.touchscreen.tap(key!.x, key!.y);
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.mirrorState?.key.taken)).toBe(true);
    expect(await page.evaluate(() => window.__escape.game()!.input.yaw)).toBe(yaw);
    expect(sent.filter(m => m.t === 'act' && m.kind === 'mirror-key')).toHaveLength(1);
    for (const peer of peers) await expect.poll(() => peer.mirror?.key.taken).toBe(true);
    await capture(page, testInfo.outputPath('phone-reflected-key.png'));
    expect(await page.evaluate(() => window.__escape.game()!.mirrorView!.stats().geometryMirror)).toBe(true);
    expect(await page.evaluate(() => window.__escape.game()!.mirrorView!.stats().mirrors)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__escape.game()!.mirrorView!.stats().mirrors)).toBeLessThanOrEqual(2);
    expect(await page.evaluate(() => window.__escape.game()!.mirrorView!.stats().renderTargets)).toBe(0);
    expect(await page.evaluate(() => window.__escape.stats().calls)).toBeLessThanOrEqual(150);
    evidence.rendering = await page.evaluate(() => ({ ...window.__escape.stats(), ...window.__escape.game()!.mirrorView!.stats() }));
    await look(page, -Math.PI / 2);
    await expect.poll(() => page.evaluate(id => window.__escape.game()!.mirrorState!.mirrors.some(actor => actor.id === id), ownId)).toBe(false);
    await walk(page, [[-79, 143.4]]);
    await capture(page, testInfo.outputPath('phone-first-wall.png'));
    // Visible feedback covers the lower wall. The input layer correctly refuses taps through HUD text.
    await expect(page.locator('#subtitle')).toBeHidden();
    await expect(page.locator('#banner')).toBeHidden();
    evidence.firstWallTouch = await tapWorld(page, [-78.55, 1.3, 143.4]);
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.mirrorState!.openDoors)).toEqual([1]);
    for (const peer of peers) await expect.poll(() => peer.mirror?.openDoors).toEqual([1]);

    const late = await join(url, code, '迟到同学'); peers.push(late);
    await expect.poll(() => late.mirror?.key.taken).toBe(true);
    expect(late.mirror?.openDoors).toEqual([1]);
    expect(late.mirror?.revealedDoors).toEqual([1]);
    await expect.poll(() => late.state?.st).toBe(ST_SPECTATE);
    late.send({ t: 'act', kind: 'mirror-push', id: 2 });
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.remotes.size)).toBe(3);
    expect(await page.evaluate(() => window.__escape.game()!.mirrorState!.openDoors)).toEqual([1]);

    const stairs: Point[] = [[-80.05, 143.4], [-76.2, 143.4], [-76.2, 144.13], [-74, 144.13], [-74, 142.7], [-68.5, 142.7], [-68.5, 145.4], [-74, 145.4], [-74, 144.13], [-76.2, 144.13], [-76.2, 143.4]];
    for (const peer of peers.slice(0, 2)) peer.walk(stairs);
    await walk(page, stairs.slice(1));
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.body.y)).toBeCloseTo(3.6, 1);
    for (const peer of peers.slice(0, 2)) {
      await expect.poll(() => peer.arrived, { timeout: 20_000 }).toBe(true);
      expect(peer.state?.p[1]).toBeCloseTo(3.6, 1);
    }
    expect(await page.evaluate(() => window.__escape.game()!.mirrorState!.revealedDoors)).toEqual([1]);
    for (const peer of peers) expect(peer.mirror?.revealedDoors).toEqual([1]);
    await walk(page, [[-76.2, 140], [-81.25, 140], [-81.25, 141.8], [-80.4, 142], [-80.4, 143.4]]);
    await look(page, Math.PI / 2, -.1);
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.mirrorState!.mirrors.some(actor => actor.mirrorId === 2))).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.mirrorState!.revealedDoors)).toEqual([1, 2]);
    for (const peer of peers) await expect.poll(() => peer.mirror?.revealedDoors).toEqual([1, 2]);
    await capture(page, testInfo.outputPath('phone-specimen-mirror.png'));
    await walk(page, [[-79, 143.4]]);
    await expect(page.locator('#subtitle')).toBeHidden();
    await expect(page.locator('#banner')).toBeHidden();
    await tapWorld(page, [-78.55, 4.9, 143.4]);
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.mirrorState!.openDoors)).toEqual([1, 2]);
    expect(received.some(message => message.t === 'complete')).toBe(false);
    await walk(page, [[L7_EXIT.x, L7_EXIT.z]]);
    await expect.poll(() => received.some(message => message.t === 'fade' && !message.restart)).toBe(true);
    await expect.poll(() => received.filter(message => message.t === 'room').at(-1), { timeout: 15_000 })
      .toMatchObject({ t: 'room', code, started: true, level: 7 });
    for (const peer of peers) await expect.poll(() => peer.room).toMatchObject({ code, started: true, level: 7 });
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.level.index)).toBe(7);
    expect(urls).toEqual([url]);
    expect(sent.filter(message => message.t === 'debug' && message.op === 'tp')).toHaveLength(1);
    expect(sent.filter(message => message.t === 'act' && message.kind === 'mirror-push').map(message => message.id)).toEqual([1, 2]);
    expect(received.filter(message => message.t === 'correct' && !message.forced)).toEqual([]);
    for (const peer of peers) expect(peer.received.filter(message => message.t === 'correct' && !message.forced)).toEqual([]);
    expect(errors).toEqual([]);
    evidence.identity = { code, ownId, peers: peers.map(peer => peer.id), urls };
    evidence.keyTouch = key;
  } finally {
    evidence.finalView = await page.evaluate(() => {
      const game = window.__escape.game()!;
      return { p: [game.pos.x, game.body.y, game.pos.z], yaw: game.input.yaw, pitch: game.input.pitch,
        hud: [...document.querySelectorAll('#hud > *')].filter(el => !(el as HTMLElement).hidden && getComputedStyle(el).display !== 'none').map(el => ({ id: el.id, text: el.textContent, rect: el.getBoundingClientRect().toJSON() })) };
    }).catch(() => null);
    evidence.errors = errors; evidence.sent = sent; evidence.received = received;
    evidence.teammates = peers.map(peer => ({ id: peer.id, room: peer.room, state: peer.state, mirror: peer.mirror, received: peer.received }));
    writeFileSync(testInfo.outputPath('campaign-evidence.json'), JSON.stringify(evidence, null, 2));
    await Promise.all(peers.map(peer => peer.close()));
  }
});
