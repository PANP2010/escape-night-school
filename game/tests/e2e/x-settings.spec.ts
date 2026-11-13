import { RESUME_KEY } from '../../client/src/reconnect.ts';
import { devices, expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { browserArgs } from '../browser-args.mjs';
import { showCanvas } from './draw';
import { settingsShot } from './settings-controls.ts';

// Keep native capture and silent audio verification consistent under either Playwright config.
test.use({
  headless: process.platform !== 'darwin',
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  launchOptions: { args: browserArgs(['--mute-audio', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']) },
});

const errorsOn = (page: Page) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
};

async function startSolo(page: Page, name: string) {
  await page.fill('#name', name);
  await page.click('#create');
  await page.click('#start');
  await expect(page.locator('#hud')).toBeVisible({ timeout: 40_000 });
  await expect.poll(() => page.evaluate(() => !!window.__escape.game()?.presentationReady && !window.__escape.game()?.intro.active),
    { timeout: 30_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__escape.game()?.snaps ?? 0),
    { timeout: 15_000 }).toBeGreaterThan(2);
  await page.evaluate(() => {
    window.__escape.debug('safe', 180, 1);
    window.__escape.debug('safe', 180, 2);
  });
}

async function solo(page: Page, name: string) {
  if (page.url().startsWith('http')) await page.evaluate(key => sessionStorage.removeItem(key), RESUME_KEY);
  await page.goto('/?nodraw&steady');
  await startSolo(page, name);
}

async function tapRangeEnd(page: Page, selector: string, end: 'min' | 'max') {
  const range = page.locator(selector);
  await range.scrollIntoViewIfNeeded();
  const box = await range.boundingBox();
  if (!box) throw new Error(`Expected a visible range: ${selector}`);
  await range.tap({ position: { x: end === 'min' ? 1 : box.width - 1, y: box.height / 2 } });
}

const state = (page: Page) => page.evaluate(() => {
  const g = window.__escape.game()!;
  return { x: g.pos.x, z: g.pos.z, yaw: g.input.yaw, keys: [...g.input.keys],
    movement: ['KeyW', 'KeyA', 'KeyS', 'KeyD'].filter(key => g.input.down(key)),
    corrections: g.corrections,
    enabled: g.input.enabled, settings: g.settings.preferences,
    sensitivity: g.input.sensitivity, pixelRatio: g.renderer.getPixelRatio(), light: g.light,
    feedback: g.feedbackSettings.preferences, sound: { volume: g.sound.diagnostics.volume, muted: g.sound.diagnostics.muted } };
});

const pointerLockState = (page: Page) => page.evaluate(() => {
  const g = window.__escape.game()!;
  const canvas = g.renderer.domElement, box = canvas.getBoundingClientRect();
  const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  return { locked: document.pointerLockElement?.tagName ?? null, enabled: g.input.enabled,
    pointerLock: g.input.pointerLock, settingsOpen: g.settings.isOpen, canControl: g.canControl,
    presentationReady: g.presentationReady, fadeUntil: (g as any).fadeUntil,
    now: performance.now(), fadeHidden: document.getElementById('fade-overlay')?.hidden,
    focused: document.hasFocus(), visibility: document.visibilityState, bodyClass: document.body.className,
    activeElement: document.activeElement?.tagName, hit: hit && { tag: hit.tagName, id: hit.id },
    events: JSON.parse(canvas.dataset.settingsPointerLockProbe ?? '[]') as unknown[] };
});

async function initialPointerLock(page: Page) {
  await showCanvas(page, true);
  await page.evaluate(() => {
    const canvas = window.__escape.game()!.renderer.domElement;
    const events: Record<string, unknown>[] = [];
    const record = (kind: string, detail?: unknown) => {
      events.push({ kind, detail, focused: document.hasFocus(),
        activation: navigator.userActivation.isActive, time: performance.now() });
      canvas.dataset.settingsPointerLockProbe = JSON.stringify(events);
    };
    canvas.addEventListener('click', (event) => record('click', { trusted: event.isTrusted }), true);
    document.addEventListener('pointerlockerror', () => record('pointerlockerror'));
    const request = canvas.requestPointerLock.bind(canvas);
    canvas.requestPointerLock = (...args: Parameters<typeof request>) => {
      record('request');
      try {
        const result = request(...args);
        void result?.then(() => record('resolved'), (error: unknown) => record('rejected',
          error instanceof Error ? { name: error.name, message: error.message } : String(error)));
        return result;
      } catch (error) {
        record('threw', error instanceof Error ? { name: error.name, message: error.message } : String(error));
        throw error;
      }
    };
  });
  const beforeFocus = await pointerLockState(page);
  let beforeClick: Awaited<ReturnType<typeof pointerLockState>> | null = null;
  try {
    await page.bringToFront();
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.canControl
      && document.getElementById('fade-overlay')!.hidden)).toBe(true);
    beforeClick = await pointerLockState(page);
    await page.locator('body > canvas').click();
    await expect.poll(() => pointerLockState(page)).toMatchObject({ locked: 'CANVAS' });
  } finally {
    await writeFile('test-results/settings-pointer-lock.json', JSON.stringify({ beforeFocus, beforeClick,
      afterClick: await pointerLockState(page) }, null, 2));
  }
}

test('desktop unified settings restore input and preserve compatible audio storage across reload', async ({ page }) => {
  const errors = errorsOn(page);
  await solo(page, '设置桌面');
  await initialPointerLock(page);

  // Chromium may consume Escape to release real pointer lock without a DOM keydown.
  await page.keyboard.down('KeyW');
  await page.keyboard.press('Escape');
  await expect(page.locator('#game-settings')).toBeVisible();
  expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
  await page.keyboard.up('KeyW'); // A release inside the panel must not leave movement held on resume.
  expect((await state(page)).keys).toEqual([]);
  await expect(page.locator('#settings-close')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#settings-postprocessing')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#settings-close')).toBeFocused();
  const before = await state(page);
  await page.keyboard.press('KeyF');
  await page.keyboard.press('KeyW');
  await page.waitForTimeout(200);
  expect(await state(page)).toMatchObject({ x: before.x, z: before.z, light: before.light, keys: [] });

  await page.locator('#settings-sensitivity').press('End');
  await expect.poll(async () => (await state(page)).sensitivity).toBeCloseTo(0.0022 * 2.5, 8);
  await page.locator('#settings-pixel-ratio').selectOption('1');
  await expect.poll(async () => (await state(page)).pixelRatio).toBe(1);
  await page.locator('#settings-pixel-ratio').selectOption('1.5');
  await expect.poll(async () => (await state(page)).pixelRatio).toBe(1.5);
  await page.locator('#settings-postprocessing').uncheck();
  await expect(page.locator('#jasmine')).toHaveAttribute('data-quality', 'low');
  await expect(page.locator('#jasmine')).not.toHaveAttribute('hidden');
  await page.locator('#settings-volume').press('Home');
  await expect.poll(async () => (await state(page)).sound.volume).toBe(0);
  await page.locator('#settings-volume').press('ArrowRight');
  await page.locator('#settings-muted').check();
  await page.locator('#settings-haptics').uncheck();
  expect((await state(page)).feedback).toEqual({ volume: 0.01, muted: true, haptics: false });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('escape.feedback')!)))
    .toEqual({ volume: 0.01, muted: true, haptics: false });
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('escape.settings')!)))
    .toEqual({ sensitivity: 2.5, pixelRatio: 1.5, postprocessing: false, interactionHighlights: true });
  await settingsShot(page, 'test-results/settings-desktop.png');

  await page.locator('#settings-close').click();
  await expect(page.locator('#game-settings')).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.pointerLockElement?.tagName)).toBe('CANVAS');
  expect(await state(page)).toMatchObject({ keys: [], movement: [] });
  // Drain authoritative snapshots for movement sent before Escape, then measure fresh resting frames.
  const resumeSnaps = await page.evaluate(() => window.__escape.game()!.snaps);
  await expect.poll(() => page.evaluate(() => window.__escape.game()!.snaps)).toBeGreaterThan(resumeSnaps + 3);
  const resumed = await state(page);
  await page.waitForTimeout(450);
  const resting = await state(page);
  expect(Math.hypot(resting.x - resumed.x, resting.z - resumed.z)).toBeLessThan(0.03);
  expect(resting.keys).toEqual([]);
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(250);
  await page.keyboard.up('KeyW');
  await expect.poll(async () => {
    const current = await state(page);
    return Math.hypot(current.x - resting.x, current.z - resting.z);
  }).toBeGreaterThan(0.1);
  expect((await state(page)).keys).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.locator('#game-settings')).toBeVisible();
  // Chrome reserves a short cooldown after browser Escape before another capture gesture.
  await page.waitForTimeout(1_100);
  await page.locator('#settings-close').click();
  await expect.poll(() => page.evaluate(() => document.pointerLockElement?.tagName)).toBe('CANVAS');

  // All audio changes remain available through the one settings entry.
  await page.keyboard.press('Escape');
  await expect(page.locator('#game-settings')).toBeVisible();
  await expect(page.locator('#feedback-settings')).toHaveCount(0);
  await expect(page.locator('#settings-open')).toHaveCount(1);
  await expect(page.locator('#settings-volume')).toHaveValue('0.01');
  await page.locator('#settings-volume').press('ArrowRight');
  await page.locator('#settings-muted').uncheck();
  expect((await state(page)).sound).toEqual({ volume: 0.02, muted: false });

  // A native close event is queued. It must not close a dialog reopened in that same task.
  await page.evaluate(() => {
    const settings = window.__escape.game()!.settings;
    settings.close();
    settings.open();
  });
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await expect(page.locator('#game-settings')).toBeVisible();
  expect(await page.evaluate(() => ({ open: window.__escape.game()!.settings.isOpen,
    enabled: window.__escape.game()!.input.enabled }))).toEqual({ open: true, enabled: false });
  await page.locator('#settings-close').click();
  await expect(page.locator('#game-settings')).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.pointerLockElement?.tagName)).toBe('CANVAS');

  await page.evaluate(key => sessionStorage.removeItem(key), RESUME_KEY);
  await page.reload();
  await startSolo(page, '设置恢复');
  const restored = await state(page);
  expect(restored).toMatchObject({ sensitivity: 0.0022 * 2.5, pixelRatio: 1.5,
    feedback: { volume: 0.02, muted: false, haptics: false }, sound: { volume: 0.02, muted: false } });
  await page.locator('#settings-open').click();
  await expect(page.locator('#settings-sensitivity')).toHaveValue('2.5');
  await expect(page.locator('#settings-postprocessing')).not.toBeChecked();
  await expect(page.locator('#jasmine')).toHaveAttribute('data-quality', 'low');
  await expect(page.locator('#jasmine')).not.toHaveAttribute('hidden');
  await page.keyboard.press('Escape');
  await expect(page.locator('#game-settings')).toBeHidden();
  await expect(page.locator('#settings-open')).toBeFocused();
  await showCanvas(page, true);
  await page.locator('body > canvas').click();
  await expect.poll(() => page.evaluate(() => document.pointerLockElement?.tagName)).toBe('CANVAS');
  expect((await state(page)).keys).toEqual([]);
  expect(errors).toEqual([]);
});

test('interaction highlight opt-out survives chapter replacement and a new session', async ({ page }) => {
  const errors = errorsOn(page);
  await solo(page, '高亮偏好');
  const aimAtBattery = () => page.evaluate(() => {
    const g = window.__escape.game()!;
    const item = (g as any).items.find((entry: any) => entry.kind === 'battery')!;
    g.view = { x: item.p[0] + 2, y: item.p[1] + 1.2, z: item.p[2], yaw: Math.PI / 2, pitch: -0.45 };
    g.body.y = item.p[1];
    return item.id;
  });
  const active = () => page.evaluate(() => window.__escape.game()!.interactionHighlight.snapshot().active);
  const first = await aimAtBattery();
  await expect.poll(active).toEqual(expect.arrayContaining([expect.objectContaining({ key: `pick:${first}` })]));
  await page.locator('#settings-open').click();
  await page.locator('#settings-interaction-highlights').uncheck();
  await page.keyboard.press('Escape');
  await expect(page.locator('#game-settings')).toBeHidden();
  await page.waitForTimeout(250);
  expect(await active()).toEqual([]);
  await page.evaluate(() => window.__escape.debug('level', 1));
  await expect.poll(() => page.evaluate(() => {
    const g = window.__escape.game();
    return g?.level.index === 1 && g.presentationReady && !g.intro.active;
  }), { timeout: 30_000 }).toBe(true);
  await aimAtBattery();
  await page.waitForTimeout(250);
  expect((await state(page)).settings.interactionHighlights).toBe(false);
  expect(await active()).toEqual([]);
  await solo(page, '高亮偏好保留');
  const restored = await aimAtBattery();
  await page.waitForTimeout(250);
  expect((await state(page)).settings.interactionHighlights).toBe(false);
  expect(await active()).toEqual([]);
  await page.locator('#settings-open').click();
  await expect(page.locator('#settings-interaction-highlights')).not.toBeChecked();
  await page.locator('#settings-interaction-highlights').check();
  await page.keyboard.press('Escape');
  await expect.poll(active).toEqual(expect.arrayContaining([expect.objectContaining({ key: `pick:${restored}` })]));
  expect(errors).toEqual([]);
});

test.describe('phone settings', () => {
  const { defaultBrowserType: _browserType, ...iphone } = devices['iPhone 13 landscape'];
  test.use({ ...iphone });

  test('safe-area controls close cleanly and return touch look and interaction to the game', async ({ page }) => {
    const errors = errorsOn(page);
    const safeArea = { top: 28, left: 64, right: 0, bottom: 21 };
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: safeArea });
    await solo(page, '设置触屏');
    const open = page.locator('#settings-open');
    await expect(open).toBeVisible();
    const entry = await open.boundingBox();
    expect(entry).not.toBeNull();
    expect(entry!.height).toBeGreaterThanOrEqual(44);
    expect(entry!.x).toBeGreaterThanOrEqual(safeArea.left);
    expect(entry!.y).toBeGreaterThanOrEqual(safeArea.top);
    await open.tap();
    await expect(page.locator('#game-settings')).toBeVisible();
    expect((await state(page)).pixelRatio).toBe(1);
    await expect(page.locator('#settings-postprocessing')).not.toBeChecked();
    const panel = await page.locator('#game-settings').boundingBox();
    expect(panel).not.toBeNull();
    const viewport = page.viewportSize()!;
    expect(panel!.x).toBeGreaterThanOrEqual(safeArea.left);
    expect(panel!.y).toBeGreaterThanOrEqual(safeArea.top);
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(viewport.width - 12);
    expect(panel!.y + panel!.height).toBeLessThanOrEqual(viewport.height - safeArea.bottom);
    const textSizes = await page.locator('#game-settings .settings-note, #game-settings .settings-footer')
      .evaluateAll((nodes) => nodes.map((node) => Number.parseFloat(getComputedStyle(node).fontSize)));
    expect(textSizes.every((size) => size >= 14)).toBe(true);
    const before = await state(page);
    await tapRangeEnd(page, '#settings-volume', 'min');
    await expect(page.locator('#settings-volume')).toHaveValue('0');
    await tapRangeEnd(page, '#settings-sensitivity', 'max');
    await expect(page.locator('#settings-sensitivity')).toHaveValue('2.5');
    await page.locator('#settings-pixel-ratio').selectOption('1.5');
    await expect.poll(async () => (await state(page)).pixelRatio).toBe(1.5);
    await page.locator('#settings-muted').tap();
    await page.locator('#settings-haptics').tap();
    await page.locator('#settings-postprocessing').tap();
    await expect(page.locator('#jasmine')).not.toHaveAttribute('hidden');
    expect((await state(page)).feedback).toEqual({ volume: 0, muted: true, haptics: false });
    expect(await state(page)).toMatchObject({ x: before.x, z: before.z, yaw: before.yaw, keys: [], light: before.light });
    await settingsShot(page, 'test-results/settings-mobile.png');
    await page.locator('#settings-close').tap();
    await expect(page.locator('#game-settings')).toBeHidden();
    expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();

    const look = await page.locator('#touch-look').boundingBox();
    if (!look) throw new Error('Expected the existing right touch-look surface');
    const x = Math.round(look.x + look.width * 0.35), y = Math.round(look.y + look.height * 0.3);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 60, y, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(async () => Math.abs((await state(page)).yaw - before.yaw)).toBeGreaterThan(0.2);
    const light = (await state(page)).light;
    await page.locator('.touch-btn', { hasText: '手电' }).tap();
    await expect.poll(async () => (await state(page)).light).toBe(!light);
    // This branch retains the existing interaction button; direct object tapping is integrated elsewhere.
    const itemId = await page.evaluate(() => {
      const g = window.__escape.game() as any;
      const candidates = g.items.filter((item: any) => item.kind === 'door_key' && !g.gone?.has(item.id));
      const key = candidates.reduce((a: any, b: any) =>
        Math.hypot(a.p[0] - g.pos.x, a.p[2] - g.pos.z) < Math.hypot(b.p[0] - g.pos.x, b.p[2] - g.pos.z) ? a : b);
      window.__escape.debug('tp', key.p[0] + 0.8, key.p[2]);
      return key.id as number;
    });
    await expect.poll(() => page.evaluate((id) => {
      const g = window.__escape.game() as any;
      const key = g.items.find((item: any) => item.id === id);
      return Math.hypot(key.p[0] - g.pos.x, key.p[2] - g.pos.z);
    }, itemId), { timeout: 15_000 }).toBeLessThan(1.2);
    await page.evaluate((id) => {
      const g = window.__escape.game() as any;
      const key = g.items.find((item: any) => item.id === id);
      const dx = key.p[0] - g.pos.x, dz = key.p[2] - g.pos.z;
      g.input.yaw = Math.atan2(-dx, -dz);
      g.input.pitch = Math.atan2(key.p[1] + 0.6 - (g.body.y + g.eye), Math.hypot(dx, dz));
    }, itemId);
    await expect(page.locator('#prompt')).toContainText('拾取', { timeout: 20_000 });
    await page.locator('.touch-btn.main', { hasText: '互动' }).tap();
    await expect(page.locator('#keys')).toContainText('钥匙 ×1', { timeout: 15_000 });
    expect((await state(page)).keys).toEqual([]);

    await page.evaluate(key => sessionStorage.removeItem(key), RESUME_KEY);
    await page.reload();
    await startSolo(page, '触屏恢复');
    expect(await state(page)).toMatchObject({ enabled: true, sensitivity: 0.0022 * 2.5, pixelRatio: 1.5,
      settings: { sensitivity: 2.5, pixelRatio: 1.5, postprocessing: true },
      feedback: { volume: 0, muted: true, haptics: false }, sound: { volume: 0, muted: true } });
    await open.tap();
    await expect(page.locator('#settings-sensitivity')).toHaveValue('2.5');
    await expect(page.locator('#settings-volume')).toHaveValue('0');
    await expect(page.locator('#settings-muted')).toBeChecked();
    await expect(page.locator('#settings-haptics')).not.toBeChecked();
    await expect(page.locator('#settings-postprocessing')).toBeChecked();
    await page.locator('#settings-close').tap();
    await expect(page.locator('#game-settings')).toBeHidden();
    expect((await state(page)).enabled).toBe(true);
    expect(await page.evaluate(() => document.pointerLockElement)).toBeNull();
    await cdp.detach();
    expect(errors).toEqual([]);
  });
});
