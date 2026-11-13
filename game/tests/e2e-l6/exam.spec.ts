import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { generateExam } from '../../shared/exam.ts';
import { L6 } from '../../shared/levels/l6.ts';
import { setDraw, shot, showCanvas } from '../e2e/draw.ts';

// Dedicated L6 server only: ESCAPE_TEST_LEVEL=6, true zero-based index 5.
test.setTimeout(240_000);

function observe(page: Page, label: string, errors: string[]) {
  const wire = { id: 0, position: [0, 0, 0], snapshots: 0 };
  page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
  page.on('console', message => { if (message.type() === 'error') errors.push(`${label} console: ${message.text()}`); });
  page.on('websocket', ws => ws.on('framereceived', ({ payload }) => {
    const m = JSON.parse(String(payload));
    if (m.t === 'welcome') wire.id = m.id;
    if (m.t === 'snap') {
      wire.snapshots++;
      const own = m.players.find((p: { id: number }) => p.id === wire.id);
      if (own) wire.position = own.p;
    }
  }));
  return wire;
}

// Trusted browser input reaches the real server. Only placement/aim use the permitted debug hook.
async function holdForward(page: Page, milliseconds: number, touch = false) {
  if (!touch) {
    await page.keyboard.down('KeyW');
    try { await page.waitForTimeout(milliseconds); } finally { await page.keyboard.up('KeyW'); }
    return;
  }
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 90, y: 270 }] });
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 90, y: 225 }] });
    await page.waitForTimeout(milliseconds);
  } finally {
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await session.detach();
  }
}

async function realWalk(page: Page, wire: ReturnType<typeof observe>, touch = false) {
  await placeAndAim(page, -40, 73.4, 3, { x: -50, y: 12.4, z: 73.4 });
  await expect.poll(() => Math.hypot(wire.position[0] + 40, wire.position[2] - 73.4)).toBeLessThan(.25);
  const before = [...wire.position];
  await setDraw(page, true);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const videoStart = await page.evaluate(() => performance.now());
  try {
    await holdForward(page, 1200, touch);
    await expect.poll(() => before[0] - wire.position[0]).toBeGreaterThan(1);
    const after = [...wire.position];
    // Capture real rendered corridor motion and hand-held light, with desktop and phone drawing sequentially.
    if (touch) await page.locator('#touch-btns .touch-btn').filter({ hasText: '手电' }).tap();
    else await page.keyboard.press('KeyF');
    await page.waitForTimeout(3000);
    await page.evaluate(() => { window.__escape.game()!.input.yaw += Math.PI; });
    await holdForward(page, 1200, touch);
    await page.waitForTimeout(3000);
    if (touch) await page.locator('#touch-btns .touch-btn').filter({ hasText: '手电' }).tap();
    else await page.keyboard.press('KeyF');
    await page.waitForTimeout(6600);
    await shot(page, `test-results/l6-${touch ? 'touch' : 'desktop'}-real-walk.png`);
    return { input: touch ? 'trusted touchscreen joystick' : 'keyboard W', before, after, videoStartMs: videoStart, videoEndMs: await page.evaluate(() => performance.now()) };
  } finally {
    await setDraw(page, false);
  }
}

async function crossExitGate(page: Page, wire: ReturnType<typeof observe>, open: boolean, touch = false) {
  const gate = L6.exam!.exitGate!, z = (gate.z0 + gate.z1) / 2;
  await placeAndAim(page, gate.x1 + 1.0, z, 4, { x: gate.x0 - 2, y: gate.y + 1.6, z });
  await expect.poll(() => Math.abs(wire.position[0] - gate.x1 - 1)).toBeLessThan(.25);
  await holdForward(page, 1100, touch);
  await expect.poll(() => page.evaluate(() => window.__escape.game()!.input.keys.size)).toBe(0);
  if (open) {
    await expect.poll(() => wire.position[0]).toBeLessThan(gate.x0 - .3);
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.body.x)).toBeLessThan(gate.x0 - .3);
  } else {
    expect(wire.position[0]).toBeGreaterThan(gate.x1);
    expect(await page.evaluate(() => window.__escape.game()!.body.x)).toBeGreaterThan(gate.x1);
  }
  await shot(page, `test-results/l6-${touch ? 'touch' : 'desktop'}-exit-${open ? 'open' : 'closed'}.png`);
  return { open, input: touch ? 'touch joystick' : 'keyboard W', serverPosition: [...wire.position] };
}

async function clickSheet(page: Page, touch = false) {
  await showCanvas(page, true);
  const point = await page.evaluate(() => {
    const g = window.__escape.game()!, canvas = g.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  if (touch) await page.touchscreen.tap(point.x, point.y); else await page.mouse.click(point.x, point.y);
  await expect(page.locator('#exam-overlay')).toBeVisible();
  await showCanvas(page, false);
}

async function lobby(page: Page, name: string, code?: string) {
  await page.goto('/?nodraw&steady');
  await page.fill('#name', name);
  if (code) {
    await page.fill('#code', code);
    await page.click('#join');
  } else {
    await page.click('#create');
  }
  await expect(page.locator('#waiting')).toBeVisible();
  await expect(page.locator('#wait-members')).toContainText(name);
  await expect.poll(() => page.evaluate(() => window.__escape.code)).toHaveLength(4);
}

async function running(page: Page) {
  await expect(page.locator('#room-code')).toContainText('第 6 关', { timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => window.__escape.game()?.level.index)).toBe(5);
  await expect.poll(() => page.evaluate(() => window.__escape.game()?.snaps ?? 0)).toBeGreaterThan(2);
  await page.evaluate(() => window.__escape.debug('safe', 600));
}

async function placeAndAim(page: Page, x: number, z: number, floor: number, target: { x: number; y: number; z: number }) {
  await page.evaluate(({ x, z, floor }) => window.__escape.debug('tp', x, z, floor), { x, z, floor });
  await expect.poll(() => page.evaluate(({ x, z, floor }) => {
    const g = window.__escape.game()!;
    return Math.hypot(g.body.x - x, g.body.z - z) + Math.abs(g.body.y - floor * 3.6);
  }, { x, z, floor })).toBeLessThan(0.25);
  await page.evaluate((t) => {
    const g = window.__escape.game()!, dx = t.x - g.body.x, dz = t.z - g.body.z;
    g.input.yaw = Math.atan2(-dx, -dz);
    g.input.pitch = Math.atan2(t.y - g.body.y - 1.6, Math.hypot(dx, dz));
  }, target);
}

const examState = (page: Page) => page.evaluate(() => (window.__escape.game() as any).exam.state);

async function brightness(page: Page) {
  return page.evaluate(() => {
    const g = window.__escape.game()!, r = g.renderer;
    r.render(g.scene, g.camera);
    const gl = r.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const pixels = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let total = 0, count = 0;
    for (let i = 0; i < pixels.length; i += 64) {
      total += 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2]; count++;
    }
    return total / count;
  });
}

async function choose(page: Page, question: number, choice: number, touch = false) {
  const tab = page.locator(`[data-question="${question}"]`);
  if (touch) await tab.tap(); else await tab.click();
  const option = page.locator(`button[data-choice="${choice}"]`);
  if (touch) await option.tap(); else await option.click();
  await expect.poll(async () => (await examState(page)).answers[question]).toBe(choice);
}

test('真实第6关：公告、共用试卷、答错惩罚、触屏修正和全员出口', async ({ browser, page }, testInfo) => {
  const errors: string[] = [];
  const desktopWire = observe(page, 'desktop', errors);
  const mobile = await browser.newContext({ baseURL: 'http://127.0.0.1:4412', viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, recordVideo: { dir: 'test-results/l6-video', size: { width: 844, height: 390 } } });
  const evidence: Record<string, unknown> = { realServer: 'http://127.0.0.1:4412', externalVideoReview: 'not performed; no Gemini tool available' };
  const peer = await mobile.newPage().catch(async error => { await mobile.close(); throw error; });
  const mobileWire = observe(peer, 'touch', errors);
  try {
  await lobby(page, '考生甲');
  const code = await page.evaluate(() => window.__escape.code);
  await lobby(peer, '考生乙', code);
  await page.click('#start');
  await Promise.all([running(page), running(peer)]);
  evidence.renderer = await page.evaluate(() => {
    const gl = window.__escape.game()!.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  });
  console.log('L6 WebGL renderer:', evidence.renderer);
  expect(evidence.renderer).toMatch(/Metal/);
  await expect(page.locator('#objective')).toContainText('4–5层');
  const seed = await page.evaluate(() => window.__escape.game()!.level.seed);
  expect(await peer.evaluate(() => window.__escape.game()!.level.seed)).toBe(seed);
  const questions = generateExam(seed);
  expect(questions).toHaveLength(5);
  evidence.seed = seed;
  evidence.desktopMovement = await realWalk(page, desktopWire);
  evidence.touchMovement = await realWalk(peer, mobileWire, true);
  evidence.closedGateDesktop = await crossExitGate(page, desktopWire, false);
  evidence.closedGateTouch = await crossExitGate(peer, mobileWire, false, true);
  // The monitor is the actual single server mob, shown in the rendered fifth-floor classroom.
  await placeAndAim(page, -40, 73.4, 4, { x: -36, y: 16, z: 73.4 });
  await page.evaluate(() => { window.__escape.debug('monitor', 4); window.__escape.debug('safe', 600, 2); });
  await expect.poll(() => page.evaluate(() => [...window.__escape.game()!.mobs.byId.values()].filter(m => m.monitor).length)).toBe(1);
  await page.waitForTimeout(500);
  await shot(page, 'test-results/l6-single-monitor.png');
  evidence.monitor = await page.evaluate(() => [...window.__escape.game()!.mobs.byId.entries()].filter(([, m]) => m.monitor).map(([id, m]) => ({ id, position: m.mesh.position.toArray() })));

  // Walk the campus's actual double-flight stair, with authoritative movement checks still active.
  await placeAndAim(page, -54.45, 72.75, 3, { x: -54.65, y: 12.4, z: 66.45 });
  await page.evaluate(() => window.__escape.autopilot([
    [-54.45, 72.75], [-54.65, 66.45], [-56.45, 66.45], [-58, 64.555], [-64.06, 64.555],
    [-64.06, 67.485], [-58, 67.485], [-56.45, 66.45],
  ]));
  await expect.poll(() => page.evaluate(() => window.__escape.game()!.autopilotDone), { timeout: 35_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__escape.game()!.body.y)).toBeCloseTo(14.4, 1);

  // The physical notices are read using the ordinary interaction key, on both storeys.
  for (const [i, n] of L6.exam!.notices.entries()) {
    await placeAndAim(page, n.x + 1.1, n.z, Math.round((n.y - 1.45) / 3.6), n);
    await expect(page.locator('#prompt')).toContainText('公告');
    await shot(page, `test-results/l6-notice-world-${i + 1}.png`);
    await clickSheet(page);
    await expect(page.getByRole('dialog', { name: `${i + 4}F · 考试公告` })).toBeVisible();
    await page.locator('#exam-close').click();
    await page.keyboard.press('KeyE');
    await expect(page.locator('#exam-overlay')).toBeVisible();
    await expect(page.getByRole('dialog', { name: `${i + 4}F · 考试公告` })).toBeVisible();
    for (const q of n.questions) {
      await expect(page.locator('#exam-overlay')).toContainText(questions[q].prompt);
      await expect(page.locator('#exam-overlay')).toContainText(questions[q].clue);
    }
    await expect(page.locator('#exam-submit')).toBeHidden();
    await expect(page.locator('#exam-close')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#exam-close')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#exam-close')).toBeFocused();
    await shot(page, `test-results/l6-notice-${i + 1}.png`);
    await page.locator('#exam-close').click();
    await page.keyboard.press('KeyM');
    await expect(page.locator('#map')).toBeVisible();
    await expect(page.locator('#map .mt')).toContainText(`${i + 4}F`);
    await shot(page, `test-results/l6-map-${i + 4}f.png`);
    await page.keyboard.press('KeyM');
    await expect(page.locator('#map')).toBeHidden();
  }

  const paper = L6.exam!.paper;
  await placeAndAim(page, paper.x, paper.z + 0.75, 3, paper);
  await expect(page.locator('#prompt')).toContainText('试卷');
  await shot(page, 'test-results/l6-paper-world.png');
  await clickSheet(page);
  await page.locator('#exam-close').click();
  await page.keyboard.press('KeyE');
  await expect(page.locator('#exam-overlay')).toBeVisible();
  await expect(page.getByRole('dialog', { name: '全队共用试卷' })).toBeVisible();
  await expect(page.locator('#exam-submit')).toBeDisabled();
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-question="0"]')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#exam-close')).toBeFocused();
  // No movement leaks out of the question dialog even if WASD is held.
  const at = await page.evaluate(() => ({ ...window.__escape.game()!.pos }));
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(250);
  await page.keyboard.up('KeyW');
  expect(await page.evaluate(() => ({ ...window.__escape.game()!.pos }))).toEqual(at);
  await placeAndAim(peer, paper.x, paper.z + .75, 3, paper);
  await clickSheet(peer, true);
  await peer.locator('[data-question="0"]').focus();
  await choose(page, 0, (questions[0].correct + 1) % 4);
  await expect.poll(async () => (await examState(peer)).answers[0]).toBe((questions[0].correct + 1) % 4);
  await expect(peer.locator('[data-question="0"]')).toBeFocused();
  await peer.locator('#exam-close').tap();
  for (let q = 1; q < 5; q++) await choose(page, q, questions[q].correct);
  await shot(page, 'test-results/l6-desktop-paper.png');
  await placeAndAim(peer, -40, 73.4, 4, { x: -50, y: 16, z: 73.4 });
  const before4 = await brightness(page), before5 = await brightness(peer);
  expect(before4).toBeGreaterThan(10); expect(before5).toBeGreaterThan(10);
  await page.locator('#exam-submit').click();
  await expect(page.locator('[data-question="4"]')).toBeFocused();
  await expect.poll(async () => (await examState(page)).cooldown).toBeGreaterThan(0);
  expect((await examState(page)).passed).toBe(false);
  await expect(page.locator('#exam-submit')).toBeDisabled();
  await expect(page.locator('.exam-status')).toContainText('后可改答重交');
  await page.locator('[data-question="0"]').click();
  await expect(page.locator('.exam-choice')).toHaveCount(4);
  await expect(page.locator('.exam-choice:disabled')).toHaveCount(4);
  await expect(page.locator(`.exam-choice[data-choice="${(questions[0].correct + 1) % 4}"]`)).toHaveAttribute('aria-pressed', 'true');
  expect((await examState(page)).blackout.floor).toBe(3);
  await expect.poll(() => page.evaluate(() => window.__escape.game()!.campus.out)).toBe(1);
  await expect.poll(() => peer.evaluate(() => window.__escape.game()!.campus.outFloor)).toBe(3);
  const after4 = await brightness(page), after5 = await brightness(peer);
  evidence.lighting = { before4, after4, before5, after5 };
  console.log('L6 floor lighting:', JSON.stringify({ before4, after4, before5, after5 }));
  expect(after4).toBeLessThan(before4 * 0.85);
  expect(after5 / before5).toBeGreaterThan(0.95);
  expect(after5 / before5).toBeLessThan(1.05);
  await shot(peer, 'test-results/l6-5f-during-4f-blackout.png');
  await shot(page, 'test-results/l6-4f-blackout-ui.png');
  await page.locator('#exam-close').click();
  await shot(page, 'test-results/l6-4f-blackout-world.png');

  // The touch teammate receives the same sheet and waits out the authority's punishment.
    expect((await examState(peer)).answers).toEqual((await examState(page)).answers);
    await expect.poll(async () => (await examState(peer)).cooldown, { timeout: 15_000 }).toBe(0);
    const notice = L6.exam!.notices[0];
    await placeAndAim(peer, notice.x + 1.1, notice.z, 3, notice);
    await clickSheet(peer, true);
    await expect(peer.locator('#exam-overlay')).toContainText(questions[0].clue);
    await peer.locator('#exam-close').tap();
    await placeAndAim(peer, paper.x, paper.z + 0.75, 3, paper);
    await expect(peer.locator('#prompt')).toContainText('试卷');
    await clickSheet(peer, true);
    await peer.locator('#exam-close').tap();
    await peer.locator('#touch-btns .main').tap();
    await expect(peer.locator('#exam-overlay')).toBeVisible();
    await choose(peer, 0, questions[0].correct, true);
    await expect.poll(async () => (await examState(page)).answers[0]).toBe(questions[0].correct);
    await shot(peer, 'test-results/l6-touch-paper.png');
    const bounds = await peer.locator('#exam-submit').boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.height).toBeGreaterThanOrEqual(40);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(844);
    await peer.locator('#exam-submit').tap();
    await expect.poll(async () => (await examState(peer)).passed).toBe(true);
    await expect.poll(async () => (await examState(page)).passed).toBe(true);
    await peer.locator('#exam-close').tap();

    evidence.openGateDesktop = await crossExitGate(page, desktopWire, true);
    await page.waitForTimeout(200);
    await expect(page.locator('#fade-overlay')).toBeHidden(); // peer still outside
    evidence.openGateTouch = await crossExitGate(peer, mobileWire, true, true);
    await expect(page.locator('#fade-overlay')).toBeVisible();
    await expect(peer.locator('#fade-overlay')).toBeVisible();
    await expect(page.locator('#fade-overlay')).toContainText('逃出去了');
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.completed)).toBe(true);
    await expect.poll(() => peer.evaluate(() => window.__escape.game()!.completed)).toBe(true);
    await expect(page.locator('#fade-overlay')).toContainText('考场通关');
    await shot(page, 'test-results/l6-desktop-complete.png');
    await shot(peer, 'test-results/l6-touch-complete.png');
    evidence.completed = true;
    expect(errors).toEqual([]);
  } finally {
    evidence.desktopVideo = await page.video()?.path();
    evidence.touchVideo = await peer.video()?.path();
    evidence.errors = errors;
    await mobile.close();
    await writeFile('test-results/l6-browser-evidence.json', JSON.stringify(evidence, null, 2));
    if (evidence.touchVideo) await testInfo.attach('touch-real-server-video', { path: String(evidence.touchVideo), contentType: 'video/webm' });
  }
});

test('竖屏触屏单人：远程写卷被拒、重复选项及时确认、通关后刷新可重新挑战', async ({ browser }) => {
  // Movement retains the game's landscape requirement; a paper can be read after rotating the device.
  const mobile = await browser.newContext({ baseURL: 'http://127.0.0.1:4412', viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const page = await mobile.newPage().catch(async error => { await mobile.close(); throw error; });
  const errors: string[] = [];
  observe(page, 'portrait', errors);
  try {
    await lobby(page, '竖屏考生');
    await page.locator('#start').tap();
    await running(page);
    const seed = await page.evaluate(() => window.__escape.game()!.level.seed);
    const questions = generateExam(seed), initial = await examState(page);

    // A real websocket operation at the spawn must not modify the paper across the campus.
    const snaps = await page.evaluate((revision) => {
      window.__escape.net.send({ t: 'exam', op: 'answer', question: 0, choice: 0, revision });
      return window.__escape.game()!.snaps;
    }, initial.revision);
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.snaps)).toBeGreaterThan(snaps + 2);
    expect(await examState(page)).toEqual(initial);

    const paper = L6.exam!.paper;
    await placeAndAim(page, paper.x, paper.z + 0.75, 3, paper);
    await expect(page.locator('#prompt')).toContainText('试卷');
    await page.locator('#touch-btns .main').tap();
    await expect(page.locator('#exam-overlay')).toBeVisible();
    // Chromium cannot emulate a rotation by resizing its native fullscreen window.
    await page.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#rotate')).toBeHidden();
    await expect(page.locator('#touch')).toBeHidden();
    await expect(page.locator('#chat-input')).toBeHidden();
    await page.locator('[data-question="0"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#chat-input')).toBeHidden();
    await expect(page.locator('#exam-overlay')).toBeVisible();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#exam-close')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('button[data-choice="3"]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#exam-close')).toBeFocused();
    expect(await page.locator('.exam-panel').evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    await shot(page, 'test-results/l6-touch-portrait-paper.png');

    await page.locator(`button[data-choice="${questions[0].correct}"]`).focus();
    await page.keyboard.press('Space');
    await expect.poll(async () => (await examState(page)).answers[0]).toBe(questions[0].correct);
    await expect(page.locator('[data-question="0"]')).toBeFocused();
    for (let q = 1; q < 5; q++) await choose(page, q, questions[q].correct, true);
    const revision = (await examState(page)).revision;
    // Reselecting an existing choice is a valid idempotent operation, not a three-second UI lock.
    await choose(page, 4, questions[4].correct, true);
    await expect(page.locator('.exam-status')).not.toContainText('正在与全队同步', { timeout: 1500 });
    expect((await examState(page)).revision).toBe(revision);
    await page.locator('#exam-submit').scrollIntoViewIfNeeded();
    const submit = await page.locator('#exam-submit').boundingBox();
    expect(submit).not.toBeNull();
    expect(submit!.height).toBeGreaterThanOrEqual(40);
    expect(submit!.x).toBeGreaterThanOrEqual(0);
    expect(submit!.x + submit!.width).toBeLessThanOrEqual(390);
    expect(submit!.y + submit!.height).toBeLessThanOrEqual(844);
    await page.locator('#exam-submit').tap();
    await expect.poll(async () => (await examState(page)).passed).toBe(true);
    await expect(page.locator('.exam-choice:disabled')).toHaveCount(4);
    await expect(page.locator('#exam-submit')).toBeDisabled();
    await expect(page.locator('#exam-submit')).toHaveText('已通过');
    await shot(page, 'test-results/l6-touch-portrait-passed.png');
    await page.locator('#exam-close').tap();
    await expect(page.locator('#exam-overlay')).toBeHidden();
    await expect(page.locator('#rotate')).toBeVisible();
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(page.locator('#rotate')).toBeHidden();
    expect(await page.evaluate(() => window.__escape.game()!.input.enabled)).toBe(true);

    await page.evaluate((ex) => window.__escape.debug('tp', ex.x, ex.z, 4), L6.exit);
    await expect(page.locator('#fade-overlay')).toBeVisible();
    await expect(page.locator('#fade-overlay')).toContainText('逃出去了');
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.completed)).toBe(true);
    await expect(page.locator('#fade-overlay')).toContainText('考场通关');
    expect((await examState(page)).passed).toBe(true);
    await lobby(page, '重新挑战考生');
    await page.locator('#start').tap();
    await running(page);
    const reset = await examState(page);
    expect(reset.answers).toEqual([null, null, null, null, null]);
    expect(reset.passed).toBe(false);
    expect(reset.cooldown).toBe(0);
    expect(await page.evaluate(() => window.__escape.game()!.level.index)).toBe(5);
    await expect(page.locator('#room-code')).toContainText('第 6 关');
    expect(errors).toEqual([]);
  } finally {
    await mobile.close();
  }
});
