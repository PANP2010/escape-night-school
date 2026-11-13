import { devices, expect, test, type Page } from '@playwright/test';
import { frame } from './draw.ts';

const { defaultBrowserType: _browser, ...iphone } = devices['iPhone 13 landscape'];
const { defaultBrowserType: _desktopBrowser, ...desktop } = devices['Desktop Chrome'];
test.use({ ...iphone });

async function layout(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    };
    const panel = box(document.getElementById('map')!);
    const controls = [...document.querySelectorAll('#touch-btns .touch-btn, #touch-base, #touch-map, #touch-chat')]
      .map((el) => ({ name: el.id || el.textContent!, box: box(el) }));
    const overlaps = controls.filter(({ box: r }) => panel.left < r.right && r.left < panel.right && panel.top < r.bottom && r.top < panel.bottom)
      .map(({ name }) => name);
    return { panel, controls, overlaps, width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
      content: [...document.querySelectorAll('#map .mh, #map canvas, #map .ml')].map(box) };
  });
}

async function screenshot(page: Page, name: string) {
  await frame(page);
  // The mobile backbuffer must be decoded and painted before the screenshot (DPR 3).
  await page.evaluate(async () => {
    await (document.getElementById('e2e-shot') as HTMLImageElement).decode();
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const tag = String(test.info().project.metadata.captureTag ?? 'fixed');
  await page.screenshot({ path: `test-results/map-mobile-${tag}-${name}.png` });
  await page.evaluate(() => document.getElementById('e2e-shot')?.remove());
}

async function checkLayout(page: Page, name: string) {
  const l = await layout(page);
  console.log('MAP_LAYOUT', name, JSON.stringify(l));
  expect.soft(l.overlaps, `${name}: the map leaves every touch control visible`).toEqual([]);
  expect.soft(l.panel.left, `${name}: map stays on screen`).toBeGreaterThanOrEqual(0);
  expect.soft(l.panel.top, `${name}: map stays on screen`).toBeGreaterThanOrEqual(0);
  expect.soft(l.panel.right).toBeLessThanOrEqual(l.width);
  expect.soft(l.panel.bottom).toBeLessThanOrEqual(l.height);
  expect.soft(l.scrollWidth).toBeLessThanOrEqual(l.width);
  for (const r of l.content) {
    expect.soft(r.left).toBeGreaterThanOrEqual(l.panel.left);
    expect.soft(r.right).toBeLessThanOrEqual(l.panel.right + 1);
    expect.soft(r.top).toBeGreaterThanOrEqual(l.panel.top);
    expect.soft(r.bottom).toBeLessThanOrEqual(l.panel.bottom + 1);
  }
}

test('phone L1/L2 maps leave the controls visible and usable across a resize', async ({ page, browser, baseURL }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const peerContext = await browser.newContext({ ...desktop, viewport: { width: 1280, height: 720 }, hasTouch: false, isMobile: false, baseURL });
  const peer = await peerContext.newPage();
  peer.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto('/?nodraw&steady');
    await page.fill('#name', '甲');
    await page.click('#create');
    await expect(page.locator('#wait-code')).not.toBeEmpty();
    const code = await page.evaluate(() => window.__escape.code);
    await peer.goto('/?nodraw&steady');
    await peer.fill('#name', '乙');
    await peer.fill('#code', code);
    await peer.click('#join');
    await expect(page.locator('#wait-members')).toContainText('乙');
    await page.click('#start');
    for (const p of [page, peer]) {
      await expect(p.locator('#hud')).toBeVisible({ timeout: 30_000 });
      await p.waitForFunction(() => (window.__escape.game() as any)?.spawnSynced);
    }
    // macOS Chromium can replace the emulated viewport with the host screen on fullscreen entry.
    await page.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); });
    await page.setViewportSize({ width: 844, height: 390 });
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([844, 390]);
    await page.evaluate(() => window.__escape.debug('safe', 600));
    await peer.evaluate(() => window.__escape.debug('tp', -49, 68, 0));
    await page.waitForFunction(() => {
      const g = window.__escape.game() as any;
      return [...g.explored as Set<number>].some((i) => g.plan.rooms[i].id === 's1');
    });
    await expect(page.locator('#banner')).toBeHidden({ timeout: 15_000 });
    await page.locator('#touch-map').tap();
    await expect(page.locator('#map')).toBeVisible();
    await expect(page.locator('#map .mt')).toContainText('平面图');
    await screenshot(page, 'l1');
    await checkLayout(page, 'L1 844x390');
    await expect(peer.locator('body')).not.toHaveClass(/touch/);
    await peer.keyboard.press('KeyM');
    await expect(peer.locator('#map')).toBeVisible();
    await screenshot(peer, 'l1-desktop');
    await checkLayout(peer, 'L1 desktop 1280x720');
    await peer.keyboard.press('KeyM');

    const light = await page.evaluate(() => window.__escape.game()!.light);
    await page.locator('.touch-btn', { hasText: /^手电$/ }).tap();
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.light)).toBe(!light);
    const arrow = await page.evaluate(() => (window.__escape.game() as any).arrowOn as boolean);
    await page.locator('#map .mb.arrow').tap();
    await expect.poll(() => page.evaluate(() => (window.__escape.game() as any).arrowOn as boolean)).toBe(!arrow);
    await page.locator('#map .mb.arrow').tap();

    const cdp = await page.context().newCDPSession(page);
    const from = await page.evaluate(() => { const p = window.__escape.game()!.pos; return { x: p.x, z: p.z }; });
    try {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 88, y: 302, id: 1 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 88, y: 252, id: 1 }] });
      await expect.poll(() => page.evaluate((a) => {
        const p = window.__escape.game()!.pos; return Math.hypot(p.x - a.x, p.z - a.z);
      }, from)).toBeGreaterThan(0.3);
    } finally {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    }
    await page.locator('#map .mb.close').tap();
    await expect(page.locator('#map')).toBeHidden();
    // Both real WebSocket clients must reach the exit for the authoritative level change.
    const exit = await page.evaluate(() => window.__escape.game()!.level.exit);
    await page.evaluate(() => window.__escape.debug('key', -1));
    for (const p of [page, peer]) await p.evaluate((e) => window.__escape.debug('tp', e.x, e.z, 0), exit);
    for (const p of [page, peer]) {
      await expect(p.locator('#room-code')).toContainText('第 2 关', { timeout: 30_000 });
      await p.waitForFunction(() => {
        const game = window.__escape.game(); return game?.presentationReady && !game.intro.active;
      });
    }
    await page.evaluate(() => { window.__escape.debug('safe', 600, 1); window.__escape.debug('safe', 600, 2); });
    await expect(page.locator('#fade-overlay')).toBeHidden({ timeout: 10_000 });
    await expect(page.locator('#banner')).toBeHidden({ timeout: 15_000 });
    await page.locator('#touch-map').tap();
    await expect(page.locator('#map .mt')).toContainText('停电');
    await screenshot(page, 'l2');
    await checkLayout(page, 'L2 844x390');
    const mapWidth = await page.locator('#map canvas').evaluate((c) => c.getBoundingClientRect().width);
    await peer.keyboard.press('KeyM');
    await expect(peer.locator('#map')).toBeVisible();
    await screenshot(peer, 'l2-desktop');
    await checkLayout(peer, 'L2 desktop 1280x720');
    await peer.keyboard.press('KeyM');
    // Browser chrome/orientation changes must resize an already-open map too.
    // Its width must use the resting stick anchor even while the stick follows a finger elsewhere.
    const resizeCdp = await page.context().newCDPSession(page);
    try {
      await resizeCdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 300, y: 350, id: 1 }] });
      await expect(page.locator('#touch-base')).toHaveClass('on');
      await page.setViewportSize({ width: 667, height: 375 });
    } finally {
      await resizeCdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await resizeCdp.detach();
    }
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([667, 375]);
    await screenshot(page, 'l2-small');
    await checkLayout(page, 'L2 667x375 open-map resize');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#rotate')).toBeVisible();
    expect(await page.locator('#map canvas').evaluate((c) => (c as HTMLCanvasElement).width)).toBeGreaterThan(0);
    await page.setViewportSize({ width: 844, height: 390 });
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([844, 390]);
    await expect(page.locator('#rotate')).toBeHidden();
    await expect.poll(() => page.locator('#map canvas').evaluate((c) => c.getBoundingClientRect().width)).toBe(mapWidth);
    await checkLayout(page, 'L2 restored 844x390');
    await page.locator('#map .mb.close').tap();
    await expect(page.locator('#map')).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await peerContext.close();
  }
});
