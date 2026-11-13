import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import WebSocket from 'ws';
import type { ClientMsg, PlayerSnap, ServerMsg, TeamActivityEvent } from '../../shared/protocol.ts';
import type { DoorSpot } from '../../shared/doors.ts';
import { browserArgs } from '../browser-args.mjs';
import { showCanvas } from './draw';
import { restoreRealFocus } from './realFocus.ts';

// This test exercises native pointer lock and Tab capture, which require a real browser window.
test.use({ headless: false, launchOptions: { args: browserArgs(['--mute-audio']) } });

interface Bot {
  ws: WebSocket;
  id: number;
  players: Map<number, PlayerSnap>;
  doorOpen: Map<number, boolean>;
  activities: TeamActivityEvent[];
  send(message: ClientMsg): void;
}

interface PointerLockTrace {
  trustedInput: { type: string; trusted: boolean; at: number; active: boolean } | null;
  events: { type: string; at: number; detail?: unknown }[];
}

function connectBot(url: string): Bot {
  const ws = new WebSocket(url);
  const bot: Bot = { ws, id: 0, players: new Map(), doorOpen: new Map(), activities: [], send: m => ws.send(JSON.stringify(m)) };
  let incarnation = 0, readyIncarnation = 0;
  ws.on('message', raw => {
    const message = JSON.parse(String(raw)) as ServerMsg;
    if (message.t === 'welcome') bot.id = message.id;
    if (message.t === 'room' && message.started) incarnation = message.incarnation;
    if (message.t === 'event' && message.kind === 'intro' && !message.ended) bot.send({ t: 'intro-skip', id: message.id });
    if (message.t === 'snap') {
      for (const p of message.players) bot.players.set(p.id, p);
      const own = bot.players.get(bot.id);
      if (incarnation && readyIncarnation !== incarnation && own && (own.st ?? 0) === 0) {
        readyIncarnation = incarnation;
        bot.send({ t: 'ready', incarnation });
      }
    }
    if (message.t === 'doors' || (message.t === 'snap' && message.doors)) {
      for (const door of message.doors ?? []) bot.doorOpen.set(door.id, door.open);
    }
    if (message.t === 'activity') bot.activities.push(message);
  });
  return bot;
}

async function joinBot(bot: Bot, code: string, name: string) {
  if (bot.ws.readyState !== WebSocket.OPEN) await new Promise<void>((resolve, reject) => {
    bot.ws.once('open', resolve);
    bot.ws.once('error', reject);
  });
  bot.send({ t: 'hello', name });
  bot.send({ t: 'join', code });
  await expect.poll(() => bot.id).toBeGreaterThan(0);
}

async function closeBot(bot: Bot) {
  if (bot.ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => { bot.ws.terminate(); resolve(); }, 1000);
    bot.ws.once('close', () => { clearTimeout(timer); resolve(); });
    bot.ws.close();
  });
}

const botRow = (page: Page, name: string) => page.locator('#team > div').filter({ hasText: name });
function pointerDiagnostics(page: Page) {
  return page.evaluate(() => {
    const input = window.__escape.game()?.input;
    return {
      focused: document.hasFocus(),
      locked: document.pointerLockElement === document.querySelector('body > canvas'),
      input: { enabled: input?.enabled, pointerLock: input?.pointerLock, tabHeld: input?.keys.has('Tab') },
      activeElement: { tag: document.activeElement?.tagName, id: document.activeElement?.id },
      visibility: document.visibilityState,
      activation: { active: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive },
      trace: (window as unknown as { __teamPointerLock?: PointerLockTrace }).__teamPointerLock,
    };
  });
}

async function holdTeam(page: Page) {
  // Return to gameplay through the same visible click a player uses after capture is released.
  // Keep the undrawn canvas visible: hiding it can itself release pointer lock in Chrome.
  await page.keyboard.up('Tab');
  await showCanvas(page, true);
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.bringToFront();
    await page.locator('body > canvas').click();
    try {
      await expect.poll(() => pointerDiagnostics(page), { timeout: 2000,
        message: 'Tab must reach the captured game rather than navigate native settings' }).toMatchObject({ focused: true, locked: true });
      break;
    } catch (error) {
      // Chrome briefly refuses a new capture after an unlock. A later real click may retry;
      // waiting alone cannot retry the browser request. Keep the final strict assertion failure.
      const state = await pointerDiagnostics(page);
      if (attempt === 2 || state.locked !== false) throw error;
    }
  }
  await page.keyboard.down('Tab');
  await expect(page.locator('#team')).toBeVisible();
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: 'image/png' });
}

async function expired(page: Page, name: string) {
  // The cache must expire even while Tab is closed, without a render-count timer.
  await page.keyboard.up('Tab');
  await expect(page.locator('#team')).toBeHidden();
  await page.waitForTimeout(5200);
  await holdTeam(page);
  await expect(botRow(page, name)).toContainText('暂未行动', { timeout: 8000 });
  await expect(botRow(page, name)).not.toContainText(/刚开门|刚关门|刚拾取|刚扶起/);
}

test('Tab reports only real teammate successes, expires them, and renders HTML nicknames as text', async ({ page, baseURL }, info) => {
  test.setTimeout(150_000);
  const bots: Bot[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const actorName = '<b>开门员</b>';
  const actorDisplayName = 'b开门员/b'; // The authority removes markup delimiters before sharing names.
  await page.addInitScript(() => {
    const trace: PointerLockTrace = { trustedInput: null, events: [] };
    (window as unknown as { __teamPointerLock: PointerLockTrace }).__teamPointerLock = trace;
    const record = (type: string, detail?: unknown) => {
      trace.events.push({ type, at: performance.now(), detail });
      if (trace.events.length > 20) trace.events.shift();
    };
    const state = () => ({ focused: document.hasFocus(), visibility: document.visibilityState,
      activeElement: document.activeElement?.tagName, active: navigator.userActivation.isActive,
      hasBeenActive: navigator.userActivation.hasBeenActive, trustedInput: trace.trustedInput });
    for (const type of ['pointerdown', 'click', 'keydown']) {
      addEventListener(type, event => {
        trace.trustedInput = { type, trusted: event.isTrusted, at: performance.now(), active: navigator.userActivation.isActive };
      }, true);
    }
    document.addEventListener('pointerlockerror', () => record('pointerlockerror', state()));
    document.addEventListener('pointerlockchange', () => record('pointerlockchange', { ...state(), locked: !!document.pointerLockElement }));
    const native = Element.prototype.requestPointerLock;
    const failure = (error: unknown) => error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) };
    if (native) Element.prototype.requestPointerLock = function (this: Element, ...args: Parameters<typeof native>) {
      record('request', { ...state(), target: this.tagName });
      try {
        const pending = native.apply(this, args);
        return pending?.then(() => record('resolved', state()), error => {
          record('rejected', { ...state(), error: failure(error) });
          throw error;
        }) ?? pending;
      } catch (error) { record('threw', { ...state(), error: failure(error) }); throw error; }
    };
  });
  // Playwright forces every page to be focused by default. Let Chromium use the actual active tab/window.
  await restoreRealFocus(page);
  try {
    await page.goto('/?nodraw');
    await page.bringToFront();
    await page.fill('#name', '观察员');
    await page.click('#create');
    await expect.poll(() => page.evaluate(() => window.__escape.code)).not.toBe('');
    const code = await page.evaluate(() => window.__escape.code);
    const url = baseURL!.replace(/^http/, 'ws') + '/ws';
    const actor = connectBot(url); bots.push(actor);
    const patient = connectBot(url); bots.push(patient);
    await joinBot(actor, code, actorName);
    await joinBot(patient, code, '待救队友');
    await expect(page.locator('#wait-members li')).toHaveCount(3);
    await page.click('#start');
    await expect(page.locator('#hud')).toBeVisible({ timeout: 30_000 });
    await page.waitForFunction(() => window.__escape.game()?.presentationReady && !window.__escape.game()!.intro.active);
    await expect.poll(() => page.evaluate(() => window.__escape.game()?.snaps ?? 0), { timeout: 20_000 }).toBeGreaterThan(2);
    await expect.poll(() => actor.players.size, { timeout: 10_000 }).toBe(3);
    actor.send({ t: 'debug', op: 'safe', s: 600 });
    await holdTeam(page);
    await expect(botRow(page, actorDisplayName)).toContainText('暂未行动');
    await expect(page.locator('#team b')).toHaveCount(0);
    await expect(page.locator('#team img, #team script')).toHaveCount(0);

    // The room chooses a real unlocked door; the bot stands on its own floor beside the doorway.
    const door = await page.evaluate(() => {
      const g = window.__escape.game() as unknown as { doors: DoorSpot[]; doorLocked: boolean[]; level: { def: { area: { x0: number; x1: number; z0: number; z1: number } } } };
      const area = g.level.def.area;
      return g.doors.find(d => !g.doorLocked[d.id] && (d.y0 ?? 0) === 0 && d.x > area.x0 + 2 && d.x < area.x1 - 2 && d.z > area.z0 + 2 && d.z < area.z1 - 2)!;
    });
    expect(door).toBeTruthy();
    const near = { x: door.x - (door.alongX ? 0 : 1.5), z: door.z - (door.alongX ? 1.5 : 0) };
    actor.send({ t: 'debug', op: 'tp', ...near, floor: 0 });
    await expect.poll(() => {
      const p = actor.players.get(actor.id)?.p;
      return p ? Math.hypot(p[0] - near.x, p[2] - near.z) : Infinity;
    }).toBeLessThan(0.1);
    // A missing target produces no activity packet and does not invent an action in Tab.
    actor.send({ t: 'act', kind: 'pick', id: 999999 });
    await page.waitForTimeout(250);
    expect(actor.activities).toEqual([]);
    await expect(botRow(page, actorDisplayName)).toContainText('暂未行动');
    actor.send({ t: 'door', id: door.id });
    await expect.poll(() => actor.activities.some(a => a.from === actor.id && a.kind === 'open')).toBe(true);
    await expect.poll(() => actor.doorOpen.get(door.id)).toBe(true);
    await holdTeam(page);
    await expect(botRow(page, actorDisplayName)).toContainText('刚开门');
    await screenshot(page, info, 'team-activity-open');
    await expired(page, actorDisplayName);
    actor.send({ t: 'door', id: door.id });
    await expect.poll(() => ({
      open: actor.doorOpen.get(door.id),
      closes: actor.activities.filter(a => a.from === actor.id && a.kind === 'close').length,
      // Keep authoritative positions / states in the failure output to distinguish a refused action from a HUD fault.
      players: [...actor.players.values()],
    }), { message: 'The room must confirm one completed close before the HUD reports it' }).toMatchObject({ open: false, closes: 1 });
    await holdTeam(page);
    await expect(botRow(page, actorDisplayName)).toContainText('刚关门');

    const item = await page.evaluate(() => {
      const g = window.__escape.game() as unknown as { items: { id: number; kind: string; p: number[] }[] };
      return g.items.find(i => i.kind === 'door_key')!;
    });
    expect(item).toBeTruthy();
    const pickup = { x: item.p[0] - 1, z: item.p[2] }; // Clear west side of every audited L1 lectern.
    actor.send({ t: 'debug', op: 'tp', ...pickup, floor: 0 });
    await expect.poll(() => {
      const p = actor.players.get(actor.id)?.p;
      return p ? Math.hypot(p[0] - pickup.x, p[2] - pickup.z) : Infinity;
    }).toBeLessThan(0.1);
    actor.send({ t: 'act', kind: 'pick', id: item.id });
    await expect.poll(() => actor.activities.some(a => a.from === actor.id && a.kind === 'pick' && a.item === 'door_key')).toBe(true);
    await holdTeam(page);
    await expect(botRow(page, actorDisplayName)).toContainText('刚拾取钥匙');
    await screenshot(page, info, 'team-activity-pick');
    await expired(page, actorDisplayName);

    // A third player observes the completed rescue; the reader stays able to open Tab throughout.
    const patientPos = actor.players.get(patient.id)!.p;
    actor.send({ t: 'debug', op: 'tp', x: patientPos[0] + 1, z: patientPos[2], floor: 0 });
    await expect.poll(() => {
      const p = actor.players.get(actor.id)?.p;
      return p ? Math.hypot(p[0] - patientPos[0] - 1, p[2] - patientPos[2]) : Infinity;
    }).toBeLessThan(0.1);
    patient.send({ t: 'debug', op: 'down', s: 30 });
    await expect.poll(() => actor.players.get(patient.id)?.st).toBe(1);
    const since = Date.now();
    while (Date.now() - since < 4200 && actor.players.get(patient.id)?.st === 1) {
      actor.send({ t: 'act', kind: 'revive', id: patient.id });
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(Date.now() - since).toBeGreaterThanOrEqual(2800);
    await expect.poll(() => actor.players.get(patient.id)?.st ?? 0).toBe(0);
    expect(actor.activities.filter(a => a.from === actor.id && a.kind === 'revive')).toHaveLength(1);
    await holdTeam(page);
    await expect(botRow(page, actorDisplayName)).toContainText('刚扶起队友');
    await expect(page.locator('#team b')).toHaveCount(0);
    await screenshot(page, info, 'team-activity-revive');
    await expired(page, actorDisplayName);
    expect(errors).toEqual([]);
  } finally {
    const diagnostics = await pointerDiagnostics(page).catch(error => ({ unavailable: String(error) }));
    try {
      mkdirSync('test-results', { recursive: true });
      writeFileSync('test-results/teaching-team-pointer.json', JSON.stringify(diagnostics, null, 2));
    } catch { /* Preserve the original test failure if artifact storage itself fails. */ }
    await page.keyboard.up('Tab').catch(() => {});
    await Promise.all(bots.map(closeBot));
  }
});
