import { toggleSettings } from './settings-controls.ts';
import { expect, test, type Page } from '@playwright/test';
import WebSocket from 'ws';
import { mkdir, writeFile } from 'node:fs/promises';
import type { ServerMsg, Vec3 } from '../../shared/protocol.ts';
import { browserArgs } from '../browser-args.mjs';
import { RESUME_KEY } from '../../client/src/reconnect.ts';

test.use({ launchOptions: { args: browserArgs(['--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']) } });

interface CaptureDiagnostics {
  starts: number;
  lastSeq: number;
  phase: string;
  elapsed: number;
  progress: number;
  reduced: boolean;
  durationMs: number;
  side: number | string;
  by: string;
}
interface CaptureFrame {
  phase: string;
  lowering: number;
  pitch: number;
  roll: number;
  grayscale: number;
  cover: number;
  caught: boolean;
  progress: number;
  elapsed: number;
  shoulder: number;
  reach: number;
}
interface CaptureGame {
  myId: number;
  spawnSynced: boolean;
  down: boolean;
  downHold: number;
  spectate: boolean;
  body: { x: number; y: number; z: number };
  camera: { position: { x: number; y: number; z: number }; rotation: { x: number; z: number } };
  renderer: { domElement: HTMLCanvasElement; getContext(): WebGLRenderingContext };
  capture: { diagnostics: CaptureDiagnostics };
  captureFrame: CaptureFrame;
  sound: { diagnostics: { volume: number; muted: boolean; activeSources: number; played: Record<string, number> } };
}
interface Sample {
  t: number;
  diagnostics: CaptureDiagnostics;
  frame: CaptureFrame;
  eye: number;
  camera: Vec3;
  body: Vec3;
  filter: string;
  down: boolean;
  spectate: boolean;
}
interface Probe {
  messages: { t: number; message: ServerMsg }[];
  samples: Sample[];
  running: boolean;
}
declare global { interface Window { __captureProbe?: Probe } }

class Teammate {
  readonly ws: WebSocket;
  id = 0;
  readonly players = new Map<number, { p: Vec3; st: number }>();
  readonly messages: ServerMsg[] = [];
  private room?: Extract<ServerMsg, { t: 'room' }>;
  private readyIncarnation = 0;
  private epoch = 0;
  private sequence = 0;
  constructor(baseURL: string) {
    this.ws = new WebSocket(baseURL.replace(/^http/, 'ws') + '/ws');
    this.ws.on('message', (data) => {
      const message = JSON.parse(String(data)) as ServerMsg;
      this.messages.push(message);
      if (message.t === 'welcome') this.id = message.id;
      if (message.t === 'room') this.room = message;
      if (message.t === 'correct') this.epoch = message.c ?? this.epoch;
      if (message.t === 'event' && message.kind === 'intro' && !message.ended) this.send({ t: 'intro-skip', id: message.id });
      if (message.t === 'snap') {
        for (const p of message.players) this.players.set(p.id, { p: p.p, st: p.st ?? 0 });
        const incarnation = this.room?.incarnation;
        if (incarnation && this.room?.started && this.players.get(this.id)?.st === 0 && incarnation !== this.readyIncarnation) {
          this.readyIncarnation = incarnation;
          this.send({ t: 'ready', incarnation });
        }
      }
    });
  }
  async join(code: string) {
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.send({ t: 'hello', name: '救援同学' });
    this.send({ t: 'join', code });
    await expect.poll(() => this.id).toBeGreaterThan(0);
  }
  send(message: object) { this.ws.send(JSON.stringify(message)); }
  look(yaw: number) {
    const state = this.players.get(this.id);
    if (!state) throw new Error('Teammate has no authoritative position');
    this.send({ t: 'input', seq: ++this.sequence, p: state.p, c: this.epoch, yaw, pitch: 0, f: 0 });
  }
  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => { this.ws.once('close', resolve); this.ws.close(); });
  }
}

const game = (page: Page) => page.evaluate(() => {
  const g = window.__escape.game() as unknown as CaptureGame;
  return {
    id: g.myId, down: g.down, spectate: g.spectate, downHold: g.downHold,
    diagnostics: g.capture.diagnostics, frame: g.captureFrame,
    eye: g.camera.position.y - g.body.y,
    filter: g.renderer.domElement.style.filter, sound: g.sound.diagnostics,
  };
});

async function ready(page: Page) {
  await expect(page.locator('#hud')).toBeVisible({ timeout: 40_000 });
  await expect.poll(() => page.evaluate(() =>
    (window.__escape.game() as unknown as CaptureGame | null)?.spawnSynced), { timeout: 30_000 }).toBe(true);
  await page.waitForFunction(() => {
    const g = window.__escape.game(); return !!g?.presentationReady && !g.intro.active;
  }, null, { timeout: 20_000 });
  await page.evaluate(() => window.__escape.debug('safe', 600));
}

async function installProbe(page: Page) {
  await page.evaluate(() => {
    if (window.__captureProbe) window.__captureProbe.running = false;
    const probe: Probe = { messages: [], samples: [], running: true };
    window.__captureProbe = probe;
    const net = window.__escape.net, handle = net.onMsg.bind(net);
    net.onMsg = (message) => {
      if (['caught', 'correct', 'fade', 'room'].includes(message.t)) probe.messages.push({ t: performance.now(), message });
      handle(message);
    };
    const sample = () => {
      if (!probe.running) return;
      const g = window.__escape.game() as unknown as CaptureGame | null;
      if (g) probe.samples.push({
        t: performance.now(), diagnostics: g.capture.diagnostics, frame: { ...g.captureFrame },
        eye: g.camera.position.y - g.body.y, filter: g.renderer.domElement.style.filter,
        camera: [g.camera.position.x, g.camera.position.y, g.camera.position.z],
        body: [g.body.x, g.body.y, g.body.z],
        down: g.down, spectate: g.spectate,
      });
      if (probe.samples.length > 12_000) probe.samples.shift();
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

async function revive(page: Page, teammate: Teammate) {
  const id = (await game(page)).id;
  const p = teammate.players.get(id)?.p;
  if (!p) throw new Error('The real server has not supplied the downed player position');
  teammate.send({ t: 'debug', op: 'safe', s: 600 });
  teammate.send({ t: 'debug', op: 'tp', x: p[0] + 1, z: p[2] });
  await expect.poll(() => {
    const q = teammate.players.get(teammate.id)?.p;
    return q ? Math.hypot(q[0] - p[0], q[2] - p[2]) : Infinity;
  }).toBeLessThan(1.5);
  const start = Date.now();
  while (Date.now() - start < 4_500 && teammate.players.get(id)?.st === 1) {
    teammate.send({ t: 'act', kind: 'revive', id });
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  expect(Date.now() - start).toBeGreaterThan(2_800);
  await expect.poll(() => teammate.players.get(id)?.st).toBe(0);
  await expect.poll(async () => ({ down: (await game(page)).down, spectate: (await game(page)).spectate }))
    .toEqual({ down: false, spectate: false });
  await expect(page.locator('#down-overlay')).toBeHidden();
  await expect(page.locator('#capture-presentation')).toBeHidden();
  const recovery = await page.evaluate(() => window.__captureProbe!.samples.slice(-180)
    .filter((s) => s.frame.phase === 'recover'));
  // Real rendered colours must return gradually with the camera, rather than snap back at the end.
  expect(new Set(recovery.map((s) => s.filter)).size).toBeGreaterThan(3);
}

async function actualCatch(page: Page, expectedStarts: number, prefix?: string) {
  // Catch away from the spawn so any accidental return there fails the contact / body assertions.
  await page.evaluate(() => { window.__escape.debug('safe', 600); window.__escape.debug('tp', -48, 73.4); });
  await expect.poll(() => page.evaluate(() => {
    const g = window.__escape.game() as unknown as CaptureGame;
    return Math.hypot(g.body.x + 48, g.body.z - 73.4);
  })).toBeLessThan(0.15);
  await page.evaluate(() => {
    const g = window.__escape.game()!;
    g.input.yaw = Math.PI / 2; g.input.pitch = 0;
  });
  await expect.poll(() => page.evaluate(() => {
    const g = window.__escape.game()!;
    return (g as unknown as { peers: Map<number, { yaw: number }> }).peers.get(g.myId)?.yaw;
  })).toBeCloseTo(Math.PI / 2, 1);
  const before = await page.evaluate(() => performance.now());
  await page.evaluate(() => { window.__escape.debug('safe', 600); window.__escape.debug('warden', 1.5); });
  await expect.poll(async () => (await game(page)).diagnostics.starts, { timeout: 15_000, intervals: [25] }).toBe(expectedStarts);
  await expect.poll(async () => (await game(page)).frame.caught, { timeout: 1_000, intervals: [10] }).toBe(true);
  if (prefix) {
    await page.waitForTimeout(180);
    expect(await page.locator('#down-overlay').evaluate((el) =>
      (el as HTMLElement).hidden || getComputedStyle(el).visibility === 'hidden' || getComputedStyle(el).display === 'none' || Number(getComputedStyle(el).opacity) === 0)).toBe(true);
    await page.screenshot({ path: `test-results/${prefix}-threat.png`, animations: 'allow' });
    await page.waitForTimeout(330);
    await page.screenshot({ path: `test-results/${prefix}-shoulder.png`, animations: 'allow' });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `test-results/${prefix}-lowered.png`, animations: 'allow' });
  }
  await expect.poll(async () => (await game(page)).frame.caught, { timeout: 5_000, intervals: [25] }).toBe(false);
  const samples = await page.evaluate((since) => window.__captureProbe!.samples.filter((s) => s.t >= since), before);
  const active = samples.filter((s) => s.frame.caught);
  expect(active.length).toBeGreaterThan(10);
  expect(active[0]!.diagnostics.durationMs).toBe(1500);
  expect(active.at(-1)!.frame.elapsed - active[0]!.frame.elapsed).toBeGreaterThan(1_100);
  expect(active.at(-1)!.frame.elapsed).toBeLessThanOrEqual(1_600);
  expect(Math.max(...active.map((s) => s.frame.lowering))).toBeGreaterThan(0.9);
  expect(Math.max(...active.map((s) => s.frame.grayscale))).toBeGreaterThan(0.8);
  expect(Math.max(...active.map((s) => s.frame.shoulder))).toBeGreaterThan(0.5);
  expect(Math.max(...active.map((s) => s.frame.cover))).toBeGreaterThan(0.9);
  return samples;
}

test('real caught runs once, restores after rescue, respects preferences and hands off through spectator and wipe', async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  await mkdir('test-results', { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/?steady');
  await page.fill('#name', '被抓同学');
  await page.click('#create');
  await expect(page.locator('#wait-code')).toHaveText(/^[A-Z2-9]{4}$/);
  const code = await page.locator('#wait-code').innerText();
  const teammate = new Teammate(baseURL!);
  try {
    await teammate.join(code);
    await expect(page.locator('#wait-members li')).toHaveCount(2);
    await page.click('#start');
    await ready(page);
    teammate.send({ t: 'debug', op: 'safe', s: 600 });
    await installProbe(page);
    await page.keyboard.press('KeyF'); // A trusted gesture unlocks the existing sound graph.
    await expect.poll(async () => (await game(page)).sound.played.click ?? 0).toBeGreaterThan(0);
    const baseline = await game(page);
    const gl = await page.evaluate(() => {
      const gl = (window.__escape.game() as unknown as CaptureGame).renderer.getContext();
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : gl.getParameter(gl.RENDERER) as string;
    });
    if (process.platform === 'darwin') expect(gl).toMatch(/Metal|Apple/);

    // A plain state transition must never fabricate a capture event.
    await page.evaluate(() => window.__escape.debug('down'));
    await expect.poll(async () => (await game(page)).down).toBe(true);
    expect((await game(page)).diagnostics.starts).toBe(0);
    expect((await game(page)).frame.caught).toBe(false);
    await expect(page.locator('#down-overlay .t')).toHaveText('你被抓住了');
    await revive(page, teammate);

    const firstSamples = await actualCatch(page, 1, 'capture');
    const first = await game(page);
    expect(first).toMatchObject({ down: true, spectate: false, downHold: 30 });
    expect(first.eye).toBeLessThan(baseline.eye - 0.5);
    expect(first.filter).toContain('grayscale');
    await expect.poll(async () => (await game(page)).sound.played.heartbeat ?? 0).toBeGreaterThan(0);
    const authority = await page.evaluate(() => window.__captureProbe!.messages);
    const caughtIndex = authority.findIndex(({ message }) => message.t === 'caught');
    expect(caughtIndex).toBeGreaterThanOrEqual(0);
    const event = authority[caughtIndex]!.message as ServerMsg & { id: number; seq: number; tick: number; at: Vec3; source: Vec3; hold: number };
    expect(event).toMatchObject({ id: first.id, hold: 30, by: 'warden' });
    expect(event.seq).toBeGreaterThan(0);
    expect(event.tick).toBeGreaterThan(0);
    expect(Math.hypot(event.source[0] - event.at[0], event.source[2] - event.at[2])).toBeLessThanOrEqual(3);
    expect(authority.slice(caughtIndex + 1).some(({ message }) => message.t === 'correct')).toBe(true);
    const anchored = firstSamples.filter((s) => s.frame.caught && s.frame.elapsed > 150);
    expect(Math.max(...anchored.map((s) => Math.hypot(s.camera[0] - event.at[0], s.camera[2] - event.at[2])))).toBeLessThan(0.15);
    expect(Math.max(...firstSamples.map((s) => Math.hypot(s.body[0] - event.at[0], s.body[1] - event.at[1], s.body[2] - event.at[2])))).toBeLessThan(.015);
    await expect(page.locator('#down-overlay')).toBeVisible();
    await expect(page.locator('#down-overlay .t')).toHaveText('你被角色074抓住了');

    // Replay the actual event and state, including a forged peer id, through the real client dispatcher.
    await page.evaluate((caught) => {
      const g = window.__escape.game() as unknown as CaptureGame;
      for (let i = 0; i < 5; i++) window.__escape.net.onMsg(caught);
      window.__escape.net.onMsg({ ...caught, id: g.myId + 1000, seq: caught.seq + 10 } as ServerMsg);
      for (let i = 0; i < 5; i++) window.__escape.net.onMsg({ t: 'snap', tick: caught.tick,
        players: [{ id: g.myId, p: [g.body.x, g.body.y, g.body.z], yaw: 0, st: 1 }], mobs: [] });
    }, event);
    expect((await game(page)).diagnostics.starts).toBe(1);
    await revive(page, teammate);
    await page.waitForTimeout(250);
    expect((await game(page)).eye).toBeCloseTo(baseline.eye, 1);
    expect((await game(page)).filter).toBe('');
    await page.evaluate((caught) => window.__escape.net.onMsg(caught), event);
    expect((await game(page)).diagnostics.starts).toBe(1);
    expect((await game(page)).down).toBe(false);
    await page.screenshot({ path: 'test-results/capture-revived.png' });

    // A real capture of the teammate changes their snapshot but does not play locally.
    teammate.send({ t: 'debug', op: 'safe', s: 600 });
    teammate.look(Math.PI / 2); // summon along the corridor; the default yaw points through its side wall
    teammate.send({ t: 'debug', op: 'warden', d: 1.5 });
    await expect.poll(() => teammate.players.get(teammate.id)?.st, { timeout: 15_000 }).toBe(1);
    expect((await game(page)).diagnostics.starts).toBe(1);
    expect((await game(page)).down).toBe(false);
    // The teammate remains down until the local player completes a real server rescue.
    const bot = teammate.players.get(teammate.id)!.p;
    await page.evaluate(([x, , z]) => window.__escape.debug('tp', x + 1, z), bot);
    const rescueStarted = Date.now();
    while (Date.now() - rescueStarted < 4_500 && teammate.players.get(teammate.id)?.st === 1) {
      await page.evaluate((id) => window.__escape.net.send({ t: 'act', kind: 'revive', id }), teammate.id);
      await page.waitForTimeout(200); // leave budget for debug/room commands alongside the real 20 Hz movement input
    }
    await expect.poll(() => teammate.players.get(teammate.id)?.st).toBe(0);
    await page.waitForTimeout(1_000); // clear the prior hold's rolling transport window before the next explicit summon

    // Keep a teammate alive so the full 30-second deadline can hand us to a stable observer state.
    const expired = await actualCatch(page, 2);
    await page.waitForTimeout(20_000);
    expect((await game(page)).down).toBe(true);
    expect((await game(page)).spectate).toBe(false);
    await expect.poll(async () => (await game(page)).spectate, { timeout: 20_000 }).toBe(true);
    await expect(page.locator('#spec-bar')).toBeVisible();
    await expect(page.locator('#capture-presentation')).toBeHidden();
    const deadline = await page.evaluate(() => {
      const samples = window.__captureProbe!.samples;
      const active = samples.find((s) => s.diagnostics.starts === 2 && s.frame.caught);
      const observer = samples.find((s) => s.diagnostics.starts === 2 && s.spectate);
      return active && observer ? observer.t - active.t : 0;
    });
    expect(deadline).toBeGreaterThanOrEqual(29_000);
    expect(deadline).toBeLessThan(35_000);
    await page.screenshot({ path: 'test-results/capture-observer.png' });

    // Use a fresh identity on the same page: automatic resume would exercise recovery instead of late joining.
    const expiredId = (await game(page)).id;
    await page.evaluate((key) => sessionStorage.removeItem(key), RESUME_KEY);
    await page.reload();
    await page.fill('#name', '迟到同学');
    await page.fill('#code', code);
    await page.click('#join');
    await ready(page);
    await installProbe(page);
    expect((await game(page)).id).not.toBe(expiredId);
    await expect.poll(async () => (await game(page)).spectate).toBe(true);
    expect((await game(page)).diagnostics.starts).toBe(0);
    await expect(page.locator('#capture-presentation')).toBeHidden();

    // All players out: preserve seed, show the existing black handoff, then return to a fresh live state.
    const beforeWipe = teammate.messages.filter((m) => m.t === 'room').at(-1)!;
    const wipeStarted = await page.evaluate(() => performance.now());
    teammate.send({ t: 'debug', op: 'down', s: 30 });
    await expect(page.locator('#fade-overlay')).toBeVisible({ timeout: 2_000 });
    const wipe = await page.evaluate((since) => window.__captureProbe!.messages.find((m) => m.t >= since && m.message.t === 'fade'), wipeStarted);
    expect(wipe?.message).toMatchObject({ t: 'fade', restart: true });
    expect(wipe!.t - wipeStarted).toBeLessThan(1_000);
    await expect(page.locator('#fade-overlay')).toContainText('全员出局');
    await expect.poll(() => page.locator('#fade-overlay').evaluate((el) => Number(getComputedStyle(el).opacity)))
      .toBeGreaterThan(.95);
    await page.screenshot({ path: 'test-results/capture-wipe.png', animations: 'allow' });
    await expect(page.locator('#fade-overlay')).toBeHidden({ timeout: 15_000 });
    await expect.poll(async () => ({ down: (await game(page)).down, spectate: (await game(page)).spectate }))
      .toEqual({ down: false, spectate: false });
    await ready(page);
    expect((await game(page)).diagnostics.starts).toBe(0);
    const afterWipe = teammate.messages.filter((m) => m.t === 'room').at(-1)!;
    expect(afterWipe).toMatchObject({ level: beforeWipe.level, seed: beforeWipe.seed });

    // Respect native reduced motion plus the user's zero-volume preference on another actual catch.
    await page.setViewportSize({ width: 844, height: 390 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await toggleSettings(page);
    await page.locator('#settings-volume').press('Home');
    await expect.poll(async () => (await game(page)).sound.volume).toBe(0);
    await toggleSettings(page);
    const silent = (await game(page)).sound.played;
    const reducedSamples = await actualCatch(page, 1, 'capture-reduced');
    const reduced = reducedSamples.filter((s) => s.frame.caught);
    expect(reduced.every((s) => s.diagnostics.reduced)).toBe(true);
    expect(Math.max(...reduced.map((s) => Math.abs(s.frame.roll)))).toBe(0);
    expect(Math.max(...reduced.map((s) => Math.abs(s.frame.pitch)))).toBe(0);
    expect((await game(page)).sound.played).toEqual(silent);
    expect((await game(page)).sound.activeSources).toBe(0);
    await expect(page.locator('#down-overlay')).toBeVisible();
    await expect(page.locator('body')).toHaveClass(/capture-penalty/);
    // Check computed visibility even when these nodes also have [hidden]: removing the penalty rule must fail.
    await expect(page.locator('#banner')).toHaveCSS('visibility', 'hidden');
    await expect(page.locator('#tut')).toHaveCSS('visibility', 'hidden');
    await page.screenshot({ path: 'test-results/capture-reduced-penalty.png' });
    await revive(page, teammate);

    await toggleSettings(page);
    await page.locator('#settings-volume').press('End');
    await page.check('#settings-muted');
    await toggleSettings(page);
    const muted = (await game(page)).sound.played;
    await actualCatch(page, 2);
    expect((await game(page)).sound).toMatchObject({ muted: true, volume: 1, activeSources: 0 });
    expect((await game(page)).sound.played).toEqual(muted);
    await revive(page, teammate);

    expect(errors).toEqual([]);
    const evidence = { renderer: gl, deadlineMs: deadline, authority, firstSamples, expired, reducedSamples, errors };
    await writeFile('test-results/capture-evidence.json', JSON.stringify(evidence, null, 2));
    await test.info().attach('capture-evidence', { body: JSON.stringify({ renderer: gl, deadlineMs: deadline, errors }), contentType: 'application/json' });
  } finally {
    const probe = await page.evaluate(() => {
      const g = window.__escape.game() as any;
      return { local: g && { id: g.myId, body: [g.body.x, g.body.y, g.body.z],
        yaw: g.input.yaw, down: g.down, spectate: g.spectate, capture: g.capture.diagnostics,
        connection: window.__escape.net.state, peers: [...g.peers],
        mobs: [...g.mobs.byId].map(([id, m]: [number, any]) => ({ id, pos: m.root?.position?.toArray(),
          mesh: m.mesh?.position?.toArray(), target: m.target, anim: m.anim, yaw: m.yaw })) },
        messages: window.__captureProbe?.messages, samples: window.__captureProbe?.samples.slice(-120) };
    }).catch(() => null);
    const probePath = test.info().outputPath('capture-final-probe.json');
    await writeFile(probePath, JSON.stringify({ probe,
      teammate: { id: teammate.id, readyState: teammate.ws.readyState, players: [...teammate.players],
        recentSnapshots: teammate.messages.filter((m) => m.t === 'snap').slice(-40) } }));
    await test.info().attach('capture-final-probe', { path: probePath, contentType: 'application/json' });
    await teammate.close();
  }
});
