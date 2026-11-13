import { expect, test, type BrowserContext, type Page, type Video } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import type { IntroEvent } from '../../shared/intro.ts';
import type { ClientMsg, PlayerSnap, ServerMsg, Vec3 } from '../../shared/protocol.ts';
import { LOOK_SENS } from '../../client/src/touch.ts';
import { TOUCH_DRAG_PX } from '../../client/src/worldTouch.ts';

type Received = { m: ServerMsg; at: number };
type Snap = Extract<ServerMsg, { t: 'snap' }>;
type Room = Extract<ServerMsg, { t: 'room' }>;
type Clear = Extract<ServerMsg, { t: 'event'; kind: 'clear' }>;
const isIntro = (m: ServerMsg): m is IntroEvent => m.t === 'event' && m.kind === 'intro';
const isSnap = (m: ServerMsg): m is Snap => m.t === 'snap';

/** A real wire peer: these checks exercise the built HTTP/WS server, not Room internals. */
class Peer {
  readonly ws: WebSocket;
  readonly received: Received[] = [];
  readonly errors: string[] = [];
  id = 0;
  epoch = 0;
  seq = 0;

  constructor(url: string) {
    this.ws = new WebSocket(url.replace(/^http/, 'ws') + '/ws');
    this.ws.on('error', (error) => this.errors.push(error.message));
    this.ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as ServerMsg;
      this.received.push({ m, at: Date.now() });
      if (m.t === 'welcome') this.id = m.id;
      if (m.t === 'correct' && m.c !== undefined) this.epoch = m.c;
    });
  }

  async ready(name: string) {
    await this.take((m): m is Extract<ServerMsg, { t: 'welcome' }> => m.t === 'welcome');
    this.send({ t: 'hello', name });
    return this;
  }

  send(m: ClientMsg) { this.ws.send(JSON.stringify(m)); }
  async take<T extends ServerMsg>(predicate: (m: ServerMsg) => m is T, after = 0, timeout = 12_000): Promise<T> {
    let match: T | undefined;
    await expect.poll(() => {
      expect(this.errors).toEqual([]);
      match = this.received.slice(after).map((r) => r.m).find(predicate);
      return !!match;
    }, { timeout, intervals: [20, 50, 100] }).toBe(true);
    return match!;
  }
  get snaps() { return this.received.filter((r) => isSnap(r.m)).map((r) => r.m as Snap); }
  get lastSnap() { return this.snaps.at(-1)!; }
  get own(): PlayerSnap { return this.lastSnap.players.find((p) => p.id === this.id)!; }
  move(dx: number) { this.send({ t: 'input', seq: ++this.seq, c: this.epoch, p: [this.own.p[0] + dx, this.own.p[1], this.own.p[2]], yaw: 0.25, pitch: 0.1, f: 6 }); }
  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((done) => {
      const timeout = setTimeout(() => { this.ws.terminate(); done(); }, 2_000);
      this.ws.once('close', () => { clearTimeout(timeout); done(); }); this.ws.close();
    });
  }
}

async function pair(baseURL: string) {
  const a = await new Peer(baseURL).ready('验收甲');
  a.send({ t: 'create' });
  const room = await a.take((m): m is Room => m.t === 'room');
  const b = await new Peer(baseURL).ready('验收乙');
  b.send({ t: 'join', code: room.code });
  await a.take((m): m is Room => m.t === 'room' && m.players.length === 2);
  return { a, b, code: room.code };
}

const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const ended = (id: number) => (m: ServerMsg): m is IntroEvent => isIntro(m) && m.id === id && m.ended;

async function evidence(name: string, value: unknown) {
  const path = resolve('test-results', `cinematic-${name}.json`);
  await mkdir(resolve('test-results'), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
  await test.info().attach(name, { path, contentType: 'application/json' });
}

function frozenView(snap: Snap, ids: number[]) {
  return { players: snap.players.filter((p) => ids.includes(p.id)).map((p) => ({ id: p.id, p: p.p, yaw: p.yaw, pitch: p.pitch, st: p.st ?? 0 })),
    mobs: snap.mobs.map((m) => ({ id: m.id, p: m.p, yaw: m.yaw })) };
}

/** Compare every fresh frame: stale lastSnap alone is not evidence that a world is frozen. */
function assertFrozen(peer: Peer, before: Snap, from: number, until = peer.received.length, minimum = 8) {
  const ids = before.players.map((p) => p.id), frames = peer.received.slice(from, until).map((r) => r.m).filter(isSnap);
  expect(before.mobs.length, 'monsters must actually exist').toBeGreaterThan(0);
  expect(frames.length).toBeGreaterThanOrEqual(minimum);
  expect(frames.at(-1)!.tick).toBeGreaterThan(before.tick);
  for (const frame of frames) expect(frozenView(frame, ids)).toEqual(frozenView(before, ids));
  return frames.length;
}

async function exerciseInput(a: Peer, b: Peer, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) { a.move(0.1); b.move(0.1); await new Promise((done) => setTimeout(done, 80)); }
}

async function assertReleased(a: Peer, b: Peer, before: Snap) {
  const startA = structuredClone(a.own.p), startB = structuredClone(b.own.p);
  await exerciseInput(a, b, 650);
  expect(distance(a.own.p, startA)).toBeGreaterThan(0.25); expect(distance(b.own.p, startB)).toBeGreaterThan(0.25);
  await expect.poll(() => a.lastSnap.mobs.some((m) => {
    const original = before.mobs.find((old) => old.id === m.id);
    return original && distance(m.p, original.p) > 0.05;
  }), { timeout: 3_000, intervals: [50, 100] }).toBe(true);
}

test('real WS: intro freezes input and monsters; one skip waits and all voters release', async ({ baseURL }) => {
  const { a, b, code } = await pair(baseURL!);
  let late: Peer | undefined;
  try {
    a.send({ t: 'start' });
    const ia = await a.take(isIntro), ib = await b.take(isIntro);
    expect(ia).toEqual(ib);
    expect(ia.endsAt - ia.startedAt).toBe(8_000);
    expect(ia.ended).toBe(false);
    await a.take(isSnap); await b.take(isSnap);
    const before = structuredClone(a.lastSnap), mark = a.received.length;
    await exerciseInput(a, b, 650);
    const initialFrames = assertFrozen(a, before, mark);
    a.send({ t: 'intro-skip', id: ia.id });
    await b.take((m): m is IntroEvent => isIntro(m) && m.id === ia.id && m.skipped.includes(a.id));
    const singleSkipMark = a.received.length;
    late = await new Peer(baseURL!).ready('无表决权观察者'); late.send({ t: 'join', code });
    const observerIntro = await late.take(isIntro);
    expect(observerIntro.endsAt).toBe(ia.endsAt);
    await late.take(isSnap); expect(late.own.st).toBe(2);
    await exerciseInput(a, b, 650);
    expect(a.received.some((r) => ended(ia.id)(r.m))).toBe(false);
    const oneSkipFrames = assertFrozen(a, before, singleSkipMark);
    b.send({ t: 'intro-skip', id: ia.id });
    const endA = await a.take(ended(ia.id)), endB = await b.take(ended(ia.id));
    await late.take(ended(ia.id));
    expect(endA).toEqual(endB); expect(endA.now).toBeLessThan(ia.endsAt);
    expect([...endA.skipped].sort()).toEqual([a.id, b.id].sort());
    await assertReleased(a, b, before);
    expect(late.own.st).toBe(2);
    await evidence('wire-all-skip', { intro: ia, end: endA, observerIntro, initialFrames, oneSkipFrames,
      before: frozenView(before, [a.id, b.id]), after: frozenView(a.lastSnap, [a.id, b.id]) });
  } finally { await Promise.all([a.close(), b.close(), late?.close()]); }
});

test('real WS: deadline stays eight seconds and late join receives the remainder as an observer', async ({ baseURL }) => {
  const { a, b, code } = await pair(baseURL!);
  let late: Peer | undefined, pump: ReturnType<typeof setInterval> | undefined;
  try {
    a.send({ t: 'start' });
    const intro = await a.take(isIntro);
    const startedAt = a.received.find((r) => r.m === intro)!.at;
    await a.take(isSnap); await b.take(isSnap);
    const before = structuredClone(a.lastSnap), mark = a.received.length;
    pump = setInterval(() => { a.move(0.1); b.move(0.1); }, 80);
    await new Promise((r) => setTimeout(r, 1_300));
    late = await new Peer(baseURL!).ready('中途观察者');
    late.send({ t: 'join', code });
    const remaining = await late.take(isIntro);
    expect(remaining.id).toBe(intro.id);
    expect(remaining.startedAt).toBe(intro.startedAt);
    expect(remaining.endsAt).toBe(intro.endsAt);
    expect(remaining.now - intro.now).toBeGreaterThan(1_000);
    expect(remaining.endsAt - remaining.now).toBeLessThan(7_000);
    await late.take(isSnap);
    expect(late.own.st).toBe(2);
    late.send({ t: 'intro-skip', id: intro.id });
    b.send({ t: 'intro-skip', id: intro.id + 100 });
    a.send({ t: 'intro-skip', id: intro.id });
    await new Promise((r) => setTimeout(r, 500));
    expect(a.received.some((r) => ended(intro.id)(r.m))).toBe(false);
    assertFrozen(a, before, mark);
    const end = await a.take(ended(intro.id), 0, 9_000);
    clearInterval(pump); pump = undefined;
    await b.take(ended(intro.id)); await late.take(ended(intro.id));
    const endIndex = a.received.findIndex((r) => r.m === end), endedAt = a.received[endIndex].at;
    const frozenFrames = assertFrozen(a, before, mark, endIndex, 120);
    expect(intro.endsAt - intro.startedAt).toBe(8_000);
    expect(endedAt - startedAt).toBeGreaterThanOrEqual(7_800); expect(endedAt - startedAt).toBeLessThan(9_500);
    expect(end.now).toBeGreaterThanOrEqual(intro.endsAt);
    expect(end.now - intro.endsAt).toBeLessThan(500);
    expect(end.skipped).toEqual([a.id]);
    expect(late.own.st).toBe(2);
    await assertReleased(a, b, before);
    await evidence('wire-deadline', { intro, remaining, end, frozenFrames, wallDurationMs: endedAt - startedAt });
  } finally { if (pump) clearInterval(pump); await Promise.all([a.close(), b.close(), late?.close()]); }
});

test('real WS: clear excludes intro time and keeps the three-second handoff before the next intro', async ({ baseURL }) => {
  const { a, b } = await pair(baseURL!);
  try {
    a.send({ t: 'start' });
    const intro = await a.take(isIntro);
    // Wait the actual eight seconds: including the intro in elapsed would turn ~1s into ~9s.
    const end = await a.take(ended(intro.id), 0, 10_000);
    const endedAt = a.received.find((r) => r.m === end)!.at;
    await a.take(isSnap); await b.take(isSnap);
    await exerciseInput(a, b, 1_250);
    a.send({ t: 'debug', op: 'key', door: -1 });
    a.send({ t: 'debug', op: 'tp', x: -61, z: 66 });
    b.send({ t: 'debug', op: 'tp', x: -61, z: 66 });
    const clear = await a.take((m): m is Clear => m.t === 'event' && m.kind === 'clear');
    expect(clear.level).toBe(0); expect(clear.secs).toBe(3);
    expect(clear.elapsed).toBeGreaterThanOrEqual(1); expect(clear.elapsed).toBeLessThan(3);
    expect(await b.take((m): m is Clear => m.t === 'event' && m.kind === 'clear')).toEqual(clear);
    const clearAt = a.received.find((r) => r.m === clear)!.at;
    expect(Math.abs(clear.elapsed - (clearAt - endedAt) / 1_000)).toBeLessThan(0.35);
    for (const peer of [a, b]) expect(await peer.take((m): m is Extract<ServerMsg, { t: 'fade' }> => m.t === 'fade'))
      .toEqual({ t: 'fade', secs: 3, restart: false });
    // Fade intentionally sends no snapshots; a stale frame would falsely "prove" a world freeze.
    await new Promise((done) => setTimeout(done, 1_100));
    expect(a.received.some((r) => r.m.t === 'room' && r.m.level === 1)).toBe(false);
    const next = await a.take((m): m is Room => m.t === 'room' && m.level === 1);
    const arrivedAt = a.received.find((r) => r.m === next)!.at;
    expect(arrivedAt - clearAt).toBeGreaterThanOrEqual(2_850);
    expect(arrivedAt - clearAt).toBeLessThan(3_700);
    const nextIntro = await a.take((m): m is IntroEvent => isIntro(m) && m.level === 1);
    expect(nextIntro.id).toBeGreaterThan(intro.id);
    expect(nextIntro.endsAt - nextIntro.startedAt).toBe(8_000);
    expect(await b.take((m): m is IntroEvent => isIntro(m) && m.level === 1)).toEqual(nextIntro);
    await evidence('wire-clear', { intro, end, clear, activeWallSeconds: (clearAt - endedAt) / 1_000, handoffMs: arrivedAt - clearAt, nextIntro });
  } finally { await Promise.all([a.close(), b.close()]); }
});

function observe(page: Page, trace: Received[], errors: string[]) {
  const sent: ClientMsg[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('websocket', (ws) => {
    ws.on('framereceived', ({ payload }) => trace.push({ m: JSON.parse(String(payload)) as ServerMsg, at: Date.now() }));
    ws.on('framesent', ({ payload }) => sent.push(JSON.parse(String(payload)) as ClientMsg));
    ws.on('socketerror', (error) => errors.push(`WebSocket: ${error}`));
  });
  return sent;
}

async function enter(page: Page, name: string, code?: string) {
  await page.goto('/?steady');
  await page.fill('#name', name);
  if (code) { await page.fill('#code', code); await page.click('#join'); }
  else await page.click('#create');
  await expect(page.locator('#waiting')).toBeVisible();
}

const state = (page: Page) => page.evaluate(() => {
  const g = window.__escape.game()!;
  const presentation = g.intro as unknown as { figure?: { root: { visible: boolean } }; cue: boolean };
  return { active: g.intro.active, presenting: g.intro.presenting, skipped: g.intro.skipped,
    remaining: g.intro.remaining, id: g.intro.id, reduced: g.intro.reducedMotion,
    camera: g.camera.position.toArray(), quaternion: g.camera.quaternion.toArray(), level: g.level.index, ready: g.presentationReady,
    player: [g.pos.x, g.body.y, g.pos.z], light: g.light, enabled: g.input.enabled,
    figureVisible: presentation.figure?.root.visible ?? false, cue: presentation.cue };
});

test('desktop: two real contexts share titles and deadline, clear, then skip independently', async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const contexts: BrowserContext[] = [];
  let video: Video | null = null;
  const errors: string[] = [], ta: Received[] = [], tb: Received[] = [];
  try {
    const ca = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 },
      recordVideo: { dir: 'test-results/cinematic-video', size: { width: 960, height: 540 } } }); contexts.push(ca);
    const cb = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 } }); contexts.push(cb);
    const a = await ca.newPage(), b = await cb.newPage();
    video = a.video();
    const sentA = observe(a, ta, errors), sentB = observe(b, tb, errors);
    await enter(a, '镜头甲'); await enter(b, '镜头乙', await a.locator('#wait-code').innerText());
    await expect(a.locator('#wait-members li')).toHaveCount(2);
    await a.click('#start');
    for (const p of [a, b]) {
      await expect(p.locator('#intro-overlay')).toBeVisible();
      await expect(p.locator('#intro-title')).toContainText('一楼');
      await expect(p.locator('#intro-title')).toContainText('第 1 关');
      await expect(p.locator('#intro-objective')).toContainText('钥匙');
      await expect(p.locator('#intro-skip')).toBeVisible();
      await expect.poll(async () => (await state(p)).ready, { intervals: [50] }).toBe(true);
    }
    await a.screenshot({ path: 'test-results/cinematic-desktop-title.png' });
    await b.screenshot({ path: 'test-results/cinematic-desktop-title-peer.png' });
    const ia = ta.find((r) => isIntro(r.m))!.m as IntroEvent;
    const ib = tb.find((r) => isIntro(r.m))!.m as IntroEvent;
    expect(ib.id).toBe(ia.id); expect(ib.startedAt).toBe(ia.startedAt); expect(ib.endsAt).toBe(ia.endsAt);
    expect(ia.endsAt - ia.startedAt).toBe(8_000); expect(ia.route.length).toBeGreaterThan(1); expect(ia.silhouette).toBeDefined();
    const first = await state(a);
    await a.keyboard.down('KeyW'); await a.keyboard.press('KeyF'); await a.waitForTimeout(300); await a.keyboard.up('KeyW');
    const during = await state(a);
    expect(during.player).toEqual(first.player); expect(during.light).toBe(first.light); expect(during.enabled).toBe(false);
    // The silhouette exists only at 5.0–6.55s; waiting merely for remaining <2 can capture the following black frame.
    await expect.poll(async () => (await state(b)).figureVisible, { intervals: [30], timeout: 8_000 }).toBe(true);
    const reveal = await state(b);
    expect(reveal.active).toBe(true); expect(reveal.cue).toBe(true);
    expect(distance(reveal.camera as Vec3, first.camera as Vec3)).toBeGreaterThan(0.25);
    await b.screenshot({ path: 'test-results/cinematic-desktop-silhouette.png' });
    for (const p of [a, b]) await expect.poll(async () => (await state(p)).active).toBe(false);
    const endA = ta.find((r) => ended(ia.id)(r.m))!, endB = tb.find((r) => ended(ia.id)(r.m))!;
    expect(Math.abs(endA.at - endB.at)).toBeLessThan(200);
    expect((endA.m as IntroEvent).now).toBeGreaterThanOrEqual(ia.endsAt);
    for (const p of [a, b]) await expect(p.locator('#objective')).toBeVisible();
    await a.waitForTimeout(1_100);
    for (const p of [a, b]) {
      await p.evaluate(() => { window.__escape.debug('key', -1); window.__escape.debug('tp', -61, 66); });
    }
    await expect(a.locator('#fade-overlay')).toBeVisible();
    await expect(a.locator('#fade-overlay')).toContainText('第 1 关 通过');
    await expect(a.locator('#fade-overlay')).toContainText(/用时 \d+:\d{2}/);
    await a.waitForTimeout(220);
    await a.screenshot({ path: 'test-results/cinematic-desktop-clear.png' });
    const clear = ta.map((r) => r.m).find((m): m is Clear => m.t === 'event' && m.kind === 'clear')!;
    expect(clear.secs).toBe(3); expect(clear.elapsed).toBeGreaterThanOrEqual(1); expect(clear.elapsed).toBeLessThan(5);
    for (const p of [a, b]) await expect.poll(async () => { const s = await state(p); return s.level === 1 && s.active; }).toBe(true);
    await a.keyboard.press('Space');
    await expect.poll(async () => (await state(a)).skipped).toBe(true);
    expect((await state(b)).skipped).toBe(false);
    expect((await state(b)).active).toBe(true);
    await expect(a.locator('#intro-wait')).toBeVisible();
    const waiting = await state(a), other = await state(b);
    await a.keyboard.down('KeyW'); await a.keyboard.press('KeyF'); await a.waitForTimeout(350); await a.keyboard.up('KeyW');
    expect((await state(a)).player).toEqual(waiting.player); expect((await state(b)).player).toEqual(other.player);
    expect((await state(a)).active).toBe(true); expect((await state(a)).enabled).toBe(false);
    expect((await state(b)).active).toBe(true); await expect(b.locator('#intro-skip')).toBeVisible();
    await a.screenshot({ path: 'test-results/cinematic-desktop-skip-wait.png' });
    const nextIntro = ta.map((r) => r.m).find((m): m is IntroEvent => isIntro(m) && m.level === 1 && !m.ended)!;
    expect(nextIntro.route.length).toBeGreaterThan(1);
    expect(nextIntro.silhouette).toBeDefined();
    expect(ta.some((r) => ended(nextIntro.id)(r.m))).toBe(false);
    await expect.poll(async () => (await state(b)).figureVisible, { intervals: [30], timeout: 8_000 }).toBe(true);
    const l2Reveal = await state(b);
    expect(l2Reveal.active).toBe(true); expect(l2Reveal.cue).toBe(true);
    await b.screenshot({ path: 'test-results/cinematic-desktop-l2-silhouette.png' });
    await b.locator('#intro-skip').click();
    for (const p of [a, b]) {
      await expect.poll(async () => (await state(p)).active).toBe(false);
      await expect(p.locator('#intro-overlay')).toBeHidden();
      await expect(p.locator('#objective')).toBeVisible();
    }
    expect(sentA.filter((m) => m.t === 'intro-skip')).toEqual([{ t: 'intro-skip', id: nextIntro.id }]);
    expect(sentB.filter((m) => m.t === 'intro-skip')).toEqual([{ t: 'intro-skip', id: nextIntro.id }]);
    const skipEndA = ta.find((r) => ended(nextIntro.id)(r.m))!, skipEndB = tb.find((r) => ended(nextIntro.id)(r.m))!;
    expect(skipEndA.m).toEqual(skipEndB.m); expect((skipEndA.m as IntroEvent).now).toBeLessThan(nextIntro.endsAt);
    expect(Math.abs(skipEndA.at - skipEndB.at)).toBeLessThan(200);
    expect(errors).toEqual([]);
    const lifecycle = (events: Received[]) => events.filter((r) => isIntro(r.m) || r.m.t === 'fade' || (r.m.t === 'event' && r.m.kind === 'clear'));
    await evidence('desktop-sync', { a: lifecycle(ta), b: lifecycle(tb), first, reveal, l2Reveal, clear,
      sentA: sentA.filter((m) => m.t === 'intro-skip'), sentB: sentB.filter((m) => m.t === 'intro-skip'), errors });
  } finally {
    for (const c of contexts) await c.close();
    if (video) {
      const path = resolve('test-results/cinematic-intro-clear.webm');
      await video.saveAs(path);
      await test.info().attach('intro-clear-video', { path, contentType: 'video/webm' });
    }
  }
});

test('mobile: reduced motion keeps a static view with readable title, objective and a touch skip', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width: 844, height: 390 }, deviceScaleFactor: 1,
    hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
  const errors: string[] = [], trace: Received[] = [];
  try {
    const page = await context.newPage(), sent = observe(page, trace, errors);
    await enter(page, '手机静态'); await page.click('#start');
    await expect(page.locator('#intro-overlay')).toBeVisible();
    await expect(page.locator('#intro-title')).toContainText('一楼');
    await expect(page.locator('#intro-title')).toContainText('第 1 关');
    await expect(page.locator('#intro-objective')).toContainText('钥匙');
    await expect(page.locator('#intro-skip')).toBeVisible();
    await expect.poll(async () => (await state(page)).ready).toBe(true);
    await page.waitForTimeout(120);
    const first = await state(page);
    expect(first.reduced).toBe(true);
    await page.waitForTimeout(550);
    const next = await state(page);
    expect(next.active).toBe(true); expect(next.camera).toEqual(first.camera); expect(next.quaternion).toEqual(first.quaternion);
    expect(next.figureVisible).toBe(false); expect(next.cue).toBe(false); expect(next.enabled).toBe(false);
    const boxes = await page.locator('#intro-title, #intro-objective, #intro-skip').evaluateAll((elements) => elements.map((el) => {
      const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
    }));
    expect(boxes).toHaveLength(3);
    for (const box of boxes) { expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(844); expect(box.y + box.height).toBeLessThanOrEqual(390); }
    expect(boxes[2].width).toBeGreaterThanOrEqual(44); expect(boxes[2].height).toBeGreaterThanOrEqual(44);
    const overlaps = (a: typeof boxes[number], b: typeof boxes[number]) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    expect(overlaps(boxes[0], boxes[2])).toBe(false); expect(overlaps(boxes[1], boxes[2])).toBe(false);
    await page.screenshot({ path: 'test-results/cinematic-mobile-reduced-motion.png' });
    await page.locator('#intro-skip').tap();
    await expect.poll(async () => (await state(page)).active).toBe(false);
    await expect(page.locator('#intro-overlay')).toBeHidden();
    await expect(page.locator('#objective')).toBeVisible();
    const intro = trace.map((r) => r.m).find(isIntro)!;
    expect(sent.filter((m) => m.t === 'intro-skip')).toEqual([{ t: 'intro-skip', id: intro.id }]);
    const end = trace.map((r) => r.m).find(ended(intro.id))!;
    expect(end).toBeDefined(); expect(end.now).toBeLessThan(intro.endsAt);
    expect(errors).toEqual([]);
    await evidence('mobile-reduced-motion', { intro, end, first, next, boxes, errors });
  } finally { await context.close(); }
});

test('mobile: real held touches stay quarantined across deadline and all-skip while fresh controls recover', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ baseURL, viewport: { width: 844, height: 390 }, deviceScaleFactor: 1,
    hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
  const errors: string[] = [], trace: Received[] = [];
  let peer: Peer | undefined;
  try {
    const page = await context.newPage();
    const consoleTrace: { text: string; location: { url: string; lineNumber: number; columnNumber: number } }[] = [];
    page.on('console', (message) => { if (message.type() === 'error') consoleTrace.push({ text: message.text(), location: message.location() }); });
    observe(page, trace, errors);
    await enter(page, '跨场手势');
    peer = await new Peer(baseURL!).ready('手势队友');
    peer.send({ t: 'join', code: await page.locator('#wait-code').innerText() });
    await expect(page.locator('#wait-members li')).toHaveCount(2);
    await page.click('#start');
    await expect(page.locator('#intro-overlay')).toBeVisible();
    await expect.poll(async () => (await state(page)).ready).toBe(true);
    const opening = await peer.take(isIntro);
    await page.locator('#intro-skip').tap();
    peer.send({ t: 'intro-skip', id: opening.id });
    await expect.poll(async () => (await state(page)).active).toBe(false);

    // CDP delivers trusted, persistent browser touch identifiers to the real control targets.
    const cdp = await context.newCDPSession(page);
    const points = new Map<number, { id: number; x: number; y: number }>();
    const dispatch = (type: 'touchStart' | 'touchMove' | 'touchEnd') => cdp.send('Input.dispatchTouchEvent', {
      type, touchPoints: [...points.values()],
    });
    const start = async (id: number, x: number, y: number) => { points.set(id, { id, x, y }); await dispatch('touchStart'); };
    const move = async (...updates: { id: number; x: number; y: number }[]) => {
      for (const point of updates) { expect(points.has(point.id)).toBe(true); points.set(point.id, point); }
      await dispatch('touchMove');
    };
    const end = async (...ids: number[]) => {
      const before = await page.evaluate(() => (window as unknown as { cinematicTouchTrace: unknown[] }).cinematicTouchTrace.length);
      const released = ids.map((id) => { expect(points.has(id)).toBe(true); return points.get(id)!; });
      for (const id of ids) points.delete(id);
      // Chromium accepts explicit released points for partial touchEnd despite CDP's empty-list
      // prose. Assert the resulting trusted native IDs, including every finger kept down.
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: points.size ? released : [] });
      const native = await page.evaluate((from) => (window as unknown as {
        cinematicTouchTrace: { type: string; ids: number[]; active: number[] }[];
      }).cinematicTouchTrace.slice(from).filter((event) => event.type === 'touchend'), before);
      expect([...new Set(native.flatMap((event) => event.ids))].sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));
      expect(native.at(-1)!.active.slice().sort((a, b) => a - b)).toEqual([...points.keys()].sort((a, b) => a - b));
    };
    const controls = () => page.evaluate(() => {
      const input = window.__escape.game()!.input;
      return { keys: [...input.keys].sort(), yaw: input.yaw, pitch: input.pitch,
        stick: document.getElementById('touch-base')!.classList.contains('on'),
        run: [...document.querySelectorAll('#touch-btns .touch-btn')].find((el) => el.textContent === '跑')!.classList.contains('on') };
    });
    const runBox = await page.locator('#touch-btns .touch-btn').filter({ hasText: /^跑$/ }).boundingBox();
    expect(runBox).not.toBeNull();
    const run = { x: runBox!.x + runBox!.width / 2, y: runBox!.y + runBox!.height / 2 };
    await page.evaluate(() => {
      const recorded: { type: string; trusted: boolean; prevented: boolean; cancelable: boolean; ids: number[]; target: string;
        changed: { id: number; x: number; y: number; target: string }[]; active: number[]; at: number }[] = [];
      (window as unknown as { cinematicTouchTrace: typeof recorded }).cinematicTouchTrace = recorded;
      const input = window.__escape.game()!.input, look = input.look;
      const calls: { dx: number; dy: number; sensitivity: number | undefined; before: number; after: number; stack: string | undefined; at: number }[] = [];
      (window as unknown as { cinematicLookTrace: typeof calls }).cinematicLookTrace = calls;
      input.look = function (dx, dy, sensitivity) {
        const before = this.yaw;
        look.call(this, dx, dy, sensitivity);
        calls.push({ dx, dy, sensitivity, before, after: this.yaw, stack: new Error().stack, at: performance.now() });
      };
      for (const type of ['touchstart', 'touchmove', 'touchend']) addEventListener(type, (event) => {
        const e = event as TouchEvent;
        recorded.push({ type: e.type, trusted: e.isTrusted, prevented: e.defaultPrevented, cancelable: e.cancelable,
          ids: Array.from(e.changedTouches, (t) => t.identifier),
          target: e.target instanceof Element ? e.target.id || e.target.className : String(e.target),
          changed: Array.from(e.changedTouches, (t) => ({ id: t.identifier, x: t.clientX, y: t.clientY,
            target: t.target instanceof Element ? t.target.id || t.target.className : String(t.target) })),
          active: Array.from(e.touches, (t) => t.identifier), at: performance.now() });
      }, { capture: true, passive: true });
    });
    const touchDiagnostics = () => page.evaluate(() => ({
      touch: (window as unknown as { cinematicTouchTrace: unknown[] }).cinematicTouchTrace,
      look: (window as unknown as { cinematicLookTrace: unknown[] }).cinematicLookTrace,
    }));

    await start(1, 110, 260); await start(2, 530, 150); await start(3, run.x, run.y);
    await move({ id: 1, x: 155, y: 260 }, { id: 2, x: 550, y: 150 });
    expect((await controls()).keys).toEqual(['KeyD', 'ShiftLeft']);
    await page.evaluate(() => { window.__escape.debug('key', -1); window.__escape.debug('tp', -61, 66); });
    peer.send({ t: 'debug', op: 'tp', x: -61, z: 66 });
    await expect.poll(async () => { const s = await state(page); return s.level === 1 && s.active; }).toBe(true);
    const deadlineIntro = await peer.take((m): m is IntroEvent => isIntro(m) && m.level === 1 && !m.ended);
    // These releases happen while the intro consumes their events; controls still must reset.
    await end(1, 3);
    expect((await controls()).stick).toBe(false); expect((await controls()).run).toBe(false);
    await expect.poll(async () => (await state(page)).active, { timeout: 10_000 }).toBe(false);
    const deadlineEnd = await peer.take(ended(deadlineIntro.id));
    expect(deadlineEnd.now).toBeGreaterThanOrEqual(deadlineIntro.endsAt);
    const deadlineBefore = await controls();
    await move({ id: 2, x: 590, y: 170 });
    expect(await controls()).toEqual(deadlineBefore);

    // Old and new identifiers can appear in one changedTouches list. The fresh look must work.
    await start(4, 110, 260); await start(5, 530, 150); await start(6, run.x, run.y);
    await move({ id: 2, x: 630, y: 190 }, { id: 4, x: 155, y: 260 }, { id: 5, x: 550, y: 150 });
    const deadlineFresh = await controls();
    await evidence('mobile-touch-diagnostic', { deadlineBefore, deadlineFresh, ...await touchDiagnostics() });
    expect(deadlineFresh.keys).toEqual(['KeyD', 'ShiftLeft']);
    expect(deadlineFresh.yaw).toBeCloseTo(deadlineBefore.yaw - (20 - TOUCH_DRAG_PX) * LOOK_SENS, 6);
    expect(deadlineFresh.pitch).toBeCloseTo(deadlineBefore.pitch, 6);
    await end(2, 5);
    await start(7, 530, 150); await move({ id: 7, x: 550, y: 150 });
    expect((await controls()).yaw).toBeCloseTo(deadlineFresh.yaw - (20 - TOUCH_DRAG_PX) * LOOK_SENS, 6);
    await end(4, 6, 7);
    expect((await controls()).keys).toEqual([]); expect((await controls()).stick).toBe(false); expect((await controls()).run).toBe(false);

    // A same-level restart gives a second real authoritative intro and a fast all-skip exit.
    await start(8, 110, 260); await start(9, 530, 150); await start(10, run.x, run.y);
    await move({ id: 8, x: 155, y: 260 });
    await page.evaluate(() => window.__escape.debug('down', 1));
    peer.send({ t: 'debug', op: 'down', s: 1 });
    await expect.poll(async () => { const s = await state(page); return s.id > deadlineIntro.id && s.active; }).toBe(true);
    const skipIntro = await peer.take((m): m is IntroEvent => isIntro(m) && m.id > deadlineIntro.id && !m.ended);
    const skipBox = await page.locator('#intro-skip').boundingBox();
    expect(skipBox).not.toBeNull();
    await start(11, skipBox!.x + skipBox!.width / 2, skipBox!.y + skipBox!.height / 2); await end(11);
    await expect.poll(async () => (await state(page)).skipped).toBe(true);
    peer.send({ t: 'intro-skip', id: skipIntro.id });
    await expect.poll(async () => (await state(page)).active).toBe(false);
    const skipEnd = await peer.take(ended(skipIntro.id));
    expect(skipEnd.now).toBeLessThan(skipIntro.endsAt);
    const skipBefore = await controls();
    expect(skipBefore.keys).toEqual([]); expect(skipBefore.stick).toBe(false); expect(skipBefore.run).toBe(false);
    await move({ id: 8, x: 180, y: 250 }, { id: 9, x: 590, y: 170 }, { id: 10, x: run.x - 10, y: run.y });
    expect(await controls()).toEqual(skipBefore);
    await start(12, 110, 260); await start(13, 530, 150); await start(14, run.x, run.y);
    await move({ id: 8, x: 190, y: 240 }, { id: 9, x: 630, y: 190 }, { id: 12, x: 155, y: 260 }, { id: 13, x: 550, y: 150 });
    const skipFresh = await controls();
    expect(skipFresh.keys).toEqual(['KeyD', 'ShiftLeft']);
    expect(skipFresh.yaw).toBeCloseTo(skipBefore.yaw - (20 - TOUCH_DRAG_PX) * LOOK_SENS, 6);
    expect(skipFresh.pitch).toBeCloseTo(skipBefore.pitch, 6);
    await end(8, 9, 10, 12, 13, 14);
    expect((await controls()).keys).toEqual([]); expect((await controls()).stick).toBe(false); expect((await controls()).run).toBe(false);
    const touchTrace = await page.evaluate(() => (window as unknown as { cinematicTouchTrace: unknown[] }).cinematicTouchTrace);
    expect(touchTrace.length).toBeGreaterThan(20);
    expect(touchTrace.every((event) => (event as { trusted: boolean }).trusted)).toBe(true);
    await evidence('mobile-touch-quarantine', { deadlineIntro, deadlineEnd, deadlineBefore, deadlineFresh,
      skipIntro, skipEnd, skipBefore, skipFresh, touchTrace, lookTrace: (await touchDiagnostics()).look, errors, consoleTrace });
    expect(errors).toEqual([]);
  } finally { await peer?.close(); await context.close(); }
});
