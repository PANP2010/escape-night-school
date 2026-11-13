import { devices, expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { frame } from './draw.ts';
import { FeedbackPeer } from '../team-feedback-peer.ts';

const evidence = 'test-results/tutorial-ping/evidence';
const nickname = '夜校同学甲乙丙丁戊己庚辛壬癸';
type Wire = Record<string, unknown>;
let captureEvidence = false;

function watch(page: Page) {
  const sent: Wire[] = [], received: Wire[] = [], errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('websocket', ws => {
    ws.on('framesent', f => { try { sent.push(JSON.parse(String(f.payload))); } catch { /* binary frame */ } });
    ws.on('framereceived', f => { try { received.push(JSON.parse(String(f.payload))); } catch { /* binary frame */ } });
  });
  return { sent, received, errors };
}

async function capture(page: Page, name: string) {
  if (!captureEvidence) return;
  await frame(page);
  // Wait for image decode and compositor presentation on mobile DPR as well.
  await page.evaluate(async () => {
    await (document.getElementById('e2e-shot') as HTMLImageElement | null)?.decode();
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await page.screenshot({ path: `${evidence}/${name}.png` });
  await page.evaluate(() => document.getElementById('e2e-shot')?.remove());
}

async function create(page: Page, name = nickname) {
  await page.goto('/?steady');
  await page.fill('#name', name);
  if (captureEvidence) await page.screenshot({ path: `${evidence}/${page.viewportSize()!.width > 900 ? 'desktop' : 'phone-landscape'}-lobby.png` });
  await page.locator('#create').click();
  await expect(page.locator('#wait-code')).not.toBeEmpty();
  await page.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); });
}

async function ready(page: Page) {
  await page.waitForFunction(() => (window.__escape.game() as unknown as { spawnSynced: boolean } | null)?.spawnSynced);
  await page.waitForFunction(() => window.__escape.game()!.openingComplete && !window.__escape.game()!.intro.active);
  await page.evaluate(() => window.__escape.debug('safe', 600));
  await expect(page.locator('#fade-overlay')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('#banner')).toBeHidden({ timeout: 20_000 });
}

async function inputRestored(page: Page) {
  await expect(page.locator('#chat-input')).toBeHidden();
  expect(await page.evaluate(() => ({ enabled: window.__escape.game()!.input.enabled, keys: [...window.__escape.game()!.input.keys] })))
    .toEqual({ enabled: true, keys: [] });
}

async function openChat(page: Page, mobile: boolean) {
  if (mobile) { await page.locator('#touch-chat').tap(); return; }
  // Start/settings buttons intentionally retain their native Enter activation. Give the world focus first.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Enter');
  await expect(page.locator('#chat-input')).toBeVisible();
}

async function chatRegression(page: Page, wire: ReturnType<typeof watch>, mobile: boolean) {
  const open = () => openChat(page, mobile);
  await open();
  await expect(page.locator('#chat-input')).toBeVisible();
  await page.locator('#chat-input').fill('中文输入法候选');
  const before = wire.sent.filter(m => m.t === 'chat').length;
  const pings = wire.sent.filter(m => m.t === 'ping').length;
  await page.keyboard.press('KeyQ');
  await page.waitForTimeout(100);
  expect(wire.sent.filter(m => m.t === 'ping')).toHaveLength(pings);
  await page.locator('#chat-input').evaluate(el => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '候选' }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229, bubbles: true }));
  });
  await expect(page.locator('#chat-input')).toBeVisible();
  expect(wire.sent.filter(m => m.t === 'chat')).toHaveLength(before);
  await page.locator('#chat-input').evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '候选' })));
  await page.keyboard.press('Escape');
  await inputRestored(page);
  expect(wire.sent.filter(m => m.t === 'chat')).toHaveLength(before);
  await open();
  await page.locator('#chat-input').fill('夜校联机测试：发送后恢复操作');
  await page.locator('#chat-send').click();
  await inputRestored(page);
  await expect.poll(() => wire.sent.filter(m => m.t === 'chat').length).toBe(before + 1);
  await expect(page.locator('#chat-log')).toContainText('发送后恢复操作');
  // Keyboard focus can leave chat without a pointer event before settings opens.
  await open();
  await page.locator('#settings-open').focus();
  await inputRestored(page);
  await page.keyboard.press('Enter');
  await expect(page.locator('#game-settings')).toHaveAttribute('open', '');
  await page.keyboard.press('Escape');
  await expect(page.locator('#game-settings')).not.toHaveAttribute('open', '');
  expect(await page.evaluate(() => window.__escape.game()!.input.enabled)).toBe(true);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

async function keyboardViewport(page: Page, rect?: { width: number; height: number; offsetLeft: number; offsetTop: number }) {
  await page.evaluate(value => {
    const vv = window.visualViewport!;
    for (const key of ['width', 'height', 'offsetLeft', 'offsetTop']) {
      if (value) Object.defineProperty(vv, key, { configurable: true, value: value[key as keyof typeof value] });
      else Reflect.deleteProperty(vv, key);
    }
    vv.dispatchEvent(new Event('resize')); vv.dispatchEvent(new Event('scroll'));
  }, rect);
}

async function chatFits(page: Page, rect: { width: number; height: number; offsetLeft: number; offsetTop: number }) {
  const boxes = await page.locator('#chat-panel, #chat-input, #chat-send, #chat-cancel').evaluateAll(els => els.map(el => {
    const r = el.getBoundingClientRect();
    return { id: el.id, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  }));
  for (const b of boxes) {
    expect(b.left, `${b.id} left`).toBeGreaterThanOrEqual(rect.offsetLeft);
    expect(b.right, `${b.id} right`).toBeLessThanOrEqual(rect.offsetLeft + rect.width);
    expect(b.top, `${b.id} top`).toBeGreaterThanOrEqual(rect.offsetTop);
    expect(b.bottom, `${b.id} bottom`).toBeLessThanOrEqual(rect.offsetTop + rect.height);
    if (b.id !== 'chat-input') expect(b.scrollWidth, `${b.id} overflow`).toBeLessThanOrEqual(b.clientWidth);
    if (b.id === 'chat-send' || b.id === 'chat-cancel') {
      expect(b.width).toBeGreaterThanOrEqual(44); expect(b.height).toBeGreaterThanOrEqual(44);
    }
  }
  return boxes;
}

async function noHorizontalOverflow(page: Page, selector: string) {
  const boxes = await page.locator(selector).evaluateAll(els => els.map(el => ({ id: el.id, scroll: el.scrollWidth, client: el.clientWidth })));
  for (const b of boxes) expect(b.scroll, `${b.id} horizontal overflow`).toBeLessThanOrEqual(b.client);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('tutorial, mobile ping, direct world tap and chat viewport evidence', async ({ browser, baseURL }, testInfo) => {
  captureEvidence = testInfo.config.metadata.tutorialEvidence === true;
  test.setTimeout(captureEvidence ? 180_000 : 120_000);
  if (captureEvidence) mkdirSync(evidence, { recursive: true });
  const report: Record<string, unknown> = { environment: {
    browser: browser.version(), phone: 'Playwright iPhone 13 emulation, 844×390 and 390×844',
    keyboard: 'synthetic visualViewport resize and scroll offsets',
    videoReview: 'No external Gemini scoring tool was available',
  } };
  const desktop = await browser.newContext({ baseURL, viewport: { width: 1280, height: 720 },
    ...(captureEvidence ? { recordVideo: { dir: `${evidence}/video`, size: { width: 1280, height: 720 } } } : {}) });
  const dp = await desktop.newPage(), desktopWire = watch(dp);
  await create(dp);
  const desktopPeer = await new FeedbackPeer('桌面救援同学', baseURL!.replace(/^http/, 'ws') + '/ws').connect();
  try {
  desktopPeer.send({ t: 'join', code: await dp.locator('#wait-code').innerText() });
  await desktopPeer.waitMessage(0, 'room');
  await expect(dp.locator('#wait-members li')).toHaveCount(2);
  await dp.locator('#start').click();
  if (captureEvidence) {
    await dp.waitForFunction(() => !!window.__escape.game());
    await dp.evaluate(() => {
      const g = window.__escape.game() as any;
      g.draw = true; g.renderer.domElement.style.visibility = '';
    });
  }
  const introStarted = Date.now();
  await ready(dp);
  desktopPeer.send({ t: 'debug', op: 'safe', s: 600 });
  await expect(dp.locator('#tut')).toContainText('走动');
  await capture(dp, 'desktop-tutorial');
  await dp.keyboard.press('KeyQ');
  await expect.poll(() => desktopWire.received.filter(m => m.t === 'ping').length).toBe(1);
  expect(desktopWire.sent.filter(m => m.t === 'ping')).toHaveLength(1);
  await capture(dp, 'desktop-ping');
  await chatRegression(dp, desktopWire, false);
  await openChat(dp, false);
  await dp.locator('#chat-input').fill('长昵称聊天栏检查：讲台抽屉里找楼梯钥匙');
  await capture(dp, 'desktop-chat');
  await dp.locator('#chat-cancel').click();
  await inputRestored(dp);
  if (captureEvidence && Date.now() - introStarted < 20_000) await dp.waitForTimeout(20_000 - (Date.now() - introStarted));
  await dp.evaluate(() => window.__escape.debug('warden', 2));
  await expect(dp.locator('#down-overlay')).toBeVisible({ timeout: 20_000 });
  await expect(dp.locator('#down-overlay .t')).toHaveText('你被角色074抓住了');
  await expect(dp.locator('#chat-log')).not.toContainText(/你被|回到出生点倒地|无人搀扶/);
  await expect.poll(() => dp.locator('#hint').evaluate(el => el.getAnimations().length)).toBe(0);
  const desktopHint = await dp.evaluate(() => {
    const hint = document.querySelector<HTMLElement>('#hint')!, log = document.querySelector('#chat-log')!;
    const range = document.createRange(); range.selectNodeContents(hint);
    const a = range.getBoundingClientRect(), b = log.getBoundingClientRect();
    return { shown: Number(getComputedStyle(hint).opacity) > 0, logHeight: b.height,
      touch: a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom };
  });
  expect(desktopHint.logHeight).toBeGreaterThan(0); expect(desktopHint.shown).toBe(true); expect(desktopHint.touch).toBe(false);
  await capture(dp, 'desktop-down');
  // Presentation-only fade fixture checks that Enter cannot open hidden chat mid-handoff.
  await dp.evaluate(() => window.__escape.net.onMsg({ t: 'fade', secs: .2, restart: false }));
  await dp.keyboard.press('Enter');
  await expect(dp.locator('#chat-input')).toBeHidden();
  expect(await dp.evaluate(() => window.__escape.game()!.input.enabled)).toBe(true);
  // Presentation-only fixture: real progression is separately covered by level E2E.
  await dp.evaluate(() => window.__escape.net.onMsg({ t: 'complete', level: 3 }));
  await capture(dp, 'desktop-complete');
  expect(await dp.evaluate(() => window.__escape.game()!.input.enabled)).toBe(false);
  report.desktop = { errors: desktopWire.errors, pings: desktopWire.sent.filter(m => m.t === 'ping'), desktopHint };
  expect(desktopWire.errors).toEqual([]);
  } finally { await desktopPeer.close(); await desktop.close(); }

  const { defaultBrowserType: _browser, ...iphone } = devices['iPhone 13 landscape'];
  const phone = await browser.newContext({ ...iphone, baseURL, deviceScaleFactor: 1, viewport: { width: 844, height: 390 } });
  const page = await phone.newPage(), mobileWire = watch(page);
  await create(page);
  const peerContext = await browser.newContext({ baseURL, viewport: { width: 640, height: 400 } });
  const peer = await peerContext.newPage(), peerWire = watch(peer);
  await peer.goto('/?steady');
  await peer.fill('#name', '另一位很长昵称的夜校同学');
  await peer.fill('#code', await page.locator('#wait-code').innerText());
  await peer.locator('#join').click();
  await expect(page.locator('#wait-members li')).toHaveCount(2);
  await noHorizontalOverflow(page, '#wait-members');
  if (captureEvidence) await page.screenshot({ path: `${evidence}/phone-long-name-waiting.png` });
  await page.locator('#start').click();
  await ready(page); await ready(peer);
  await page.bringToFront();
  await expect(page.locator('#tut')).toContainText('拖动走路');
  await capture(page, 'phone-landscape-tutorial');
  const ping = page.locator('#touch-ping');
  await expect(ping).toHaveAccessibleName('标记准星位置，通知队友');
  const boxes = await page.evaluate(() => {
    const rect = (selector: string) => { const r = document.querySelector(selector)!.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    return { ping: rect('#touch-ping'), pad: rect('#touch-btns'), stick: rect('#touch-base') };
  });
  expect(boxes.ping.width).toBeGreaterThanOrEqual(44); expect(boxes.ping.height).toBeGreaterThanOrEqual(44);
  expect(boxes.ping.x + boxes.ping.width).toBeLessThan(boxes.pad.x);
  const actsBeforePing = mobileWire.sent.filter(m => m.t === 'act').length;
  await ping.tap();
  await expect.poll(() => mobileWire.received.filter(m => m.t === 'ping').length).toBe(1);
  await expect.poll(() => peerWire.received.filter(m => m.t === 'ping').length).toBe(1);
  expect(mobileWire.sent.filter(m => m.t === 'ping')).toHaveLength(1);
  expect(mobileWire.sent.filter(m => m.t === 'act')).toHaveLength(actsBeforePing);
  expect(await page.evaluate(() => window.__escape.game()!.input.keys.has('KeyQ'))).toBe(false);
  await expect(page.locator('#chat-log')).toContainText('标记了一个位置');
  await capture(page, 'phone-ping');
  // Native click and keyboard activation each reach the existing Q path once.
  await page.waitForTimeout(1100); await ping.click();
  await expect.poll(() => mobileWire.sent.filter(m => m.t === 'ping').length).toBe(2);
  await page.waitForTimeout(1100); await ping.focus(); await page.keyboard.press('Enter');
  await expect.poll(() => mobileWire.sent.filter(m => m.t === 'ping').length).toBe(3);
  await expect(page.locator('#chat-input')).toBeHidden();

  // Real touch movement, flashlight and crouch remain available beside the new target.
  const cdp = await phone.newCDPSession(page);
  // Face along L1's spawn corridor so the real stick walk does not hit its north wall.
  await page.evaluate(() => { window.__escape.game()!.input.yaw = Math.PI / 2; window.__escape.game()!.input.pitch = 0; });
  const beforeMove = await page.evaluate(() => ({ ...window.__escape.game()!.pos }));
  // Begin above the long-name ping log: its visible rectangle deliberately shields world touches.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: 90, y: 160 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: 90, y: 120 }] });
  await page.waitForTimeout(1150);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => page.evaluate(p => Math.hypot(window.__escape.game()!.pos.x - p.x, window.__escape.game()!.pos.z - p.z), beforeMove)).toBeGreaterThan(3);
  await expect(page.locator('#tut')).toContainText('手电');
  await page.locator('#touch-btns .touch-btn').filter({ hasText: '手电' }).tap();
  await expect(page.locator('#tut')).toContainText('蹲行');
  await page.locator('#touch-btns .touch-btn').filter({ hasText: /^蹲$/ }).tap();
  await expect(page.locator('#tut')).toHaveClass(/done/);
  await capture(page, 'phone-crouch-tutorial');
  await page.locator('#touch-btns .touch-btn').filter({ hasText: /^蹲$/ }).tap();
  await expect(page.locator('#tut')).toContainText('直接点门');

  // Project a real rendered door, tap away from the crosshair and verify server sync.
  const door = await page.evaluate(() => {
    const g = window.__escape.game() as any;
    const a = g.level.def.area;
    const d = g.doors.find((d: any) => {
      const x = d.x + (d.alongX ? 0 : 1.3), z = d.z + (d.alongX ? 1.3 : 0);
      return d.y0 === 0 && !g.regionLocked(d.id) && !g.doorLocked[d.id] && !g.doorOpen[d.id]
        && x > a.x0 + .3 && x < a.x1 - .3 && z > a.z0 + .3 && z < a.z1 - .3;
    });
    if (!d) throw new Error('No closed, unlocked L1 door has an in-bounds approach');
    window.__escape.debug('tp', d.x + (d.alongX ? 0 : 1.3), d.z + (d.alongX ? 1.3 : 0)); return d;
  });
  await expect.poll(() => page.evaluate(d => Math.hypot(window.__escape.game()!.pos.x - d.x - (d.alongX ? 0 : 1.3), window.__escape.game()!.pos.z - d.z - (d.alongX ? 1.3 : 0)), door)).toBeLessThan(.2);
  await page.evaluate(d => { const g = window.__escape.game()!; g.input.yaw = d.alongX ? -.15 : Math.PI / 2 - .15; g.input.pitch = -.08; }, door);
  await page.waitForTimeout(250);
  const doorPoint = await page.evaluate(id => {
    const g = window.__escape.game() as any, m = new window.__escape.THREE.Matrix4();
    g.camera.updateMatrixWorld();
    g.doorMesh.getMatrixAt(id, m); const v = new window.__escape.THREE.Vector3().setFromMatrixPosition(m).project(g.camera);
    return { x: (v.x + 1) * innerWidth / 2, y: (1 - v.y) * innerHeight / 2 };
  }, door.id);
  await capture(page, 'phone-direct-door');
  expect(Math.hypot(doorPoint.x - 422, doorPoint.y - 195)).toBeGreaterThan(30);
  const actionsBeforeDoor = mobileWire.sent.filter(m => m.t === 'act').length;
  await page.touchscreen.tap(doorPoint.x, doorPoint.y);
  await expect.poll(() => page.evaluate(id => window.__escape.game()!.doorOpen[id], door.id)).toBe(true);
  await expect.poll(() => peer.evaluate(id => window.__escape.game()!.doorOpen[id], door.id)).toBe(true);
  expect(mobileWire.sent.filter(m => m.t === 'act')).toHaveLength(actionsBeforeDoor + 1);
  await expect(page.locator('#tut')).toContainText('地图');
  await page.locator('#touch-map').tap();
  await expect(page.locator('#map')).toBeVisible(); await capture(page, 'phone-map'); await page.locator('#touch-map').tap();
  await expect(page.locator('#tut')).toContainText('拿起');
  const item = await page.evaluate(() => {
    const g = window.__escape.game() as any;
    const k = g.items.filter((k: any) => k.kind === 'battery').sort((a: any, b: any) => Math.hypot(a.p[0] - g.pos.x, a.p[2] - g.pos.z) - Math.hypot(b.p[0] - g.pos.x, b.p[2] - g.pos.z))[0];
    window.__escape.debug('tp', k.p[0] + .8, k.p[2]); return k;
  });
  await expect.poll(() => page.evaluate(p => Math.hypot(window.__escape.game()!.pos.x - p[0] - .8, window.__escape.game()!.pos.z - p[2]), item.p)).toBeLessThan(.2);
  await expect.poll(() => page.evaluate(() => { const g = window.__escape.game()!; return Math.hypot(g.camera.position.x - g.pos.x, g.camera.position.z - g.pos.z); })).toBeLessThan(.1);
  await page.evaluate(p => { const g = window.__escape.game()!, dx = p[0] - g.pos.x, dz = p[2] - g.pos.z; g.input.yaw = Math.atan2(-dx, -dz) + .3; g.input.pitch = Math.atan2(p[1] + .07 - g.camera.position.y, Math.hypot(dx, dz)); }, item.p);
  await page.waitForTimeout(250);
  const itemPoint = await page.evaluate(id => { const g = window.__escape.game() as any; g.camera.updateMatrixWorld(); const v = g.itemMeshes.get(id).position.clone().project(g.camera); return { x: (v.x + 1) * innerWidth / 2, y: (1 - v.y) * innerHeight / 2 }; }, item.id);
  await capture(page, 'phone-direct-item'); await page.touchscreen.tap(itemPoint.x, itemPoint.y);
  await expect.poll(() => page.evaluate(id => (window.__escape.game() as any).items.some((k: any) => k.id === id), item.id)).toBe(false);
  await expect.poll(() => peer.evaluate(id => (window.__escape.game() as any).items.some((k: any) => k.id === id), item.id)).toBe(false);
  await chatRegression(page, mobileWire, true);
  // The visible body-level log blocks world touches even after the composer closes.
  await page.evaluate(() => {
    const g = window.__escape.game()!, original = g.input.worldTouch!;
    (window as any).__worldTouches = [];
    g.input.worldTouch = (phase, x, y) => { (window as any).__worldTouches.push({ phase, x, y }); original(phase, x, y); };
  });
  const log = await page.locator('#chat-log').boundingBox();
  expect(log).not.toBeNull();
  await page.touchscreen.tap(log!.x + log!.width / 2, log!.y + log!.height / 2);
  expect(await page.evaluate(() => (window as any).__worldTouches.filter((t: any) => t.phase !== 'release'))).toEqual([]);
  await page.touchscreen.tap(log!.x + log!.width + 8, log!.y + log!.height / 2);
  expect(await page.evaluate(() => (window as any).__worldTouches.filter((t: any) => t.phase !== 'release').map((t: any) => t.phase))).toEqual(['start', 'tap']);

  // A tap outside chat cancels the composer, then performs the button's action once.
  await page.locator('#touch-chat').tap();
  const pingsBeforeChat = mobileWire.sent.filter(m => m.t === 'ping').length;
  await ping.tap();
  await inputRestored(page);
  await expect.poll(() => mobileWire.sent.filter(m => m.t === 'ping').length).toBe(pingsBeforeChat + 1);
  await page.locator('#touch-chat').tap();
  await page.locator('#chat-input').fill('横屏键盘下仍能发送和取消，长昵称不越界');
  const landscapeKeyboard = { height: 205, width: 804, offsetTop: 12, offsetLeft: 16 };
  await keyboardViewport(page, landscapeKeyboard);
  await expect.poll(() => page.locator('#chat-panel').evaluate(el => el.getBoundingClientRect().bottom)).toBeLessThanOrEqual(217);
  const landscapeChat = await chatFits(page, landscapeKeyboard);
  await capture(page, 'phone-keyboard-viewport');
  await page.locator('#chat-send').tap(); await inputRestored(page);
  await noHorizontalOverflow(page, '#chat-log, #chat-panel');

  // A keyboard can change the media orientation; an already open chat stays usable.
  await page.locator('#touch-chat').tap();
  await page.setViewportSize({ width: 390, height: 844 });
  const portraitKeyboard = { width: 366, height: 460, offsetLeft: 8, offsetTop: 24 };
  await keyboardViewport(page, portraitKeyboard);
  await expect(page.locator('#rotate')).toBeHidden();
  await page.locator('#chat-input').fill('竖屏键盘里取消后返回横屏');
  const portraitChat = await chatFits(page, portraitKeyboard);
  await capture(page, 'phone-portrait-keyboard');
  await page.locator('#chat-cancel').tap(); await inputRestored(page);
  await keyboardViewport(page);
  report.rotation = await page.evaluate(() => ({
    viewport: [innerWidth, innerHeight], screen: [screen.width, screen.height],
    portrait: matchMedia('(orientation: portrait)').matches, coarse: matchMedia('(pointer: coarse)').matches,
    body: document.body.className, rotate: getComputedStyle(document.getElementById('rotate')!).display,
    fullscreen: !!document.fullscreenElement, complete: document.querySelector('#fade-overlay.complete:not([hidden])') !== null,
  }));
  await expect(page.locator('#rotate')).toBeVisible();
  await capture(page, 'phone-portrait');
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator('#rotate')).toBeHidden();
  await page.locator('#touch-chat').tap();
  await page.locator('#chat-input').fill('旋转返回横屏后发送成功');
  await page.locator('#chat-send').tap(); await inputRestored(page);
  await expect(peer.locator('#chat-log')).toContainText('旋转返回横屏后发送成功');
  await page.waitForTimeout(1100);
  const pingsBeforeRotate = mobileWire.sent.filter(m => m.t === 'ping').length;
  await ping.tap();
  await expect.poll(() => mobileWire.sent.filter(m => m.t === 'ping').length).toBe(pingsBeforeRotate + 1);

  // Server-driven punishment remains readable beside passive long-name chat.
  await page.evaluate(() => window.__escape.debug('down', 90));
  await expect(page.locator('#down-overlay')).toBeVisible();
  await capture(page, 'phone-down');
  await page.setViewportSize({ width: 400, height: 225 });
  await capture(page, 'small-down');
  const down = await page.locator('#down-overlay .n').boundingBox();
  const passiveChat = await page.locator('#chat-panel').boundingBox();
  const smallPing = await ping.boundingBox();
  expect(down).not.toBeNull(); expect(passiveChat).not.toBeNull(); expect(smallPing).not.toBeNull();
  expect(down!.y + down!.height).toBeLessThanOrEqual(passiveChat!.y);
  expect(passiveChat!.x + passiveChat!.width).toBeLessThan(smallPing!.x);
  await noHorizontalOverflow(page, '#down-overlay, #chat-log');

  // Presentation fixture only; actual completion is covered by the level progression specs.
  await page.evaluate(() => window.__escape.net.onMsg({ t: 'complete', level: 3 }));
  await expect(page.locator('#fade-overlay')).toBeVisible();
  await expect(page.locator('#touch')).toBeHidden();
  await expect(page.locator('#hud')).toBeHidden();
  await expect(page.locator('#game-settings')).toBeHidden();
  await capture(page, 'small-complete');
  await noHorizontalOverflow(page, '#fade-overlay, #result-copy');
  const result = await page.locator('#result-copy').evaluate(el => ({ scroll: el.scrollHeight, height: el.clientHeight, width: el.scrollWidth, clientWidth: el.clientWidth }));
  expect(result.width).toBeLessThanOrEqual(result.clientWidth);
  // A panned viewport can leave less room than this short chapter-complete copy.
  // Constrain only the visual viewport, then verify the real scroll surface by keyboard.
  await keyboardViewport(page, { width: 400, height: 80, offsetLeft: 0, offsetTop: 12 });
  const scrollableResult = page.locator('#result-copy');
  await expect.poll(() => scrollableResult.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
  await scrollableResult.focus();
  await page.keyboard.press('End');
  await expect.poll(() => scrollableResult.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await capture(page, 'small-complete-scrolled');
  await keyboardViewport(page);
  await page.setViewportSize({ width: 844, height: 390 });
  await capture(page, 'phone-complete');
  report.mobile = { boxes, door: door.id, doorPoint, item: item.id, itemPoint, landscapeChat, portraitChat, down, passiveChat, result, sent: mobileWire.sent.filter(m => ['chat', 'ping', 'act'].includes(String(m.t))), errors: mobileWire.errors };
  expect(mobileWire.errors).toEqual([]); expect(peerWire.errors).toEqual([]);
  if (captureEvidence) writeFileSync(`${evidence}/results.json`, JSON.stringify(report, null, 2));
  await peerContext.close(); await phone.close();
});

test('perfume stays visual and real locker hiding works on desktop and phone', async ({ browser, baseURL }, testInfo) => {
  captureEvidence = testInfo.config.metadata.tutorialEvidence === true;
  if (captureEvidence) mkdirSync(evidence, { recursive: true });
  const report: Record<string, unknown> = {};
  for (const mobile of [false, true]) {
    const { defaultBrowserType: _browser, ...iphone } = devices['iPhone 13 landscape'];
    const context = await browser.newContext({ ...(mobile ? { ...iphone, deviceScaleFactor: 1 } : {}), baseURL,
      viewport: mobile ? { width: 844, height: 390 } : { width: 1280, height: 720 } });
    const page = await context.newPage(), wire = watch(page), device = mobile ? 'phone' : 'desktop';
    await create(page, mobile ? '香水验证手机' : '香水验证桌面');
    await page.locator('#start').click(); await ready(page);
    const spot = await page.evaluate(() => {
      const g = window.__escape.game()!, h = g.level.def.hides[3];
      window.__escape.debug('tp', h.x + .8, h.z);
      return h;
    });
    await expect.poll(() => page.evaluate(h => {
      const g = window.__escape.game()!;
      return Math.hypot(g.pos.x - h.x - .8, g.pos.z - h.z);
    }, spot)).toBeLessThan(.2);
    await page.evaluate(h => {
      const g = window.__escape.game()!;
      g.input.yaw = Math.atan2(g.pos.x - h.x, g.pos.z - h.z); g.input.pitch = 0;
      // An actual server-controlled nearby mob triggers the real proximity signal.
      // Freeze it to inspect the perfume without a chase consuming the hiding window.
      window.__escape.debug('warden', 6); window.__escape.debug('safe', 600, 1);
    }, spot);
    await expect.poll(() => page.evaluate(() => Number(document.getElementById('jasmine')?.style.opacity))).toBeGreaterThan(.1);
    await expect(page.locator('#jasmine-cue')).toHaveCount(0);
    await expect(page.locator('#tut')).not.toContainText(/茉莉香|角色074|避险/);
    await capture(page, `${device}-perfume`);
    const interact = () => mobile ? page.locator('#touch-btns .touch-btn.main').tap() : page.keyboard.press('KeyE');
    await interact();
    await expect.poll(() => page.evaluate(() => (window.__escape.game() as any).hiding)).toBe(3);
    await expect(page.locator('#hide-overlay')).toBeVisible();
    await expect(page.locator('#tut')).not.toContainText(/茉莉香|角色074|避险/);
    await capture(page, `${device}-hide-confirmed`);
    await interact();
    await expect.poll(() => page.evaluate(() => (window.__escape.game() as any).hiding)).toBe(-1);
    await expect(page.locator('#hide-overlay')).toBeHidden();
    await expect(page.locator('#tut')).not.toContainText('躲藏');
    report[device] = { spot, acts: wire.sent.filter(m => m.t === 'act'), errors: wire.errors };
    expect(wire.errors).toEqual([]);
    await context.close();
  }
  if (captureEvidence) writeFileSync(`${evidence}/perfume-results.json`, JSON.stringify(report, null, 2));
});
