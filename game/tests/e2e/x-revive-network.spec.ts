import { toggleSettings } from './settings-controls.ts';
import { writeFileSync } from 'node:fs';
import { expect, test as base, type CDPSession, type Page } from '@playwright/test';
import { ST_DOWN, ST_OK, type ClientMsg, type PlayerSnap, type ServerMsg } from '../../shared/protocol.ts';
import { browserArgs } from '../browser-args.mjs';

type Act = Extract<ClientMsg, { t: 'act' }>;
type TimedAct = Act & { at: number };
type Snapshot = { at: number; tick: number; players: PlayerSnap[] };
type Wire = { urls: string[]; acts: TimedAct[]; snaps: Snapshot[]; errors: string[];
  offlineErrors: string[]; offlineAt?: number; closed?: number };
type RafProbe = { interval: number; frames: number[] };
type Trio = { pages: Page[]; wires: Wire[]; ids: number[]; evidence: Record<string, unknown> };

// One Chromium process owns three independent storage/network contexts. No ws bots, mocked
// transport, or direct server revive calls: every hold below comes from keyboard or touch input.
function observe(page: Page): Wire {
  const wire: Wire = { urls: [], acts: [], snaps: [], errors: [], offlineErrors: [] };
  page.on('pageerror', (error) => wire.errors.push(error.message));
  page.on('websocket', (socket) => {
    wire.urls.push(socket.url());
    socket.on('framesent', ({ payload }) => {
      const message = JSON.parse(payload.toString()) as ClientMsg;
      if (message.t === 'act') wire.acts.push({ ...message, at: Date.now() });
    });
    socket.on('framereceived', ({ payload }) => {
      const message = JSON.parse(payload.toString()) as ServerMsg;
      if (message.t === 'snap') wire.snaps.push({ at: Date.now(), tick: message.tick, players: message.players });
    });
    socket.on('close', () => { wire.closed ??= Date.now(); });
    socket.on('socketerror', (error) => {
      // Retry failures are expected only after this test deliberately takes its context offline.
      (wire.offlineAt === undefined ? wire.errors : wire.offlineErrors).push(`WebSocket: ${error}`);
    });
  });
  return wire;
}

const state = (wire: Wire, id: number) => wire.snaps.at(-1)?.players.find((player) => player.id === id)?.st ??
  (wire.snaps.at(-1)?.players.some((player) => player.id === id) ? ST_OK : -1);
const revives = (wire: Wire, id: number, after = 0) => wire.acts.filter((act) => act.kind === 'revive' && act.id === id && act.at >= after);
const cancels = (wire: Wire, id: number, after: number) => wire.acts.filter((act) => act.kind === 'revive_cancel' && act.id === id && act.at >= after);
const probe = (page: Page) => page.evaluate(() => (window as unknown as { __reviveRaf: RafProbe }).__reviveRaf);
const slow = (page: Page, interval: number) => page.evaluate((interval) => {
  const value = (window as unknown as { __reviveRaf: RafProbe }).__reviveRaf;
  value.interval = interval; value.frames = [];
}, interval);

async function place(trio: Trio, index: number, x: number, z = 73.36) {
  const page = trio.pages[index], id = trio.ids[index];
  await page.evaluate(([x, z]) => window.__escape.debug('tp', x, z, 0), [x, z]);
  await expect.poll(() => page.evaluate(([x, z]) => {
    const game = window.__escape.game()!;
    return Math.hypot(game.pos.x - x, game.pos.z - z);
  }, [x, z]), { timeout: 5_000, intervals: [30] }).toBeLessThan(0.15);
  // A local forced correction alone is insufficient: all three real transports must see the
  // intended authoritative position before a hold starts (out-of-area debug tp is refused).
  for (const wire of trio.wires) await expect.poll(() => {
    const p = wire.snaps.at(-1)?.players.find((player) => player.id === id)?.p;
    return p ? Math.hypot(p[0] - x, p[2] - z) : Infinity;
  }, { timeout: 5_000, intervals: [20] }).toBeLessThan(0.15);
  trio.evidence[`placement-${id}-${Date.now()}`] = { intended: [x, z],
    observed: trio.wires.map((wire) => wire.snaps.at(-1)!.players.find((player) => player.id === id)!.p) };
}

async function down(trio: Trio, index: number) {
  await trio.pages[index].evaluate(() => window.__escape.debug('down', 30));
  for (const wire of trio.wires) await expect.poll(() => state(wire, trio.ids[index]), { intervals: [20] }).toBe(ST_DOWN);
}

async function aim(page: Page, id: number) {
  await expect.poll(() => page.evaluate((id) => {
    const game = window.__escape.game()!;
    const remote = game.remotes.get(id);
    const latest = (game as unknown as { peers: Map<number, { p: number[] }> }).peers.get(id);
    return remote && latest ? Math.hypot(remote.mesh.position.x - latest.p[0], remote.mesh.position.z - latest.p[2]) : Infinity;
  }, id), { timeout: 5_000, intervals: [30] }).toBeLessThan(0.15);
  await page.evaluate((id) => {
    const game = window.__escape.game()!;
    const remote = game.remotes.get(id)!;
    const dx = remote.mesh.position.x - game.pos.x, dz = remote.mesh.position.z - game.pos.z;
    game.input.yaw = Math.atan2(-dx, -dz);
    game.input.pitch = Math.atan2(remote.mesh.position.y + 0.4 - game.camera.position.y, Math.hypot(dx, dz));
  }, id);
  await expect.poll(() => page.evaluate(() => {
    const target = window.__escape.game()!.target();
    return target?.kind === 'revive' ? target.id : -1;
  }), { intervals: [30] }).toBe(id);
}

async function firstRenewal(page: Page, wire: Wire, id: number) {
  const after = Date.now();
  await page.keyboard.down('KeyE');
  await expect.poll(() => revives(wire, id, after).length, { timeout: 2_000, intervals: [20] }).toBeGreaterThan(0);
  return revives(wire, id, after)[0].at;
}

async function stopped(page: Page, wire: Wire, id: number, after: number) {
  await expect.poll(() => cancels(wire, id, after).length, { timeout: 1_000, intervals: [20] }).toBeGreaterThan(0);
  await page.waitForTimeout(750); // exceeds the unchanged 0.6 s server stale window
  expect(revives(wire, id, after + 180), 'no renewal after cancellation').toEqual([]);
}

async function remainsDown(trio: Trio, id: number, since: number) {
  for (const wire of trio.wires) {
    const samples = wire.snaps.filter((snap) => snap.at >= since);
    expect(samples.length).toBeGreaterThan(5);
    expect(samples.every((snap) => snap.players.find((player) => player.id === id)?.st === ST_DOWN)).toBe(true);
  }
}

async function stableRevived(trio: Trio, index: number, firstSent: number) {
  const id = trio.ids[index];
  for (const wire of trio.wires) await expect.poll(() => state(wire, id), { timeout: 7_000, intervals: [20] }).toBe(ST_OK);
  const firstOk = trio.wires.map((wire) => wire.snaps.find((snap) => snap.at >= firstSent &&
    snap.players.some((player) => player.id === id && (player.st ?? ST_OK) === ST_OK))!.at);
  expect(Math.min(...firstOk) - firstSent, 'authority requires three full seconds').toBeGreaterThanOrEqual(2_850);
  const since = Date.now();
  await trio.pages[0].waitForTimeout(2_200);
  for (const wire of trio.wires) {
    const samples = wire.snaps.filter((snap) => snap.at >= since);
    expect(samples.length, 'continuous real snapshots during the post-revive observation').toBeGreaterThanOrEqual(30);
    expect(samples.at(-1)!.at - samples[0].at).toBeGreaterThanOrEqual(2_000);
    expect(samples.every((snap) => snap.players.some((player) => player.id === id && (player.st ?? ST_OK) === ST_OK))).toBe(true);
  }
  for (const [i, page] of trio.pages.entries()) {
    const visible = await page.evaluate((id) => {
      const game = window.__escape.game()!;
      const remote = game.remotes.get(id);
      return id === game.myId ? !game.down && !game.spectate : !!remote && !remote.down && !remote.out && remote.mesh.visible;
    }, id);
    expect(visible, `client ${i} keeps the rescued player alive and visible`).toBe(true);
  }
  trio.evidence[`revived-${index}-${firstSent}`] = { firstSent, firstOk, observedFrom: since,
    observedUntil: Date.now(), snapshots: trio.wires.map((wire) => wire.snaps.filter((snap) => snap.at >= since).length) };
}

const test = base.extend<{ trio: Trio }>({
  trio: async ({ browser, baseURL }, use, testInfo) => {
    const contexts = [];
    const pages: Page[] = [];
    const wires: Wire[] = [];
    const evidence: Record<string, unknown> = {};
    try {
      for (let i = 0; i < 3; i++) {
        const context = await browser.newContext({ baseURL, viewport: { width: 844, height: 390 }, deviceScaleFactor: 1,
          ...(i === 2 ? { hasTouch: true, isMobile: true } : {}) });
        contexts.push(context);
        // Only rAF is slowed. Native timers and the real WebSocket remain untouched, reproducing
        // a renderer that delivers one game frame per second while network renewal can still run.
        await context.addInitScript(() => {
          const w = window as unknown as { __reviveRaf: { interval: number; frames: number[] } };
          w.__reviveRaf = { interval: 0, frames: [] };
          const native = window.requestAnimationFrame.bind(window);
          window.requestAnimationFrame = (callback) => native((now) => {
            const run = () => { if (w.__reviveRaf.interval) w.__reviveRaf.frames.push(Date.now()); callback(performance.now()); };
            if (w.__reviveRaf.interval) setTimeout(run, w.__reviveRaf.interval);
            else callback(now);
          });
        });
        const page = await context.newPage();
        pages.push(page); wires.push(observe(page));
        await page.goto('/?nodraw&steady');
        await page.fill('#name', ['救援甲', '倒地乙', '触屏丙'][i]);
      }
      const [a, b, c] = pages;
      await a.click('#create');
      await expect(a.locator('#wait-code')).not.toBeEmpty();
      const code = await a.locator('#wait-code').innerText();
      for (const page of [b, c]) { await page.fill('#code', code); await page.click('#join'); }
      await expect(a.locator('#wait-members li')).toHaveCount(3);
      await a.click('#start');
      await Promise.all(pages.map(async (page) => {
        await page.waitForFunction(() => (window.__escape.game() as unknown as { spawnSynced: boolean })?.spawnSynced, null, { timeout: 30_000 });
        await page.waitForFunction(() => !window.__escape.game()!.intro.active);
        await page.evaluate(() => window.__escape.debug('safe', 600));
      }));
      await c.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); });
      await c.setViewportSize({ width: 844, height: 390 });
      const ids = await Promise.all(pages.map((page) => page.evaluate(() => window.__escape.game()!.myId)));
      const trio = { pages, wires, ids, evidence };
      await Promise.all(pages.map((_, i) => place(trio, i, [-43, -44.5, -41.5][i])));
      for (const page of pages) await expect(page.locator('#banner')).toBeHidden({ timeout: 15_000 });
      evidence.renderers = await Promise.all(pages.map((page) => page.evaluate(() => {
        const gl = window.__escape.game()!.renderer.getContext(), extension = gl.getExtension('WEBGL_debug_renderer_info');
        return extension ? String(gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)) : 'unavailable';
      })));
      for (const wire of wires) expect(wire.urls).toEqual([`${baseURL!.replace(/^http/, 'ws')}/ws`]);
      if (process.platform === 'darwin')
        for (const renderer of evidence.renderers as string[]) expect(renderer).toMatch(/metal/i);
      await use(trio);
    } finally {
      evidence.raf = await Promise.all(pages.map((page) => probe(page).catch(() => null)));
      const path = testInfo.outputPath('real-ws-evidence.json');
      writeFileSync(path, JSON.stringify({ ...evidence, wires }, null, 2));
      await testInfo.attach('real-ws-evidence', { path, contentType: 'application/json' });
      await Promise.all(contexts.map((context) => context.close()));
    }
    for (const wire of wires) expect(wire.errors).toEqual([]);
  },
});

test.use({ headless: true, launchOptions: { args: browserArgs(['--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], { softwareGL: '0' }) } });

test('1 fps: a tap and a 2.7 s released hold cannot revive; a real hold revives for all three clients', async ({ trio }) => {
  const [a] = trio.pages, [wire] = trio.wires, id = trio.ids[1];
  await down(trio, 1);
  await aim(a, id);
  await slow(a, 1_000);

  const tapped = await firstRenewal(a, wire, id);
  await a.waitForTimeout(Math.max(0, tapped + 80 - Date.now()));
  await a.keyboard.up('KeyE');
  const tapReleased = Date.now();
  expect(tapReleased - tapped, 'the keyboard tap is shorter than a rendered frame').toBeLessThan(350);
  await stopped(a, wire, id, tapReleased - 50);
  await a.waitForTimeout(3_100);
  expect(revives(wire, id, tapReleased + 180), 'a latched frame tap is never a held key').toEqual([]);
  await remainsDown(trio, id, tapped);

  const nearComplete = await firstRenewal(a, wire, id);
  await a.waitForTimeout(Math.max(0, nearComplete + 2_700 - Date.now()));
  const released = Date.now();
  await a.keyboard.up('KeyE');
  await stopped(a, wire, id, released);
  await remainsDown(trio, id, nearComplete);

  const started = await firstRenewal(a, wire, id);
  await stableRevived(trio, 1, started);
  await a.keyboard.up('KeyE');
  const sent = revives(wire, id, started).filter((act) => act.at < started + 2_900);
  expect(sent.length, 'renewals continue while rendered frames are one second apart').toBeGreaterThanOrEqual(20);
  const gaps = sent.slice(1).map((act, i) => act.at - sent[i].at);
  expect(Math.max(...gaps), 'network renewal stays within the 0.6 s stale window').toBeLessThan(550);
  const frames = (await probe(a)).frames.filter((at) => at >= started && at <= started + 3_000);
  expect(frames.length).toBeGreaterThanOrEqual(2);
  expect(frames.length).toBeLessThanOrEqual(4);
  expect(frames.slice(1).every((at, i) => at - frames[i] >= 900)).toBe(true);
  trio.evidence.keyboard = { tapped, tapReleased, nearComplete, released, started, frames, gaps };
});

test('a held key cancels on target change, range loss, blur and the rescuer going down', async ({ trio }) => {
  const [a] = trio.pages, [wire] = trio.wires, [, bId, cId] = trio.ids;
  await down(trio, 1); await down(trio, 2);
  await aim(a, bId); await slow(a, 1_000);
  const startedB = await firstRenewal(a, wire, bId);
  await a.waitForTimeout(1_650);
  const switched = Date.now();
  await aim(a, cId);
  await expect.poll(() => revives(wire, cId, switched).length, { timeout: 1_000, intervals: [20] }).toBeGreaterThan(0);
  await a.waitForTimeout(1_650);
  await remainsDown(trio, bId, startedB); await remainsDown(trio, cId, switched);
  expect(cancels(wire, bId, switched).length).toBeGreaterThan(0);
  expect(revives(wire, bId, switched + 180)).toEqual([]);
  await a.keyboard.up('KeyE');
  await stopped(a, wire, cId, Date.now() - 50);

  await aim(a, bId);
  await firstRenewal(a, wire, bId);
  await a.waitForTimeout(400);
  const moved = Date.now();
  await place(trio, 0, -39);
  await stopped(a, wire, bId, moved);
  await a.keyboard.up('KeyE');
  await remainsDown(trio, bId, moved);

  await place(trio, 0, -43); await aim(a, bId);
  await firstRenewal(a, wire, bId);
  const blurred = Date.now();
  // Exercise the native blur event route without depending on headless window-manager focus.
  await a.evaluate(() => window.dispatchEvent(new Event('blur')));
  await stopped(a, wire, bId, blurred);
  await a.keyboard.up('KeyE');
  await remainsDown(trio, bId, blurred);

  await firstRenewal(a, wire, bId);
  const caught = Date.now();
  // Both patients are already down. Losing the last standing rescuer immediately wipes the team.
  await a.evaluate(() => window.__escape.debug('down', 30));
  for (const page of trio.pages) await expect(page.locator('#fade-overlay')).toBeVisible({ timeout: 2_000 });
  expect(Date.now() - caught).toBeLessThan(2_000);
  await stopped(a, wire, bId, caught);
  await a.keyboard.up('KeyE');
  for (const page of trio.pages) await expect(page.locator('#fade-overlay')).toContainText('全员出局');
  trio.evidence.invalidated = { startedB, switched, moved, blurred, caught };
});

async function finger(cdp: CDPSession, type: 'touchStart' | 'touchEnd' | 'touchCancel', point: { x: number; y: number }) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchStart' ? [{ id: 1, ...point }] : [] });
}

test('touch tap, canceled long press and settings stay down; a complete hold revives, and disconnect stops renewal', async ({ trio }) => {
  const phone = trio.pages[2], wire = trio.wires[2], id = trio.ids[1];
  await place(trio, 0, -40); await place(trio, 2, -43);
  await down(trio, 1); await aim(phone, id);
  await slow(phone, 1_000);
  const cdp = await phone.context().newCDPSession(phone);
  const point = await phone.evaluate((id) => {
    const game = window.__escape.game()!, r = game.remotes.get(id)!;
    // Input rotation changes immediately; use that pose for screen projection before the next slow frame.
    game.camera.rotation.set(game.input.pitch, game.input.yaw, 0); game.camera.updateMatrixWorld();
    const p = r.mesh.position.clone().add(new window.__escape.THREE.Vector3(0, 0.4, 0)).project(game.camera);
    return { x: (p.x + 1) * innerWidth / 2, y: (1 - p.y) * innerHeight / 2 };
  }, id);
  expect(point.x).toBeGreaterThan(0); expect(point.x).toBeLessThan(844);
  expect(point.y).toBeGreaterThan(0); expect(point.y).toBeLessThan(390);
  await expect(phone.locator('#touch')).toBeVisible();

  const tapped = Date.now();
  await phone.touchscreen.tap(point.x, point.y);
  await phone.waitForTimeout(450);
  expect(revives(wire, id, tapped)).toEqual([]);

  const canceledHold = Date.now();
  await finger(cdp, 'touchStart', point);
  await expect.poll(() => revives(wire, id, canceledHold).length, { timeout: 1_500, intervals: [20] }).toBeGreaterThan(0);
  await phone.waitForTimeout(700);
  const canceled = Date.now();
  await finger(cdp, 'touchCancel', point);
  await stopped(phone, wire, id, canceled);
  await phone.waitForTimeout(2_300);
  await remainsDown(trio, id, canceledHold);

  const settingsHold = Date.now();
  await finger(cdp, 'touchStart', point);
  await expect.poll(() => revives(wire, id, settingsHold).length, { timeout: 1_500, intervals: [20] }).toBeGreaterThan(0);
  const settingsOpened = Date.now();
  await toggleSettings(phone, true);
  await expect(phone.locator('#game-settings')).toHaveAttribute('open', '');
  await stopped(phone, wire, id, settingsOpened);
  await phone.waitForTimeout(2_300);
  await remainsDown(trio, id, settingsHold);
  await finger(cdp, 'touchCancel', point);
  await toggleSettings(phone, true);

  const held = Date.now();
  await finger(cdp, 'touchStart', point);
  await expect.poll(() => revives(wire, id, held).length, { timeout: 1_500, intervals: [20] }).toBeGreaterThan(0);
  const firstSent = revives(wire, id, held)[0].at;
  await stableRevived(trio, 1, firstSent);
  await finger(cdp, 'touchEnd', point);
  const sent = revives(wire, id, firstSent).filter((act) => act.at < firstSent + 2_900);
  const gaps = sent.slice(1).map((act, i) => act.at - sent[i].at);
  expect(sent.length, 'touch renewals continue while rendered frames are one second apart').toBeGreaterThanOrEqual(20);
  expect(Math.max(...gaps), 'touch renewal stays within the unchanged stale window').toBeLessThan(550);
  const frames = (await probe(phone)).frames.filter((at) => at >= firstSent && at <= firstSent + 3_000);
  expect(frames.length).toBeGreaterThanOrEqual(2);
  expect(frames.length).toBeLessThanOrEqual(4);
  expect(frames.slice(1).every((at, i) => at - frames[i] >= 900)).toBe(true);

  await down(trio, 1);
  const disconnectedHold = Date.now();
  await finger(cdp, 'touchStart', point);
  await expect.poll(() => revives(wire, id, disconnectedHold).length, { timeout: 1_500, intervals: [20] }).toBeGreaterThan(0);
  await phone.waitForTimeout(500);
  // Lose the real transport and keep it offline so automatic resume cannot mask a held-input leak.
  wire.offlineAt = Date.now();
  await phone.evaluate(() => (window.__escape.net as unknown as { ws: WebSocket }).ws.close(1000, 'revive test disconnect'));
  await expect.poll(() => wire.closed, { intervals: [20] }).toBeDefined();
  await phone.context().setOffline(true);
  const closed = wire.closed!;
  await phone.waitForTimeout(1_000);
  expect(revives(wire, id, closed + 50)).toEqual([]);
  const queued = await phone.evaluate(() =>
    (window.__escape.net as unknown as { initialQueue: ClientMsg[] }).initialQueue);
  expect(queued, 'disconnected holds are never queued for a future connection').toEqual([]);
  for (const observer of trio.wires.slice(0, 2)) {
    const samples = observer.snaps.filter((snap) => snap.at >= closed);
    expect(samples.length).toBeGreaterThan(10);
    expect(samples.every((snap) => snap.players.some((player) => player.id === id && player.st === ST_DOWN))).toBe(true);
  }
  const reserved = trio.wires[0].snaps.at(-1)!.players.find((player) => player.id === trio.ids[2]);
  expect(reserved,
    'the disconnected rescuer keeps its identity during the bounded resume reservation')
    .toMatchObject({ id: trio.ids[2], online: false });
  expect(reserved!.st ?? ST_OK).toBe(ST_OK);
  await finger(cdp, 'touchCancel', point);
  trio.evidence.touch = { point, tapped, canceledHold, canceled, settingsHold, settingsOpened,
    held, firstSent, gaps, frames, disconnectedHold, closed, queued };
});
