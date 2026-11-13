import { expect, test, type Page } from '@playwright/test';
import { WebSocket } from 'ws';
import { L5 } from '../../shared/levels/l5.ts';
import type { GymSnap } from '../../shared/gym.ts';
import type { ClientMsg, ServerMsg } from '../../shared/protocol.ts';
import { shot } from '../e2e/draw.ts';

async function enter(page: Page) {
  await page.goto('/?nodraw&steady'); await page.fill('#name', '体育馆试玩');
  await page.click('#create'); await page.click('#start');
  await page.waitForFunction(() => (window.__escape.game()?.snaps ?? 0) > 1);
  await page.evaluate(() => window.__escape.debug('level5'));
  await page.waitForFunction(() => window.__escape.game()?.level.index === 4 && !!window.__escape.game()?.gym?.state);
  await page.evaluate(() => { window.__escape.debug('safe', 600); window.__escape.game()!.light = true; });
}
async function station(page: Page, id: number, walk = false) {
  const s = L5.gym!.switches[id], x = s.x + Math.sin(s.yaw) * 1.1, z = s.z + Math.cos(s.yaw) * 1.1;
  if (walk) {
    await page.evaluate(([x, z]) => {
      const g = window.__escape.game()!, nav = (g as any).navGraph;
      const ids = nav.astar(nav.nearest(g.pos.x, g.body.y, g.pos.z), nav.nearest(x, 0, z));
      if (!ids) throw new Error('station unreachable');
      g.autopilot([[g.pos.x, g.pos.z], ...ids.map((id: number) => [nav.nodes[id].x, nav.nodes[id].z]), [x, z]]);
      g.input.press('ShiftLeft');
    }, [x, z]);
    await page.waitForFunction(() => window.__escape.game()!.autopilotDone, null, { timeout: 15000 });
    await page.evaluate(() => window.__escape.game()!.input.release('ShiftLeft'));
  }
  if (!walk) await page.evaluate(([x, z]) => window.__escape.debug('tp', x, z, 0), [x, z]);
  await page.evaluate((yaw) => {
    const g = window.__escape.game()!; g.input.yaw = yaw; g.input.pitch = -0.11;
  }, s.yaw);
  await expect.poll(() => page.evaluate((id) => window.__escape.game()!.target()?.kind === 'gym-switch' && window.__escape.game()!.target()?.id === id, id), { timeout: 5000 }).toBe(true);
  await page.waitForFunction(() => !window.__escape.game()!.gym!.tripped(window.__escape.game()!.myId));
  await page.keyboard.press('e');
  await expect.poll(() => page.evaluate((id) => { const s = window.__escape.game()!.gym!.state!; return s.until[id] > s.now || s.complete; }, id), { timeout: 3000 }).toBe(true);
}

test('L5 real client: readable scene, reachable equipment, E switches, authoritative exit', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await enter(page);
  await expect(page.locator('#room-code')).toContainText('第 5 关');
  await page.waitForFunction(() => (window.__escape.game()!.mobs.byId.size === 3));
  await page.evaluate(() => { const g = window.__escape.game()!; g.view = { x: -99, y: 1.7, z: 64, yaw: Math.PI, pitch: 0.12 }; });
  await expect(page.locator('#banner')).toBeHidden({ timeout: 6000 });
  await shot(page, 'test-results/l5-gym-stands.png');
  await expect(page.locator('#objective')).toContainText('单人各锁定20秒');
  await expect(page.locator('#objective')).toContainText('器材室');
  // Walk the real predicted client from its spawn through the narrow equipment door (no teleport).
  await page.evaluate(() => {
    const g = window.__escape.game()!, nav = (g as any).navGraph;
    g.view = null; const from = nav.nearest(g.pos.x, g.body.y, g.pos.z), to = nav.nearest(-111.76, 0, 49.8);
    const ids = nav.astar(from, to); if (!ids) throw new Error('equipment unreachable');
    g.autopilot([[g.pos.x, g.pos.z], ...ids.map((id: number) => [nav.nodes[id].x, nav.nodes[id].z])]);
    g.input.press('ShiftLeft');
  });
  await page.waitForFunction(() => window.__escape.game()!.autopilotDone, null, { timeout: 30000 });
  await page.evaluate(() => window.__escape.game()!.input.release('ShiftLeft'));
  expect(await page.evaluate(() => Math.hypot(window.__escape.game()!.pos.x + 111.76, window.__escape.game()!.pos.z - 49.8))).toBeLessThan(1);
  // Screenshot before starting the timed attempt so capture speed cannot alter the puzzle's outcome.
  await page.evaluate(() => { const g = window.__escape.game()!; g.view = { x: -111.76, y: 1.6, z: 51.3, yaw: 0, pitch: -0.08 }; });
  await shot(page, 'test-results/l5-equipment-switch.png');
  await page.evaluate(() => {
    const g = window.__escape.game()!, b = g.gym!.state!.balls.find((b) => b.p[2] > 53);
    if (!b) throw new Error('no basketball in court');
    g.view = { x: b.p[0] + 1, y: 1.3, z: b.p[2] + 2, yaw: Math.atan2(1, 2), pitch: -0.43 };
  });
  await shot(page, 'test-results/l5-basketball.png');
  await page.evaluate(() => { window.__escape.game()!.view = null; });
  // Walk up the actual bleachers and let the server validate every predicted step.
  await page.evaluate(() => {
    const g = window.__escape.game()!, nav = (g as any).navGraph;
    const route = nav.astar(nav.nearest(g.pos.x, g.body.y, g.pos.z), nav.nearest(-106, 0.72, 73.65));
    if (!route) throw new Error('bleachers unreachable');
    g.autopilot([[g.pos.x, g.pos.z], ...route.map((id: number) => [nav.nodes[id].x, nav.nodes[id].z])]);
    g.input.press('ShiftLeft');
  });
  await page.waitForFunction(() => window.__escape.game()!.autopilotDone, null, { timeout: 20000 });
  await page.evaluate(() => window.__escape.game()!.input.release('ShiftLeft'));
  await expect.poll(() => page.evaluate(() => window.__escape.game()!.body.y)).toBeCloseTo(0.72);
  // Only the first station is placed by debug; walk the complete timed route 1→2→3→4.
  for (let i = 0; i < 4; i++) await station(page, i, i > 0);
  await expect(page.locator('#objective')).toContainText('东门门禁解除');
  await expect(page.locator('#banner')).toBeHidden({ timeout: 6000 });
  await page.evaluate(() => {
    const g = window.__escape.game()!;
    g.view = { x: -98, y: 1.6, z: 56.3, yaw: 0, pitch: 0.1 };
  });
  await shot(page, 'test-results/l5-switches-unlocked.png');
  await page.evaluate(() => { window.__escape.game()!.view = null; });
  await page.evaluate(() => window.__escape.debug('tp', -84, 60, 0));
  await expect(page.locator('#fade-overlay')).toBeVisible({ timeout: 3000 });
  await expect(page.locator('#fade-overlay.complete')).toContainText('体育馆');
  await expect(page.locator('#fade-overlay.complete')).toContainText('5 个关卡已完成');
  expect(errors).toEqual([]);
});

test('L5 real client shows switch countdown and basketball trip with frozen movement', async ({ page }) => {
  await enter(page);
  await station(page, 3);
  await expect(page.locator('#objective')).toContainText('4记分台：亮');
  await page.evaluate(() => {
    window.__escape.game()!.view = { x: -98, y: 1.6, z: 56.3, yaw: 0, pitch: 0.1 };
  });
  await expect(page.locator('#banner')).toBeHidden({ timeout: 6000 });
  await shot(page, 'test-results/l5-switch-countdown.png');
  await page.evaluate(() => { window.__escape.game()!.view = null; });
  await page.waitForFunction(() => window.__escape.game()!.gym!.state!.balls.some((b) => b.p[2] > 58), null, { timeout: 12000 });
  await page.evaluate(() => {
    const ball = window.__escape.game()!.gym!.state!.balls.find((b) => b.p[2] > 58)!;
    window.__escape.debug('tp', ball.p[0] + ball.v[0] * 0.1, ball.p[2] + ball.v[1] * 0.1, 0);
  });
  await page.waitForFunction(() => { const g = window.__escape.game()!; return g.gym!.tripped(g.myId); }, null, { timeout: 3000 });
  await expect(page.locator('#gym-caption')).toContainText('被篮球绊倒');
  const frozen = await page.evaluate(() => { const g = window.__escape.game()!; return { ...g.pos, now: g.gym!.state!.now }; });
  await page.keyboard.down('w');
  await page.waitForFunction((at) => window.__escape.game()!.gym!.state!.now >= at + 0.4, frozen.now);
  await page.keyboard.up('w');
  const during = await page.evaluate(() => { const g = window.__escape.game()!; return { ...g.pos, eye: g.camera.position.y - g.body.y }; });
  expect(Math.hypot(during.x - frozen.x, during.z - frozen.z)).toBeLessThan(0.03);
  expect(during.eye).toBeLessThan(1.1);
  await shot(page, 'test-results/l5-basketball-trip.png');
  await page.waitForFunction(() => { const g = window.__escape.game()!; return !g.gym!.tripped(g.myId); }, null, { timeout: 2500 });
  const before = await page.evaluate(() => { const g = window.__escape.game()!; return { ...g.pos, now: g.gym!.state!.now }; });
  await page.keyboard.down('w');
  await page.waitForFunction((at) => window.__escape.game()!.gym!.state!.now >= at + 0.3, before.now);
  await page.keyboard.up('w');
  expect(await page.evaluate((from) => { const p = window.__escape.game()!.pos; return Math.hypot(p.x - from.x, p.z - from.z); }, before)).toBeGreaterThan(0.3);
});

class Bot {
  ws: WebSocket;
  messages: ServerMsg[] = [];
  constructor(url: string) { this.ws = new WebSocket(url); this.ws.on('message', (d) => this.messages.push(JSON.parse(d.toString()))); }
  send(m: ClientMsg) { this.ws.send(JSON.stringify(m)); }
  async waitFor<T extends ServerMsg>(predicate: (m: ServerMsg) => m is T, timeout = 5000): Promise<T> {
    let result: T | undefined;
    await expect.poll(() => { result = this.messages.find(predicate); return !!result; }, { timeout, intervals: [20, 50] }).toBe(true);
    return result!;
  }
  get gym(): GymSnap | undefined { return this.messages.filter((m): m is GymSnap => m.t === 'gym').at(-1); }
}

test('L5 real client receives remote unlock across the hall and plays the basketball audio', async ({ page, baseURL }) => {
  await page.addInitScript(() => {
    const events: { kind: string; state: string }[] = [];
    (window as any).__l5Audio = events;
    const create = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () {
      const source = create.call(this), context = this, start = source.start;
      source.start = function (when?: number, offset?: number, duration?: number) {
        events.push({ kind: 'buffer', state: context.state });
        return start.call(this, when ?? 0, offset ?? 0, duration);
      };
      return source;
    };
  });
  const partner = new Bot(baseURL!.replace('http', 'ws') + '/ws');
  try {
    await partner.waitFor((m): m is Extract<ServerMsg, { t: 'welcome' }> => m.t === 'welcome');
    await page.goto('/?nodraw&steady'); await page.fill('#name', '远端通知'); await page.click('#create');
    await expect(page.locator('#waiting')).toBeVisible();
    const code = await page.evaluate(() => window.__escape.code);
    partner.send({ t: 'join', code });
    await expect(page.locator('#wait-members li')).toHaveCount(2);
    await page.click('#start');
    await page.waitForFunction(() => (window.__escape.game()?.snaps ?? 0) > 1);
    await page.evaluate(() => { window.__escape.debug('level5'); window.__escape.debug('safe', 600); });
    await page.waitForFunction(() => window.__escape.game()?.level.index === 4 && window.__escape.game()?.gym?.state?.solo === false);
    await page.evaluate(() => window.__escape.debug('tp', -110, 56, 0));
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.sound.diagnostics.played['gym-roll'] ?? 0), { timeout: 10000 }).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as any).__l5Audio.some((e: any) => e.kind === 'buffer' && e.state === 'running'))).toBe(true);
    await expect(page.locator('#gym-caption')).toContainText('篮球正在滚动');
    // The existing mute preference must silence new basketball events as well as the older sound effects.
    await page.locator('#settings-open').click(); await page.check('#settings-muted'); await page.keyboard.press('Escape');
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.sound.diagnostics.muted)).toBe(true);
    const muted = await page.evaluate(() => {
      const g = window.__escape.game()!;
      return { played: { ...g.sound.diagnostics.played }, now: g.gym!.state!.now };
    });
    await page.waitForFunction((now) => window.__escape.game()!.gym!.state!.now >= now + 1.3, muted.now);
    expect(await page.evaluate(() => window.__escape.game()!.sound.diagnostics.played['gym-roll'] ?? 0)).toBe(muted.played['gym-roll'] ?? 0);
    expect(await page.evaluate(() => window.__escape.game()!.sound.diagnostics.activeSources)).toBe(0);
    await page.locator('#settings-open').click(); await page.uncheck('#settings-muted'); await page.keyboard.press('Escape');
    await page.evaluate(() => window.__escape.debug('tp', -84, 60, 0));
    // Finish at equipment switch 1, over 29m from the listener by the east door.
    for (const id of [1, 2, 3, 0]) {
      const s = L5.gym!.switches[id];
      partner.send({ t: 'debug', op: 'tp', x: s.x + 0.9, z: s.z, floor: 0 });
      partner.send({ t: 'act', kind: 'gym-switch', id });
      await expect.poll(() => (partner.gym?.until[id] ?? 0) > (partner.gym?.now ?? 0), { intervals: [20, 50] }).toBe(true);
    }
    await expect(page.locator('#objective')).toContainText('东门门禁解除');
    await expect(page.locator('#gym-caption')).toContainText('四灯全亮 · 东门门禁已解除');
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.sound.diagnostics.played['gym-open'] ?? 0)).toBeGreaterThan(0);
    expect(await page.evaluate(() => window.__escape.game()!.sound.diagnostics.state)).toBe('running');
    await expect(page.locator('#fade-overlay')).toBeHidden();
  } finally { partner.ws.close(); }
});

test('L5 phone: directly tapping an off-centre switch uses its screen ray without turning the camera', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await enter(page); await expect(page.locator('#touch')).toBeVisible();
    await expect(page.locator('#banner')).toBeHidden();
    const s = L5.gym!.switches[3];
    await page.evaluate((s) => window.__escape.debug('tp', s.x + Math.sin(s.yaw) * 1.1, s.z + Math.cos(s.yaw) * 1.1, 0), s);
    await expect.poll(() => page.evaluate((s) => Math.hypot(window.__escape.game()!.pos.x - s.x, window.__escape.game()!.pos.z - s.z), s)).toBeLessThan(1.2);
    await page.evaluate((s) => { const g = window.__escape.game()!; g.input.yaw = s.yaw + 0.6; g.input.pitch = -0.08; }, s);
    await page.waitForFunction(() => !window.__escape.game()!.gym!.tripped(window.__escape.game()!.myId));
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const project = () => page.evaluate((s) => {
      const g = window.__escape.game()!; g.camera.updateMatrixWorld();
      const point = g.camera.position.clone().set(s.x, s.y + 1.4, s.z).project(g.camera);
      return { x: (point.x + 1) * innerWidth / 2, y: (1 - point.y) * innerHeight / 2, yaw: g.input.yaw, pitch: g.input.pitch };
    }, s);
    const at = await project();
    expect(Math.abs(at.x - 422)).toBeGreaterThan(20); expect(at.x).toBeGreaterThan(60); expect(at.x).toBeLessThan(700);
    expect(at.y).toBeGreaterThan(70); expect(at.y).toBeLessThan(320);
    await page.evaluate(() => {
      const input = window.__escape.game()!.input, original = input.worldTouch!;
      (window as any).__l5WorldTaps = 0;
      input.worldTouch = (phase, x, y) => { if (phase === 'tap') (window as any).__l5WorldTaps++; original(phase, x, y); };
    });
    // A real drag that ends over the switch is still a drag, including when it returns to its starting pixel.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: at.x, y: at.y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    expect(await page.evaluate(() => (window as any).__l5WorldTaps)).toBe(0);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: at.x, y: at.y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: at.x + 40, y: at.y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: at.x, y: at.y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    expect(await page.evaluate(() => (window as any).__l5WorldTaps)).toBe(0);
    expect(await page.evaluate(() => window.__escape.game()!.gym!.state!.until[3])).toBe(0);
    // HUD buttons keep their own action and must not also dispatch an interaction into the world behind them.
    const light = await page.evaluate(() => window.__escape.game()!.light), flashlight = page.locator('.touch-btn', { hasText: '手电' });
    await flashlight.tap(); await expect.poll(() => page.evaluate(() => window.__escape.game()!.light)).toBe(!light);
    await flashlight.tap(); await expect.poll(() => page.evaluate(() => window.__escape.game()!.light)).toBe(light);
    expect(await page.evaluate(() => (window as any).__l5WorldTaps)).toBe(0);
    expect(await page.evaluate(() => window.__escape.game()!.gym!.state!.until[3])).toBe(0);
    const tapAt = await project();
    await page.touchscreen.tap(tapAt.x, tapAt.y);
    await expect.poll(() => page.evaluate(() => { const g = window.__escape.game()!; return g.gym!.state!.until[3] > g.gym!.state!.now; })).toBe(true);
    const orientation = await page.evaluate(() => { const i = window.__escape.game()!.input; return { yaw: i.yaw, pitch: i.pitch }; });
    expect(orientation.yaw).toBeCloseTo(tapAt.yaw, 8); expect(orientation.pitch).toBeCloseTo(tapAt.pitch, 8);
    expect(await page.evaluate(() => (window as any).__l5WorldTaps)).toBe(1);
    await expect(page.locator('#objective')).toContainText('4记分台：亮');
    await shot(page, 'test-results/l5-phone-tap.png'); expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test('L5 real WS: team timing, expiry, late join, basketball stun and all-player exit', async ({ baseURL }) => {
  const url = baseURL!.replace('http', 'ws') + '/ws', a = new Bot(url), b = new Bot(url), late = new Bot(url);
  try {
    const welcome = await a.waitFor((m): m is Extract<ServerMsg, { t: 'welcome' }> => m.t === 'welcome');
    await b.waitFor((m): m is Extract<ServerMsg, { t: 'welcome' }> => m.t === 'welcome');
    await late.waitFor((m): m is Extract<ServerMsg, { t: 'welcome' }> => m.t === 'welcome');
    a.send({ t: 'create' });
    const room = await a.waitFor((m): m is Extract<ServerMsg, { t: 'room' }> => m.t === 'room');
    b.send({ t: 'join', code: room.code });
    await a.waitFor((m): m is Extract<ServerMsg, { t: 'room' }> => m.t === 'room' && m.players.length === 2);
    a.send({ t: 'start' }); a.send({ t: 'debug', op: 'level5' }); a.send({ t: 'debug', op: 'safe', s: 600 });
    await expect.poll(() => a.gym?.solo).toBe(false);
    const press = async (bot: Bot, id: number) => {
      const s = L5.gym!.switches[id]; bot.send({ t: 'debug', op: 'tp', x: s.x + 0.9, z: s.z, floor: 0 });
      bot.send({ t: 'act', kind: 'gym-switch', id });
      await expect.poll(() => (bot.gym?.until[id] ?? 0) > (bot.gym?.now ?? 0), { intervals: [20, 50] }).toBe(true);
    };
    // Remote actions cannot change the puzzle.
    a.send({ t: 'act', kind: 'gym-switch', id: 0 });
    await expect.poll(() => a.gym?.until[0]).toBe(0);
    await press(a, 0); const deadline = a.gym!.until[0];
    a.send({ t: 'act', kind: 'gym-switch', id: 0 });
    expect(a.gym!.until[0]).toBe(deadline);
    // Observe a real expiry, then retry; both connections share the exact same clock and state.
    await expect.poll(() => a.gym?.until[0], { timeout: 6500 }).toBe(0);
    await press(a, 0); await press(b, 1); await press(a, 2); await press(b, 3);
    await expect.poll(() => a.gym?.complete).toBe(true); await expect.poll(() => b.gym?.complete).toBe(true);
    expect(a.gym!.until).toEqual(b.gym!.until);
    late.send({ t: 'join', code: room.code });
    await expect.poll(() => late.gym?.complete).toBe(true); expect(late.gym!.until).toEqual(a.gym!.until);
    // Hit an actual moving server ball. Debug only moves us; the game decides collision and the 1.5s stun.
    await expect.poll(() => a.gym?.balls.length ?? 0, { timeout: 10000 }).toBeGreaterThan(0);
    const ball = a.gym!.balls[0];
    a.send({ t: 'debug', op: 'tp', x: ball.p[0] + ball.v[0] * 0.1, z: ball.p[2] + ball.v[1] * 0.1, floor: 0 });
    const trip = await a.waitFor((m): m is Extract<ServerMsg, { t: 'gym-sound' }> => m.t === 'gym-sound' && m.kind === 'trip' && m.player === welcome.id);
    expect(trip.player).toBe(welcome.id);
    await expect.poll(() => a.gym?.trips.some((p) => p.id === welcome.id)).toBe(true);
    const until = a.gym!.trips.find((p) => p.id === welcome.id)!.until;
    await expect.poll(() => b.gym?.trips.find((p) => p.id === welcome.id)?.until).toBe(until);
    await expect.poll(() => late.gym?.trips.find((p) => p.id === welcome.id)?.until).toBe(until);
    expect(await b.waitFor((m): m is Extract<ServerMsg, { t: 'gym-sound' }> => m.t === 'gym-sound' && m.kind === 'trip' && m.player === welcome.id)).toEqual(trip);
    const corrected = a.messages.filter((m): m is Extract<ServerMsg, { t: 'correct' }> => m.t === 'correct').at(-1)!;
    a.send({ t: 'input', seq: 1, p: [corrected.p[0] + 0.2, corrected.p[1], corrected.p[2]], yaw: 0, pitch: 0, f: 0 });
    await a.waitFor((m): m is Extract<ServerMsg, { t: 'correct' }> => m.t === 'correct' && m.ack === 1);
    await expect.poll(() => a.gym?.trips.some((p) => p.id === welcome.id), { timeout: 3000 }).toBe(false);
    a.send({ t: 'debug', op: 'tp', x: -84, z: 60, floor: 0 });
    // b remains away from the exit, so there must be no success yet.
    await expect.poll(() => a.gym?.now ?? 0).toBeGreaterThan(deadline + 2);
    expect(a.messages.some((m) => m.t === 'fade')).toBe(false);
    b.send({ t: 'debug', op: 'tp', x: -84, z: 60, floor: 0 });
    const fade = await a.waitFor((m): m is Extract<ServerMsg, { t: 'fade' }> => m.t === 'fade');
    expect(fade.restart).toBe(false);
    await b.waitFor((m): m is Extract<ServerMsg, { t: 'fade' }> => m.t === 'fade');
  } finally { for (const bot of [a, b, late]) bot.ws.close(); }
});
