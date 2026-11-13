import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { shot } from './draw';
import { browserArgs } from '../browser-args.mjs';

test.use({ launchOptions: { args: browserArgs(['--mute-audio']) } });

async function enter(page: Page) {
  await page.goto('/?nodraw&steady');
  await page.fill('#name', '地图验收');
  await page.click('#create');
  await page.click('#start');
  await expect.poll(() => page.evaluate(() => (window.__escape.game() as unknown as { spawnSynced?: boolean } | null)?.spawnSynced), { timeout: 30_000 }).toBe(true);
  await page.waitForFunction(() => window.__escape.game()?.presentationReady && !window.__escape.game()!.intro.active);
  await page.evaluate(() => window.__escape.debug('safe', 600));
  await expect(page.locator('#banner')).toBeHidden({ timeout: 15_000 });
}

async function mapOpen(page: Page) {
  await page.evaluate(() => window.__escape.game()!.toggleMap(true));
  await expect(page.locator('#map')).toBeVisible();
  await page.waitForTimeout(300);
}

async function layout(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const e = document.querySelector<HTMLElement>(selector);
      if (!e || e.hidden || !e.getClientRects().length || getComputedStyle(e).display === 'none' || getComputedStyle(e).visibility === 'hidden') return null;
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height,
        scrollW: e.scrollWidth, clientW: e.clientWidth, scrollH: e.scrollHeight, clientH: e.clientHeight };
    };
    const selectors = ['#map', '#map .mh', '#map .mt', '#map .ml', '#map canvas', '#map .arrow', '#map .close', '#touch-base', '#touch-btns', '#objective', '#tut', '#prompt', '#hint', '#goal-arrow .d', '#touch-map', '#touch-chat', '#battery', '#stamina', '#keys', '#room-code'];
    const boxes = Object.fromEntries(selectors.map((s) => [s, box(s)]));
    const controls = [...document.querySelectorAll<HTMLElement>('.touch-btn, #map .mb')].flatMap((e) => {
      const r = box(e.id ? `#${e.id}` : e.closest('#map') ? `#map .${e.classList.contains('arrow') ? 'arrow' : 'close'}` : `#touch-btns .touch-btn:nth-child(${[...e.parentElement!.children].indexOf(e) + 1})`);
      return r ? [{ text: e.textContent, ...r }] : [];
    });
    const cv = document.querySelector<HTMLCanvasElement>('#map canvas')!;
    const r = cv.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    const contain = Math.min(r.width / cv.width, r.height / cv.height);
    const mapPaint = { intrinsicW: cv.width, intrinsicH: cv.height, cssW: r.width, cssH: r.height, paintedW: cv.width * contain, paintedH: cv.height * contain,
      textScale: contain * (cv.width / parseFloat(cv.style.width)) };
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.append(probe);
    const ps = getComputedStyle(probe), safe = { top: parseFloat(ps.paddingTop), right: parseFloat(ps.paddingRight), bottom: parseFloat(ps.paddingBottom), left: parseFloat(ps.paddingLeft) };
    probe.remove();
    const hintRange = document.createRange();
    hintRange.selectNodeContents(document.getElementById('hint')!);
    const hintText = hintRange.getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, touch: document.body.classList.contains('touch'), portrait: getComputedStyle(document.getElementById('rotate')!).display !== 'none', boxes, controls,
      mapPointerEvents: getComputedStyle(document.getElementById('map')!).pointerEvents,
      canvasPointerEvents: getComputedStyle(cv).pointerEvents, mapHit: hit?.id || hit?.tagName,
      pageOverflow: document.documentElement.scrollWidth > innerWidth, safe, mapPaint,
      hintText: { x: hintText.x, right: hintText.right },
      level: window.__escape.game()!.level.index };
  });
}

type Layout = Awaited<ReturnType<typeof layout>>;
type Box = NonNullable<Layout['boxes'][string]>;
const overlaps = (a: Box, b: Box) => a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;

function checkLayout(report: Layout, insets = { top: 0, left: 0, right: 0, bottom: 0 }) {
  expect(report.safe).toEqual(insets);
  expect(report.pageOverflow).toBe(false);
  expect(report.mapPointerEvents).toBe('none');
  expect(report.canvasPointerEvents).toBe('none');
  if (report.portrait) {
    expect(report.mapHit).toBe('rotate');
    return;
  }
  const panel = report.boxes['#map']!;
  expect(panel.x).toBeGreaterThanOrEqual(insets.left);
  expect(panel.y).toBeGreaterThanOrEqual(insets.top);
  expect(panel.right).toBeLessThanOrEqual(report.width - insets.right);
  expect(panel.bottom).toBeLessThanOrEqual(report.height - insets.bottom);
  expect(report.mapPaint.textScale).toBeCloseTo(1, 2);
  for (const selector of ['#map .mh', '#map .mt', '#map .ml', '#map canvas', '#map .arrow', '#map .close']) {
    const r = report.boxes[selector];
    if (!r) continue;
    expect(r.x, selector).toBeGreaterThanOrEqual(panel.x);
    expect(r.right, selector).toBeLessThanOrEqual(panel.right);
    expect(r.y, selector).toBeGreaterThanOrEqual(panel.y);
    expect(r.bottom, selector).toBeLessThanOrEqual(panel.bottom);
    expect(r.scrollW, `${selector} horizontal overflow`).toBeLessThanOrEqual(r.clientW + 1);
    expect(r.scrollH, `${selector} vertical overflow`).toBeLessThanOrEqual(r.clientH + 1);
  }
  for (const selector of ['#objective', '#room-code', '#touch-map', '#touch-chat', '#touch-base', '#touch-btns', '#battery', '#stamina', '#keys']) {
    const r = report.boxes[selector];
    if (r) expect(overlaps(panel, r), `map overlaps ${selector}`).toBe(false);
  }
  if (report.touch && report.boxes['#prompt']) expect(overlaps(panel, report.boxes['#prompt']), 'map overlaps interaction prompt').toBe(false);
  expect(report.boxes['#tut']).toBeNull();
  expect(report.boxes['#hint']).toBeNull();
  expect(report.boxes['#goal-arrow .d']).toBeNull();
  if (!report.touch) {
    const room = report.boxes['#room-code'], objective = report.boxes['#objective'];
    if (room && objective) expect(room.right, 'room code clears objective').toBeLessThanOrEqual(objective.x - 12);
    return;
  }
  expect(report.mapHit).toBe('touch-look');
  const objective = report.boxes['#objective'];
  if (objective) for (const selector of ['#battery', '#stamina', '#keys', '#touch-btns']) {
    const r = report.boxes[selector];
    if (r) expect(overlaps(objective, r), `objective overlaps ${selector}`).toBe(false);
  }
  for (const selector of ['#room-code', '#prompt']) {
    const r = report.boxes[selector];
    if (!r) continue;
    expect(r.x, selector).toBeGreaterThanOrEqual(insets.left);
    expect(r.right, selector).toBeLessThanOrEqual(report.width - insets.right);
    expect(r.y, selector).toBeGreaterThanOrEqual(insets.top);
    expect(r.bottom, selector).toBeLessThanOrEqual(report.height - insets.bottom);
  }
  const title = report.boxes['#map .mt']!, arrow = report.boxes['#map .arrow']!, close = report.boxes['#map .close']!;
  expect(overlaps(title, arrow)).toBe(false);
  expect(overlaps(title, close)).toBe(false);
  expect(overlaps(arrow, close)).toBe(false);
  for (const button of report.controls) {
    expect(button.w, button.text ?? 'button').toBeGreaterThanOrEqual(44);
    expect(button.h, button.text ?? 'button').toBeGreaterThanOrEqual(44);
    expect(button.x).toBeGreaterThanOrEqual(insets.left);
    expect(button.y).toBeGreaterThanOrEqual(insets.top);
    expect(button.right).toBeLessThanOrEqual(report.width - insets.right);
    expect(button.bottom).toBeLessThanOrEqual(report.height - insets.bottom);
  }
}

async function touchMapControls(page: Page) {
  const before = await page.evaluate(() => localStorage.getItem('escape.arrow') !== '0');
  await page.locator('#map .arrow').tap();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('escape.arrow') !== '0')).toBe(!before);
  await page.locator('#map .arrow').tap();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('escape.arrow') !== '0')).toBe(before);
  await page.locator('#map .close').tap();
  await expect(page.locator('#map')).toBeHidden();
  await page.locator('#touch-map').tap();
  await expect(page.locator('#map')).toBeVisible();
  const cv = await page.locator('#map canvas').boundingBox();
  const yaw = await page.evaluate(() => window.__escape.game()!.input.yaw);
  const session = await page.context().newCDPSession(page);
  const x = cv!.x + cv!.width * 0.7, y = cv!.y + cv!.height * 0.5;
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + 20, y }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
  await expect.poll(() => page.evaluate(() => window.__escape.game()!.input.yaw)).not.toBe(yaw);
}

async function bottomArrow(page: Page, name: string) {
  await page.evaluate(() => {
    const g = window.__escape.game()! as unknown as { toggleMap(on: boolean): void; pos: { x: number; z: number }; input: { yaw: number; pitch: number }; guide: { x: number; z: number } };
    g.toggleMap(false);
    g.input.yaw = Math.atan2(g.pos.x - g.guide.x, g.pos.z - g.guide.z);
    g.input.pitch = 1.2;
    document.getElementById('hint')!.classList.remove('off', 'covered');
  });
  await expect(page.locator('#subtitle')).toBeHidden({ timeout: 10_000 });
  await expect.poll(() => page.locator('#goal-arrow .d').evaluate((e) => e.getBoundingClientRect().y)).toBeGreaterThan((page.viewportSize()!.height * 0.6));
  const r = await layout(page), arrow = r.boxes['#goal-arrow .d']!, hint = r.boxes['#hint']!;
  await shot(page, `test-results/mobile-hud-${name}-footer.png`);
  expect(arrow.bottom).toBeLessThanOrEqual(hint.y - 4);
  expect(arrow.x).toBeGreaterThanOrEqual(0);
  expect(arrow.right).toBeLessThanOrEqual(r.width);
  expect(r.hintText.x).toBeGreaterThanOrEqual(r.safe.left);
  expect(r.hintText.right).toBeLessThanOrEqual(r.width - r.safe.right);
  await page.evaluate(() => { window.__escape.game()!.input.pitch = 0; });
}

test('map and HUD stay readable across desktop and phone viewports', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const reports: Layout[] = [], errors: string[] = [];
  for (const touch of [false, true]) {
    const context = await browser.newContext({ viewport: { width: touch ? 844 : 1280, height: touch ? 390 : 720 }, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await enter(page);
    for (const level of [0, 1]) {
      if (level === 1) {
        await page.evaluate(() => { window.__escape.debug('key', -1); window.__escape.debug('tp', -61, 66); });
        await expect.poll(() => page.evaluate(() => window.__escape.game()?.level.index), { timeout: 20_000 }).toBe(1);
        await page.evaluate(() => window.__escape.debug('safe', 600));
        await expect(page.locator('#fade-overlay')).toBeHidden({ timeout: 10_000 });
        await page.waitForFunction(() => {
          const g = window.__escape.game(); return g?.level.index === 1 && g.presentationReady && !g.intro.active;
        });
        await expect(page.locator('#banner')).toBeHidden({ timeout: 15_000 });
      }
      if (touch) {
        await page.evaluate((level) => window.__escape.debug('tp', level === 0 ? -45.15 : 52.85, level === 0 ? 73.36 : 83.94), level);
        await expect.poll(() => page.evaluate((level) => Math.abs(window.__escape.game()!.pos.x - (level === 0 ? -45.15 : 52.85)), level)).toBeLessThan(0.15);
      }
      for (const [width, height] of touch ? [[844, 390], [667, 375], [390, 844], [844, 390]] : [[1280, 720], [960, 540], [800, 600], [640, 400]]) {
        await page.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); });
        await page.setViewportSize({ width, height });
        if (touch && width > height) {
          await page.evaluate(() => { const i = window.__escape.game()!.input; i.yaw = 0; i.pitch = 0; });
          await expect(page.locator('#prompt')).toHaveText('点门 · 打开');
        }
        await mapOpen(page);
        const report = await layout(page);
        const name = `final-l${level + 1}-${width}x${height}${reports.some((r) => r.level === level && r.touch === touch && r.width === width) ? '-rotated' : ''}`;
        reports.push(report);
        console.log(name, JSON.stringify({ panel: report.boxes['#map'], safe: report.safe, mapHit: report.mapHit }));
        await shot(page, `test-results/mobile-hud-${name}.png`);
        await writeFile('test-results/mobile-hud-final.json', JSON.stringify({ reports, errors }, null, 2));
        await info.attach(name, { path: `test-results/mobile-hud-${name}.png`, contentType: 'image/png' });
        checkLayout(report);
        if (touch && width > height) await touchMapControls(page);
        if (width > height) await bottomArrow(page, name);
      }
      if (touch) {
        const session = await context.newCDPSession(page);
        const insets = { top: 0, left: 44, right: 44, bottom: 34 };
        await session.send('Emulation.setSafeAreaInsetsOverride', { insets });
        for (const [width, height] of [[844, 390], [667, 375]]) {
          await page.setViewportSize({ width, height });
          await page.evaluate(() => dispatchEvent(new Event('resize')));
          await mapOpen(page);
          const report = await layout(page);
          reports.push(report);
          console.log(`safe-insets-l${level + 1}-${width}`, JSON.stringify({ panel: report.boxes['#map'], safe: report.safe, mapHit: report.mapHit }));
          await shot(page, `test-results/mobile-hud-final-l${level + 1}-${width}x${height}-safe.png`);
          await writeFile('test-results/mobile-hud-final.json', JSON.stringify({ reports, errors }, null, 2));
          checkLayout(report, insets);
          await bottomArrow(page, `final-l${level + 1}-${width}x${height}-safe`);
        }
        await session.send('Emulation.setSafeAreaInsetsOverride', { insets: {} });
        await session.detach();
        await page.evaluate(() => dispatchEvent(new Event('resize')));
      }
      await page.evaluate(() => window.__escape.game()!.toggleMap(false));
    }
    await context.close();
  }
  expect(errors).toEqual([]);
});
