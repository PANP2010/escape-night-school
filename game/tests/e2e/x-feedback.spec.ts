import { settingsShot, toggleSettings } from './settings-controls.ts';
import { devices, expect, test, type CDPSession, type Page } from '@playwright/test';
import { browserArgs } from '../browser-args.mjs';
import { shot } from './draw';
import { FeedbackPeer } from '../team-feedback-peer.ts';
import { writeFile } from 'node:fs/promises';

// Exercises trusted browser gestures and real audio output; it does not bypass the sound gate.
const ARGS = browserArgs(['--mute-audio', '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']);
test.use({ launchOptions: { args: ARGS } });

interface SoundDiagnostics {
  unlocked: boolean;
  state: string;
  activeSources: number;
  ambientSources: number;
  volume: number;
  muted: boolean;
  played: Record<string, number>;
}
const sound = (page: Page): Promise<SoundDiagnostics> => withoutGesture(page, () =>
  (window.__escape.game() as unknown as { sound: { diagnostics: SoundDiagnostics } }).sound.diagnostics, undefined);
const played = async (page: Page, kind: string) => (await sound(page)).played[kind] ?? 0;
const light = (page: Page) => withoutGesture(page, () => window.__escape.game()!.light, undefined);
const errorsOn = (page: Page) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console.error: ${message.text()}`); });
  return errors;
};

const gestureSessions = new WeakMap<Page, CDPSession>();
// Playwright's page.evaluate sets userGesture:true. Keep all autoplay setup on the raw, untrusted protocol path.
async function withoutGesture<R, A>(page: Page, fn: (argument: A) => R, argument: A): Promise<Awaited<R>> {
  let session = gestureSessions.get(page);
  if (!session) { session = await page.context().newCDPSession(page); gestureSessions.set(page, session); }
  const result = await session.send('Runtime.evaluate', {
    expression: `(${fn.toString()})(${JSON.stringify(argument) ?? 'undefined'})`,
    userGesture: false, returnByValue: true, awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value as Awaited<R>;
}

/** The real transport still creates/joins/starts the room, with no click/tap/keyboard before locked(). */
async function networkEntry(page: Page, name: string, code?: string, start = true) {
  await withoutGesture(page, async ({ name, code, start }) => {
    const wait = async (ready: () => boolean) => {
      const began = performance.now();
      while (!ready()) {
        if (performance.now() - began > 30_000) throw new Error('Untrusted feedback room setup timed out');
        await new Promise((done) => setTimeout(done, 40));
      }
    };
    await wait(() => !!window.__escape && (window.__escape.net as unknown as { ws: WebSocket }).ws.readyState === WebSocket.OPEN);
    window.__escape.net.send({ t: 'hello', name });
    if (code) window.__escape.net.send({ t: 'join', code }); else window.__escape.net.send({ t: 'create' });
    await wait(() => !!window.__escape.code);
    if (start && !code) window.__escape.net.send({ t: 'start' });
  }, { name, code, start });
}

async function networkStart(page: Page) {
  await withoutGesture(page, () => window.__escape.net.send({ t: 'start' }), undefined);
}

async function ready(page: Page) {
  await expect.poll(() => withoutGesture(page, () => {
    const hud = document.getElementById('hud');
    return !!hud && !hud.hidden && getComputedStyle(hud).visibility !== 'hidden'
      && getComputedStyle(hud).display !== 'none' && hud.getBoundingClientRect().height > 0;
  }, undefined), { timeout: 40_000 }).toBe(true);
  await expect.poll(() => withoutGesture(page, () => {
    const g = window.__escape.game(); return !!g?.presentationReady && !g.intro.active;
  }, undefined),
    { timeout: 30_000 }).toBe(true);
  await expect.poll(() => withoutGesture(page, () => window.__escape.game()?.snaps ?? 0, undefined), { timeout: 15_000 }).toBeGreaterThan(2);
  await withoutGesture(page, () => {
    window.__escape.debug('safe', 120, 1);
    window.__escape.debug('safe', 120, 2);
  }, undefined);
}

async function solo(page: Page, name: string) {
  await page.goto('/?nodraw');
  await networkEntry(page, name);
  await ready(page);
}

async function locked(page: Page) {
  const d = await sound(page);
  expect(d).toMatchObject({ unlocked: false, state: 'locked', activeSources: 0, ambientSources: 0 });
  expect(d.played).toEqual({});
  const untouched = await withoutGesture(page, () => ({
    hasContext: !!(window.__escape.game() as unknown as { sound: { context?: AudioContext } }).sound.context,
    hasBeenActive: navigator.userActivation.hasBeenActive,
    active: navigator.userActivation.isActive,
  }), undefined);
  expect(untouched).toEqual({ hasContext: false, hasBeenActive: false, active: false });
}

async function ambience(page: Page) {
  await expect.poll(async () => {
    const d = await sound(page);
    return { state: d.state, ambientSources: d.ambientSources, activeSources: d.activeSources };
  }, { timeout: 15_000 }).toEqual({ state: 'running', ambientSources: 5, activeSources: 5 });
  // At rest the same five looping sources must remain bounded, rather than recreating a bed every frame.
  await page.waitForTimeout(1200);
  // A legitimate environmental one-shot can overlap this instant; require it to release again.
  await expect.poll(async () => {
    const d = await sound(page);
    return { state: d.state, ambientSources: d.ambientSources, activeSources: d.activeSources };
  }, { timeout: 15_000 }).toEqual({ state: 'running', ambientSources: 5, activeSources: 5 });
}

/** Read real rendered Web Audio samples; the added branch is silent and leaves the original output connected. */
async function signalRms(page: Page) {
  return page.evaluate(async () => {
    const s = (window.__escape.game() as unknown as { sound: { context?: AudioContext; master?: GainNode } }).sound;
    if (!s.context || !s.master) throw new Error('Expected a real unlocked Web Audio graph');
    const analyser = s.context.createAnalyser(), silent = s.context.createGain();
    analyser.fftSize = 2048;
    silent.gain.value = 0;
    s.master.connect(analyser);
    analyser.connect(silent).connect(s.context.destination);
    const samples = new Float32Array(analyser.fftSize);
    let rms = 0;
    try {
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 70));
        analyser.getFloatTimeDomainData(samples);
        rms = Math.max(rms, Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length));
      }
      return rms;
    } finally {
      s.master.disconnect(analyser);
      analyser.disconnect();
      silent.disconnect();
    }
  });
}

/** Sample the effects bus around a real game/network action, excluding the ambient bed. */
async function eventSignalRms(page: Page, action: () => Promise<unknown>) {
  const probe = await page.evaluateHandle(async () => {
    const s = (window.__escape.game() as unknown as { sound: { context?: AudioContext; effects?: GainNode } }).sound;
    if (!s.context || !s.effects) throw new Error('Expected a real unlocked effects bus');
    const globals = window as unknown as {
      __feedbackAudioProbe?: { context: AudioContext; ready: Promise<void> };
    };
    if (globals.__feedbackAudioProbe?.context !== s.context) {
      const url = URL.createObjectURL(new Blob([`
        class EventRmsProbe extends AudioWorkletProcessor {
          constructor() {
            super(); this.rms = 0; this.frames = 0;
            this.port.onmessage = () => this.port.postMessage({ rms: this.rms, final: true });
          }
          process(inputs) {
            const samples = inputs[0]?.[0];
            if (samples) {
              let sum = 0;
              for (const value of samples) sum += value * value;
              this.rms = Math.max(this.rms, Math.sqrt(sum / samples.length));
            }
            if (++this.frames % 16 === 0) this.port.postMessage({ rms: this.rms });
            return true;
          }
        }
        registerProcessor('escape-e2e-event-rms', EventRmsProbe);
      `], { type: 'text/javascript' }));
      globals.__feedbackAudioProbe = {
        context: s.context,
        ready: s.context.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url)),
      };
    }
    await globals.__feedbackAudioProbe.ready;
    const capture = new AudioWorkletNode(s.context, 'escape-e2e-event-rms');
    s.effects.connect(capture);
    // The processor writes no output, so this test branch contributes silence.
    capture.connect(s.context.destination);
    let rms = 0;
    // Audio-thread capture cannot miss the 55ms click when a busy renderer delays page timers.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('AudioWorklet probe did not start processing')), 5_000);
      capture.port.onmessage = (event: MessageEvent<{ rms: number }>) => {
        rms = Math.max(rms, event.data.rms);
        clearTimeout(timeout);
        resolve();
      };
    });
    capture.port.onmessage = (event: MessageEvent<{ rms: number }>) => { rms = Math.max(rms, event.data.rms); };
    return { finish: async () => {
      await new Promise((resolve) => setTimeout(resolve, 650));
      return await new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('AudioWorklet snapshot timed out')), 5_000);
        capture.port.onmessage = (event: MessageEvent<{ rms: number; final?: boolean }>) => {
          if (!event.data.final) return;
          clearTimeout(timeout);
          resolve(Math.max(rms, event.data.rms));
        };
        capture.port.postMessage('finish');
      });
    }, stop: () => {
      s.effects!.disconnect(capture);
      capture.disconnect();
      capture.port.close();
    } };
  });
  try {
    await action();
    return await probe.evaluate((p) => p.finish());
  } finally {
    await probe.evaluate((p) => p.stop());
    await probe.dispose();
  }
}

async function closeDesktopSettings(page: Page) {
  await toggleSettings(page);
  // A real world click leaves the settings entry ready for the next gameplay action.
  await page.mouse.click(360, 230);
}

test.describe('desktop feedback', () => {
  test.use({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });

  test('settings support native keyboard navigation, stable names and zero volume without game input', async ({ page }) => {
    const errors = errorsOn(page);
    await solo(page, '设置键盘');
    const summary = page.locator('#settings-open');
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#game-settings')).toHaveAttribute('open', '');
    await expect(page.locator('#settings-close')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#settings-sensitivity')).toBeFocused();
    await page.keyboard.press('Tab');
    const volume = page.getByRole('slider', { name: '音效音量', exact: true });
    await expect(volume).toBeFocused();
    await expect(volume).toHaveAttribute('aria-valuetext', '65%');
    await volume.press('Home');
    await expect.poll(async () => (await sound(page)).volume).toBe(0);
    await expect.poll(async () => (await sound(page)).activeSources).toBe(0);
    expect(await signalRms(page)).toBeLessThan(0.000001);
    await expect(volume).toHaveAccessibleName('音效音量');
    await expect(volume).toHaveAttribute('aria-valuetext', '0%');
    await volume.press('End');
    await expect.poll(async () => (await sound(page)).volume).toBe(1);
    await ambience(page);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('checkbox', { name: '静音音效' })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.locator('#settings-muted')).toBeChecked();
    await page.keyboard.press('Tab');
    const haptics = page.getByRole('checkbox', { name: '开启触感' });
    await expect(haptics).toBeFocused();
    await expect(haptics).toHaveAccessibleDescription('减少动态效果开启时不振动；部分设备不支持触感。');
    const before = await page.evaluate(() => ({ ...window.__escape.game()!.pos, light: window.__escape.game()!.light }));
    await page.keyboard.press('KeyF');
    await page.keyboard.press('KeyW');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => ({ ...window.__escape.game()!.pos, light: window.__escape.game()!.light }))).toEqual(before);
    await page.keyboard.press('Escape');
    await expect(page.locator('#game-settings')).not.toHaveAttribute('open');
    await expect(summary).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('the real audio graph pauses on visibility loss and reconnect, then releases on teardown', async ({ page }) => {
    await solo(page, '资源回收');
    await page.keyboard.press('KeyF'); await ambience(page);
    // Headless tabs remain visible. Drive the visibility boundary explicitly while keeping the real Web Audio graph.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(async () => (await sound(page)).state).toBe('suspended');
    expect(await sound(page)).toMatchObject({ unlocked: false, activeSources: 0 });
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(250);
    expect(await sound(page)).toMatchObject({ unlocked: false, activeSources: 0, state: 'suspended' });
    await page.keyboard.press('KeyF'); await ambience(page);
    const session = await page.evaluate(() => ({ id: window.__escape.game()!.myId, code: window.__escape.code }));
    await page.context().setOffline(true);
    await page.evaluate(() => (window.__escape.net as unknown as { ws?: WebSocket }).ws?.close());
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.networkPaused)).toBe(true);
    await expect.poll(async () => (await sound(page)).activeSources).toBe(0);
    await expect(page.locator('#game-settings')).toHaveCount(1);
    await page.context().setOffline(false);
    await expect.poll(() => page.evaluate(() => window.__escape.net.connected && !window.__escape.game()!.networkPaused),
      { timeout: 10_000 }).toBe(true);
    expect(await page.evaluate(() => ({ id: window.__escape.game()!.myId, code: window.__escape.code }))).toEqual(session);
    await ambience(page);
    await page.evaluate(() => {
      window.__escape.net.close();
      window.__escape.game()!.disposeFeedback();
    });
    await expect.poll(async () => (await sound(page)).state).toBe('closed');
    await expect(page.locator('#game-settings')).toHaveCount(0);
    await expect(page.locator('#settings-open')).toHaveCount(0);
    expect(await sound(page)).toMatchObject({ activeSources: 0, ambientSources: 0 });
  });

  test('actual walking drives footsteps and authoritative downing drives a bounded heartbeat', async ({ page, baseURL }, testInfo) => {
    const errors = errorsOn(page);
    const activation: unknown[] = [];
    const checkpoint = async (stage: string) => activation.push({ stage, value: await withoutGesture(page, () => ({
      hasBeenActive: navigator.userActivation.hasBeenActive, active: navigator.userActivation.isActive,
    }), undefined) });
    await page.goto('/?nodraw');
    await checkpoint('loaded');
    await networkEntry(page, '节奏验证', undefined, false);
    await checkpoint('room-created');
    const code = await withoutGesture(page, () => window.__escape.code, undefined);
    const teammate = await new FeedbackPeer('心跳验收队友', baseURL!.replace(/^http/, 'ws') + '/ws').connect();
    try {
    teammate.send({ t: 'join', code });
    await teammate.waitMessage(0, 'room');
    await checkpoint('peer-joined');
    await networkStart(page);
    await checkpoint('network-started');
    await ready(page);
    await checkpoint('presentation-ready');
    teammate.send({ t: 'debug', op: 'safe', s: 600 });
    await locked(page);
    await page.keyboard.press('KeyF');
    await ambience(page);
    const start = await page.evaluate(() => ({ ...window.__escape.game()!.pos }));
    const before = await played(page, 'footstep');
    await page.keyboard.down('KeyW');
    try {
      await expect.poll(() => played(page, 'footstep'), { timeout: 12_000 }).toBeGreaterThan(before);
    } finally {
      await page.keyboard.up('KeyW');
    }
    const end = await page.evaluate(() => ({ ...window.__escape.game()!.pos }));
    expect(Math.hypot(end.x - start.x, end.z - start.z)).toBeGreaterThan(1);
    await page.waitForTimeout(400);
    const stillSteps = await played(page, 'footstep');
    await page.waitForTimeout(1200);
    expect(await played(page, 'footstep')).toBe(stillSteps);
    await page.evaluate(() => window.__escape.debug('down', 20));
    await expect(page.locator('#down-overlay')).toBeVisible();
    await expect.poll(() => played(page, 'heartbeat')).toBeGreaterThan(0);
    const beats = await played(page, 'heartbeat');
    await expect.poll(() => played(page, 'heartbeat'), { timeout: 3000 }).toBeGreaterThan(beats);
    await page.waitForTimeout(400);
    expect((await sound(page)).activeSources).toBeLessThanOrEqual(9);
    expect(await played(page, 'footstep')).toBe(stillSteps);
    await toggleSettings(page);
    await page.check('#settings-muted');
    await expect.poll(async () => (await sound(page)).activeSources).toBe(0);
    const mutedBeats = await played(page, 'heartbeat');
    await page.waitForTimeout(1200);
    expect(await played(page, 'heartbeat')).toBe(mutedBeats);
    expect(errors).toEqual([]);
    } finally {
      const activationPath = testInfo.outputPath('activation-checkpoints.json');
      await writeFile(activationPath, JSON.stringify(activation));
      await testInfo.attach('activation-checkpoints', { path: activationPath, contentType: 'application/json' });
      await teammate.close();
    }
  });

  test('trusted keys unlock real audio; doors are authoritative, mute is silent, preferences survive reload', async ({ page, browser, baseURL }) => {
    test.setTimeout(180_000);
    const errors = errorsOn(page);
    const guestContext = await browser.newContext({ baseURL, viewport: { width: 480, height: 300 }, deviceScaleFactor: 1 });
    const guest = await guestContext.newPage();
    const guestErrors = errorsOn(guest);
    try {
      await page.goto('/?nodraw');
      await networkEntry(page, '音效甲', undefined, false);
      await expect.poll(() => withoutGesture(page, () => window.__escape.code, undefined)).not.toBe('');
      const code = await withoutGesture(page, () => window.__escape.code, undefined);
      await guest.goto('/?nodraw');
      await networkEntry(guest, '音效乙', code, false);
      await expect.poll(() => withoutGesture(page, () => document.querySelectorAll('#wait-members li').length, undefined)).toBe(2);
      await expect.poll(() => withoutGesture(guest, () => document.querySelectorAll('#wait-members li').length, undefined)).toBe(2);
      await networkStart(page);
      await Promise.all([ready(page), ready(guest)]);
      for (const p of [page, guest]) {
        await locked(p);
        const before = await light(p);
        await p.keyboard.press('KeyF'); // The first in-game gesture must unlock, without direct sound calls.
        await expect.poll(() => light(p)).toBe(!before);
        await expect.poll(() => played(p, 'click')).toBe(1);
        await ambience(p);
      }
      const ambientRms = await signalRms(page);
      expect(ambientRms).toBeGreaterThan(0.00001);
      await test.info().attach('desktop-audio-signal', { body: JSON.stringify({ ambientRms, diagnostics: await sound(page) }), contentType: 'application/json' });

      const door = await page.evaluate(() => {
        const g = window.__escape.game() as unknown as {
          doors: { id: number; x: number; z: number; alongX: boolean; y0?: number }[];
          doorLocked: boolean[]; doorOpen: boolean[];
        };
        const d = g.doors.find((d) => g.doorLocked[d.id] === false && !g.doorOpen[d.id]);
        if (!d) throw new Error('Expected an unlocked closed campus door');
        return { id: d.id, x: d.x, z: d.z, alongX: d.alongX, floor: Math.round((d.y0 ?? 0) / 3.6) };
      });
      for (const [index, p] of [page, guest].entries()) {
        await p.evaluate(({ d, offset }) => window.__escape.debug('tp', d.x + (d.alongX ? 0 : offset),
          d.z + (d.alongX ? offset : 0), d.floor), { d: door, offset: 0.9 + index * 0.25 });
        await expect.poll(() => p.evaluate((d) => {
          const g = window.__escape.game() as unknown as { pos: { x: number; z: number }; body: { y: number } };
          return Math.max(Math.hypot(g.pos.x - d.x, g.pos.z - d.z), Math.abs(g.body.y - d.floor * 3.6));
        }, door), { timeout: 15_000 }).toBeLessThan(1.8);
      }
      // Allow both server position corrections to arrive before the reach-checked request.
      await page.waitForTimeout(300);
      const beforeDoor = await Promise.all([page, guest].map((p) => played(p, 'door')));
      const doorRms = await eventSignalRms(page,
        () => page.evaluate((id) => window.__escape.net.send({ t: 'door', id }), door.id));
      expect(doorRms).toBeGreaterThan(0.00001);
      await test.info().attach('authoritative-door-signal', { body: JSON.stringify({ doorRms }), contentType: 'application/json' });
      for (const [index, p] of [page, guest].entries()) {
        await expect.poll(() => p.evaluate((id) => (window.__escape.game() as unknown as { doorOpen: boolean[] }).doorOpen[id], door.id),
          { timeout: 10_000 }).toBe(true);
        await expect.poll(() => played(p, 'door')).toBe(beforeDoor[index] + 1);
      }
      const snapshots = await page.evaluate(() => window.__escape.game()!.snaps);
      await expect.poll(() => page.evaluate(() => window.__escape.game()!.snaps), { timeout: 10_000 }).toBeGreaterThan(snapshots + 8);
      expect(await played(page, 'door')).toBe(beforeDoor[0] + 1);
      expect(await played(guest, 'door')).toBe(beforeDoor[1] + 1); // Repeated authoritative snapshots cannot replay the creak.

      await toggleSettings(page);
      await page.locator('#settings-volume').press('ArrowLeft');
      await expect.poll(async () => (await sound(page)).volume).toBeCloseTo(0.64, 5);
      await page.check('#settings-muted');
      await expect.poll(async () => (await sound(page)).activeSources).toBe(0);
      expect(await signalRms(page)).toBeLessThan(0.000001);
      await closeDesktopSettings(page);
      const mutedClicks = await played(page, 'click'), mutedLight = await light(page);
      await page.keyboard.press('KeyF');
      await expect.poll(() => light(page)).toBe(!mutedLight);
      expect(await played(page, 'click')).toBe(mutedClicks);
      expect(await sound(page)).toMatchObject({ muted: true, activeSources: 0, ambientSources: 0 });

      await toggleSettings(page);
      await page.uncheck('#settings-muted');
      await page.uncheck('#settings-haptics');
      await closeDesktopSettings(page);
      await page.keyboard.press('KeyF');
      await expect.poll(() => played(page, 'click')).toBe(mutedClicks + 1);
      await ambience(page);
      await toggleSettings(page);
      await settingsShot(page, 'test-results/feedback-desktop.png');
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('escape.feedback')!)))
        .toEqual({ volume: 0.64, muted: false, haptics: false });

      await page.reload();
      await networkEntry(page, '音效复测');
      await ready(page);
      await locked(page);
      expect(await page.evaluate(() => (window.__escape.game() as unknown as { feedbackSettings: { preferences: unknown } }).feedbackSettings.preferences))
        .toEqual({ volume: 0.64, muted: false, haptics: false });
      expect(errors).toEqual([]);
      expect(guestErrors).toEqual([]);
    } finally {
      await guestContext.close();
    }
  });
});

test.describe('touch feedback', () => {
  const { defaultBrowserType: _browserType, ...iphone } = devices['iPhone 13 landscape'];
  test.use({ ...iphone, reducedMotion: 'no-preference' });

  test('real flashlight taps unlock audio; vibration API obeys reduced motion and saved opt-out', async ({ page }) => {
    test.setTimeout(150_000);
    const errors = errorsOn(page);
    // API simulation only: these records establish browser requests, never physical hardware vibration.
    await page.addInitScript(() => {
      const records: (number | number[])[] = [];
      (window as unknown as { __vibrationRequests: (number | number[])[] }).__vibrationRequests = records;
      Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (pattern: number | number[]) => {
        records.push(Array.isArray(pattern) ? [...pattern] : pattern);
        return true;
      } });
    });
    const vibrations = () => page.evaluate(() =>
      (window as unknown as { __vibrationRequests: (number | number[])[] }).__vibrationRequests
        .filter((p) => Array.isArray(p) ? p.some((n) => n > 0) : p > 0).length);
    const vibrationCalls = () => page.evaluate(() =>
      (window as unknown as { __vibrationRequests: (number | number[])[] }).__vibrationRequests.length);
    const flashlight = '.touch-btn:has-text("手电")';
    await solo(page, '触控音效');
    await locked(page);
    await expect(page.locator('#touch')).toBeVisible();
    const firstLight = await light(page);
    await page.tap(flashlight); // Genuine Chromium touchscreen event, including the first gesture unlock.
    await expect.poll(() => light(page)).toBe(!firstLight);
    await expect.poll(() => played(page, 'click')).toBe(1);
    await expect.poll(vibrations).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
    await ambience(page);
    const ambientRms = await signalRms(page);
    expect(ambientRms).toBeGreaterThan(0.00001);
    await test.info().attach('touch-audio-signal', { body: JSON.stringify({ ambientRms, diagnostics: await sound(page) }), contentType: 'application/json' });

    await toggleSettings(page, true);
    await expect(page.locator('#game-settings')).toHaveAttribute('open', '');
    const beforeControls = await page.evaluate(() => {
      const g = window.__escape.game() as unknown as { input: { yaw: number; keys: Set<string> }; pos: { x: number; z: number } };
      return { x: g.pos.x, z: g.pos.z, yaw: g.input.yaw };
    });
    await page.tap('#settings-muted');
    await expect(page.locator('#settings-muted')).toBeChecked();
    await expect.poll(async () => (await sound(page)).activeSources).toBe(0);
    await toggleSettings(page, true);
    const mutedClicks = await played(page, 'click'), mutedLight = await light(page);
    await page.tap(flashlight);
    await expect.poll(() => light(page)).toBe(!mutedLight);
    expect(await played(page, 'click')).toBe(mutedClicks);
    expect(await sound(page)).toMatchObject({ muted: true, ambientSources: 0, activeSources: 0 });
    expect(await page.evaluate(() => {
      const g = window.__escape.game() as unknown as { input: { yaw: number; keys: Set<string> }; pos: { x: number; z: number } };
      return { x: g.pos.x, z: g.pos.z, yaw: g.input.yaw, keys: [...g.input.keys] };
    })).toEqual({ ...beforeControls, keys: [] });

    await toggleSettings(page, true);
    await page.tap('#settings-muted');
    await toggleSettings(page, true);
    const clickRms = await eventSignalRms(page, () => page.tap(flashlight));
    expect(clickRms).toBeGreaterThan(0.00001);
    await test.info().attach('touch-flashlight-signal', { body: JSON.stringify({ clickRms }), contentType: 'application/json' });
    await expect.poll(() => played(page, 'click')).toBe(mutedClicks + 1);
    await ambience(page);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(450); // Beyond the toggle rate limit: suppression must come from the media preference.
    const reducedCalls = await vibrationCalls(), reducedClicks = await played(page, 'click');
    await page.tap(flashlight);
    await expect.poll(() => played(page, 'click')).toBe(reducedClicks + 1);
    expect(await vibrationCalls()).toBe(reducedCalls);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await toggleSettings(page, true);
    await page.tap('#settings-haptics');
    await page.locator('#settings-volume').press('ArrowLeft');
    await expect(page.locator('#settings-haptics')).not.toBeChecked();
    await toggleSettings(page, true);
    await page.waitForTimeout(450);
    const disabledCalls = await vibrationCalls(), disabledClicks = await played(page, 'click');
    await page.tap(flashlight);
    await expect.poll(() => played(page, 'click')).toBe(disabledClicks + 1);
    expect(await vibrationCalls()).toBe(disabledCalls);
    await toggleSettings(page, true);
    await settingsShot(page, 'test-results/feedback-touch.png');

    await page.reload();
    await networkEntry(page, '触控复测');
    await ready(page);
    await locked(page);
    expect(await page.evaluate(() => (window.__escape.game() as unknown as { feedbackSettings: { preferences: unknown } }).feedbackSettings.preferences))
      .toEqual({ volume: 0.64, muted: false, haptics: false });
    await page.tap(flashlight);
    await expect.poll(() => played(page, 'click')).toBe(1);
    expect(await vibrationCalls()).toBe(0); // Saved opt-out is applied before the first gesture of the new game.

    await page.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); });
    const boundsSession = await page.context().newCDPSession(page);
    const { windowId } = await boundsSession.send('Browser.getWindowForTarget');
    await boundsSession.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await boundsSession.detach();
    await page.setViewportSize({ width: 640, height: 240 });
    await toggleSettings(page, true);
    const panel = page.locator('#game-settings');
    const bounds = await panel.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(228);
    const targets = await panel.locator('summary, input[type="range"], .settings-check').evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().height));
    expect(targets.every((height) => height >= 44)).toBe(true);
    const session = await page.context().newCDPSession(page);
    try {
      const x = Math.round(bounds!.x + bounds!.width - 16), y = Math.round(bounds!.y + bounds!.height - 16);
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let step = 1; step <= 6; step++) {
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 18 }] });
      }
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await session.detach();
    }
    await expect.poll(() => panel.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(page.locator('#settings-haptics')).toBeInViewport({ ratio: 1 });
    await expect(page.locator('#settings-open')).toBeInViewport({ ratio: 1 });
    await page.tap('#settings-haptics');
    await expect(page.locator('#settings-haptics')).toBeChecked();
    await toggleSettings(page, true);
    await expect(panel).not.toHaveAttribute('open');
    await shot(page, 'test-results/feedback-short-touch.png');
    expect(errors).toEqual([]);
  });
});
