import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import WebSocket from 'ws';
import { TICK_MS } from '../../shared/constants.ts';
import type { CampaignMirrorSnap } from '../../shared/l7-campaign.ts';
import { L7_CAMPUS_DOORS } from '../../shared/levels/l7.ts';
import { ST_DOWN, ST_OK, type ClientMsg, type ServerMsg, type Vec3 } from '../../shared/protocol.ts';
import { frame } from '../e2e/draw.ts';

type Snap = Extract<ServerMsg, { t: 'snap' }>;
type Room = Extract<ServerMsg, { t: 'room' }>;
type Sample = { at: number; tick: number; players: Snap['players'] };

/** One ordinary /ws teammate, with no second browser or alternative game server. */
class DesktopTeammate {
  readonly received: ServerMsg[] = [];
  readonly sent: ClientMsg[] = [];
  readonly samples: Sample[] = [];
  readonly doorOpen = new Map<number, boolean>();
  readonly errors: string[] = [];
  id = 0;
  room?: Room;
  snap?: Snap;
  mirror?: CampaignMirrorSnap;
  private p?: Vec3;
  private epoch = 0;
  private seq = 0;
  private readonly socket: WebSocket;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on('error', error => this.errors.push(error.message));
    this.socket.on('message', raw => {
      const message = JSON.parse(String(raw)) as ServerMsg;
      if (message.t === 'snap') {
        this.snap = message;
        this.samples.push({ at: Date.now(), tick: message.tick, players: message.players });
      } else if (message.t === 'l7') this.mirror = message;
      else if (message.t !== 'nav') this.received.push(message);
      // Door snapshots are deltas after their initial full state; omitted fields keep the last state.
      if (message.t === 'doors' || message.t === 'snap') {
        for (const door of message.doors ?? []) this.doorOpen.set(door.id, door.open);
      }
      if (message.t === 'welcome') this.id = message.id;
      if (message.t === 'room') this.room = message;
      if (message.t === 'correct') {
        this.p = message.p;
        this.epoch = message.c ?? this.epoch;
      }
    });
    this.timer = setInterval(() => {
      if (!this.p || !this.room?.started || this.socket.readyState !== WebSocket.OPEN) return;
      // Face away from the duty student: a teammate looking directly at it would freeze its turn.
      this.send({ t: 'input', seq: ++this.seq, p: this.p, yaw: 0, pitch: 0, f: 0, c: this.epoch });
    }, TICK_MS);
  }

  get state() { return this.snap?.players.find(player => player.id === this.id); }
  get status() { const player = this.state; return player ? player.st ?? ST_OK : undefined; }

  send(message: ClientMsg) {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Desktop teammate socket is not open');
    this.sent.push(message);
    this.socket.send(JSON.stringify(message));
  }

  async close() {
    clearInterval(this.timer);
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>(resolve => {
      this.socket.once('close', () => resolve());
      if (this.socket.readyState === WebSocket.CONNECTING) this.socket.terminate();
      else this.socket.close();
    });
  }
}

/** Aim the crosshair for each interaction; actions themselves always come from browser keyboard events. */
async function aim(page: Page, yaw: number, pitch = 0) {
  await page.evaluate(({ yaw, pitch }) => {
    const input = window.__escape.game()!.input;
    input.yaw = yaw;
    input.pitch = pitch;
  }, { yaw, pitch });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function capture(page: Page, path: string) {
  await frame(page);
  await page.evaluate(async () => {
    await (document.getElementById('e2e-shot') as HTMLImageElement).decode();
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  try { await page.screenshot({ path }); }
  finally { await page.evaluate(() => document.getElementById('e2e-shot')?.remove()); }
}

test.describe('desktop L7 campaign controls', () => {
  test.use({ viewport: { width: 1280, height: 720 }, hasTouch: false, isMobile: false });

  test('keyboard E takes the reflected key, pushes its real wall and holds a teammate rescue', async ({ page, baseURL }, testInfo) => {
    const errors: string[] = [], urls: string[] = [], sent: ClientMsg[] = [], received: ServerMsg[] = [];
    const evidence: Record<string, unknown> = {};
    let teammate: DesktopTeammate | undefined;
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
      await page.fill('#name', '镜廊桌面');
      await page.click('#create');
      await expect(page.locator('#wait-code')).not.toBeEmpty();
      const code = await page.locator('#wait-code').innerText();
      const url = `${baseURL!.replace(/^http/, 'ws')}/ws`;
      teammate = new DesktopTeammate(url);
      const peer = teammate;
      await expect.poll(() => peer.id).toBeGreaterThan(0);
      peer.send({ t: 'hello', name: '桌面救援队友' });
      peer.send({ t: 'join', code });
      await expect.poll(() => peer.room?.code).toBe(code);
      await expect(page.locator('#wait-members li')).toHaveCount(2);
      await page.click('#start');
      await page.waitForFunction(() => window.__escape.game()?.presentationReady);
      await page.waitForFunction(() => !window.__escape.game()?.intro.active);
      const ownId = await page.evaluate(() => window.__escape.game()!.myId);

      // Directed development setup loads the real chapter in the existing Room and keeps both /ws identities.
      await page.evaluate(() => {
        window.__escape.debug('safe', 600);
        window.__escape.debug('level', 6);
      });
      await page.waitForFunction(() => window.__escape.game()?.presentationReady && window.__escape.game()!.level.index === 6 && !!window.__escape.game()!.mirrorState);
      await page.waitForFunction(() => !window.__escape.game()?.intro.active);
      await page.evaluate(() => {
        window.__escape.debug('safe', 600);
        window.__escape.debug('tp', -80.4, 143.4, 0);
      });
      await expect.poll(() => page.evaluate(() => window.__escape.game()!.pos.x)).toBeCloseTo(-80.4, 1);
      await expect(page.locator('#banner')).toBeHidden({ timeout: 15_000 });
      await expect(page.locator('#touch')).toBeHidden();
      expect(page.viewportSize()).toEqual({ width: 1280, height: 720 });
      expect(await page.evaluate(() => ({ id: window.__escape.game()!.myId, touch: document.body.classList.contains('touch'), overflow: document.documentElement.scrollWidth > innerWidth })))
        .toEqual({ id: ownId, touch: false, overflow: false });
      await expect.poll(() => peer.room?.level).toBe(6);
      expect(peer.room).toMatchObject({ code, host: ownId, started: true });
      expect(peer.id).not.toBe(ownId);
      await expect.poll(() => peer.status).toBe(ST_OK);
      await expect.poll(() => page.evaluate(() => window.__escape.game()!.remotes.size)).toBe(1);
      const renderer = await page.evaluate(() => {
        const gl = window.__escape.game()!.renderer.getContext(), extension = gl.getExtension('WEBGL_debug_renderer_info');
        return String(gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
      });
      expect(renderer).toMatch(/Metal/i);
      evidence.identity = { code, ownId, peerId: peer.id, urls, renderer };

      await aim(page, Math.PI / 2, -.1);
      const keyWindow = () => page.evaluate(() => {
        const game = window.__escape.game()!, yaw = game.mirrorState!.key.guard.yaw;
        // The leading half of the exposed pouch leaves time for a real keyboard round trip.
        return -Math.sin(yaw) > .98 && Math.cos(yaw) < 0 && game.target()?.kind === 'mirror-key';
      });
      await expect.poll(keyWindow, { timeout: 12_000, intervals: [50] }).toBe(true);
      await expect.poll(() => page.evaluate(() => window.__escape.game()!.mirrorState!.revealedDoors)).toEqual([1]);
      await expect.poll(() => peer.mirror?.revealedDoors).toEqual([1]);
      await capture(page, testInfo.outputPath('desktop-mirror-key-window.png'));
      // Screenshot rendering may outlast the turn window: reacquire before pressing E.
      await expect.poll(keyWindow, { timeout: 12_000, intervals: [50] }).toBe(true);
      await page.keyboard.press('KeyE');
      await expect.poll(() => page.evaluate(() => window.__escape.game()!.mirrorState?.key.taken)).toBe(true);
      await expect.poll(() => peer.mirror?.key.taken).toBe(true);
      expect(sent.filter(message => message.t === 'act' && message.kind === 'mirror-key')).toEqual([{ t: 'act', kind: 'mirror-key', id: 0 }]);
      expect(await page.evaluate(() => window.__escape.game()!.mirrorView!.stats().geometryMirror)).toBe(true);
      expect(await page.evaluate(() => window.__escape.stats().calls)).toBeLessThanOrEqual(150);

      await aim(page, -Math.PI / 2);
      await page.keyboard.down('KeyW');
      try {
        await expect.poll(() => page.evaluate(() => window.__escape.game()!.pos.x), { timeout: 5_000, intervals: [50] }).toBeGreaterThan(-79.25);
      } finally { await page.keyboard.up('KeyW'); }
      await expect(page.locator('#prompt')).toHaveText('E 推开镜中门对应的墙');
      await page.keyboard.press('KeyE');
      await expect.poll(() => page.evaluate(() => window.__escape.game()!.mirrorState!.openDoors)).toEqual([1]);
      await expect.poll(() => peer.mirror?.openDoors).toEqual([1]);
      expect(sent.filter(message => message.t === 'act' && message.kind === 'mirror-push')).toEqual([{ t: 'act', kind: 'mirror-push', id: 1 }]);
      await capture(page, testInfo.outputPath('desktop-secret-wall-open.png'));

      // Only the downed condition is debug setup. The page must target and hold E through the normal rescue path.
      const targetId = peer.id;
      expect(peer.state).toBeDefined();
      const targetPosition = peer.state!.p;
      const distance = await page.evaluate(p => {
        const game = window.__escape.game()!;
        return Math.hypot(game.pos.x - p[0], game.body.y - p[1], game.pos.z - p[2]);
      }, targetPosition);
      expect(distance).toBeLessThan(1.5);
      peer.send({ t: 'debug', op: 'down', s: 30 });
      await expect.poll(() => peer.status).toBe(ST_DOWN);
      await expect.poll(() => page.evaluate(id => window.__escape.game()!.remotes.get(id)?.down, targetId)).toBe(true);
      await expect.poll(() => page.evaluate(id => window.__escape.game()!.remotes.get(id)?.st.fallen, targetId)).toBe(1);
      const rescueAim = await page.evaluate(p => {
        const game = window.__escape.game()!, dx = p[0] - game.pos.x, dz = p[2] - game.pos.z;
        return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(p[1] + .4 - game.camera.position.y, Math.hypot(dx, dz)) };
      }, targetPosition);
      await aim(page, rescueAim.yaw, rescueAim.pitch);
      await expect.poll(() => page.evaluate(() => {
        const target = window.__escape.game()!.target();
        return target?.kind === 'revive' ? target.id : null;
      })).toBe(targetId);
      await expect(page.locator('#prompt')).toHaveText('按住 E 搀扶');
      await capture(page, testInfo.outputPath('desktop-teammate-down.png'));
      const heldAt = Date.now();
      const heldFromTick = peer.snap!.tick;
      await page.keyboard.down('KeyE');
      try {
        await expect.poll(() => peer.status, { timeout: 10_000, intervals: [50] }).toBe(ST_OK);
      } finally { await page.keyboard.up('KeyE'); }
      const heldMs = Date.now() - heldAt;
      expect(heldMs).toBeGreaterThanOrEqual(2_800);
      expect(sent.filter(message => message.t === 'act' && message.kind === 'revive' && message.id === targetId).length).toBeGreaterThan(1);
      const recovered = peer.samples.find(sample => sample.at >= heldAt && sample.players.some(player => player.id === targetId && (player.st ?? ST_OK) === ST_OK));
      expect(recovered).toBeDefined();
      expect(recovered!.tick - heldFromTick).toBeGreaterThanOrEqual(Math.ceil(3_000 / TICK_MS));
      await expect.poll(() => {
        const latest = peer.samples.at(-1);
        return !!latest && latest.at - recovered!.at >= 2_100 && latest.tick - recovered!.tick >= Math.ceil(2_000 / TICK_MS);
      }, { timeout: 5_000, intervals: [100] }).toBe(true);
      const stable = peer.samples.filter(sample => sample.tick >= recovered!.tick);
      expect(stable.at(-1)!.at - stable[0].at).toBeGreaterThanOrEqual(2_000);
      expect(stable.length).toBeGreaterThanOrEqual(Math.ceil(2_000 / TICK_MS) + 1);
      for (const sample of stable) {
        expect(sample.players.map(player => player.id).sort((a, b) => a - b)).toEqual([ownId, targetId].sort((a, b) => a - b));
        expect(sample.players.map(player => player.st ?? ST_OK)).toEqual([ST_OK, ST_OK]);
      }
      await expect.poll(() => page.evaluate(id => {
        const game = window.__escape.game()!, remote = game.remotes.get(id);
        return { id: game.myId, code: window.__escape.code, level: game.level.index, down: game.down, spectate: game.spectate, remoteDown: remote?.down, remoteOut: remote?.out };
      }, targetId)).toEqual({ id: ownId, code, level: 6, down: false, spectate: false, remoteDown: false, remoteOut: false });
      await capture(page, testInfo.outputPath('desktop-teammate-recovered.png'));
      expect(await page.evaluate(id => window.__escape.game()!.remotes.get(id)?.st.fallen, targetId)).toBe(0);
      evidence.rescue = { targetId, distance, heldMs, heldFromTick, recovered, stable, downPose: 1, recoveredPose: 0 };

      // Walk to the existing LAB door. Its keyboard toggle, animation, prediction and authoritative
      // collision must remain usable after the mirror key/wall and rescue paths ran in this Room.
      const door = L7_CAMPUS_DOORS.find(d => d.x === -81.25 && (d.y0 ?? 0) === 0)!;
      expect(door).toBeDefined();
      await aim(page, Math.PI / 2);
      await page.keyboard.down('KeyW');
      try {
        await expect.poll(() => page.evaluate(() => window.__escape.game()!.pos.x), { timeout: 5_000, intervals: [25] }).toBeLessThan(door.x + .04);
      } finally { await page.keyboard.up('KeyW'); }
      expect(await page.evaluate(() => window.__escape.game()!.pos.x)).toBeGreaterThan(door.x - .15);
      await aim(page, 0);
      await page.keyboard.down('KeyW');
      try {
        await expect.poll(() => page.evaluate(() => window.__escape.game()!.pos.z), { timeout: 5_000, intervals: [25] }).toBeLessThan(door.z + 1.2);
      } finally { await page.keyboard.up('KeyW'); }
      await expect.poll(() => page.evaluate(() => window.__escape.game()!.target())).toMatchObject({ kind: 'use', id: door.id });
      await expect(page.locator('#prompt')).toHaveText('E 关上');
      await capture(page, testInfo.outputPath('desktop-lab-door-open-before.png'));
      await page.keyboard.press('KeyE');
      await expect.poll(() => page.evaluate(id => window.__escape.game()!.doorOpen[id], door.id)).toBe(false);
      await expect.poll(() => peer.doorOpen.get(door.id)).toBe(false);
      await page.keyboard.down('KeyW');
      try { await page.waitForTimeout(1_000); }
      finally { await page.keyboard.up('KeyW'); }
      const blocked = await page.evaluate(() => {
        const game = window.__escape.game()!;
        return [game.pos.x, game.body.y, game.pos.z] as Vec3;
      });
      expect(blocked[2]).toBeGreaterThanOrEqual(door.box.z1 + .3 - .02);
      expect(blocked[2]).toBeLessThan(door.box.z1 + .3 + .1);
      await expect.poll(() => peer.snap?.players.find(p => p.id === ownId)?.p[2]).toBeCloseTo(blocked[2], 1);
      await capture(page, testInfo.outputPath('desktop-lab-door-closed-blocks.png'));
      await expect(page.locator('#prompt')).toHaveText('E 打开');
      await page.keyboard.press('KeyE');
      await expect.poll(() => page.evaluate(id => window.__escape.game()!.doorOpen[id], door.id)).toBe(true);
      await expect.poll(() => peer.doorOpen.get(door.id)).toBe(true);
      await page.keyboard.down('KeyW');
      try {
        await expect.poll(() => page.evaluate(() => window.__escape.game()!.pos.z), { timeout: 5_000, intervals: [25] }).toBeLessThan(door.z - .7);
      } finally { await page.keyboard.up('KeyW'); }
      const crossed = await page.evaluate(() => {
        const game = window.__escape.game()!;
        return [game.pos.x, game.body.y, game.pos.z] as Vec3;
      });
      await expect.poll(() => peer.snap?.players.find(p => p.id === ownId)?.p[2]).toBeLessThan(door.z - .7);
      await aim(page, Math.PI);
      await capture(page, testInfo.outputPath('desktop-lab-door-open-crossed.png'));
      expect(sent.filter(message => message.t === 'act' && message.kind === 'use')).toEqual([
        { t: 'act', kind: 'use', id: door.id }, { t: 'act', kind: 'use', id: door.id },
      ]);
      expect(await page.evaluate(() => window.__escape.game()!.mirrorState!.openDoors)).toEqual([1]);
      expect(await page.evaluate(() => window.__escape.game()!.mirrorState!.key.taken)).toBe(true);
      evidence.ordinaryDoor = { id: door.id, blocked, crossed };
      expect(peer.room).toMatchObject({ code, host: ownId, level: 6, started: true });
      expect(urls).toEqual([url]);
      expect(sent.filter(message => message.t === 'debug' && message.op === 'tp')).toHaveLength(1);
      expect(received.filter(message => message.t === 'correct' && !message.forced)).toEqual([]);
      expect(peer.received.filter(message => message.t === 'correct' && !message.forced)).toEqual([]);
      expect(peer.errors).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await page.keyboard.up('KeyE').catch(() => {});
      await page.keyboard.up('KeyW').catch(() => {});
      evidence.finalView = await page.evaluate(() => {
        const game = window.__escape.game();
        return game ? { id: game.myId, code: window.__escape.code, level: game.level.index, p: [game.pos.x, game.body.y, game.pos.z], down: game.down, spectate: game.spectate } : null;
      }).catch(() => null);
      evidence.errors = errors;
      evidence.sent = sent;
      evidence.received = received;
      evidence.teammate = teammate ? { id: teammate.id, room: teammate.room, state: teammate.state, mirror: teammate.mirror, errors: teammate.errors, received: teammate.received, sent: teammate.sent, samples: teammate.samples } : null;
      writeFileSync(testInfo.outputPath('desktop-campaign-evidence.json'), JSON.stringify(evidence, null, 2));
      await teammate?.close();
    }
  });
});
