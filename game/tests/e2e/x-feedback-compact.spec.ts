import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { shot } from './draw.ts';
import { RESUME_KEY } from '../../client/src/reconnect.ts';
import { settingsShot } from './settings-controls.ts';

const evidence = 'test-results/feedback-compact';
const root = (page: Page) => page.locator('#game-settings');
const summary = (page: Page) => page.locator('#settings-open');
async function solo(page: Page, name: string) {
  if (page.url().startsWith('http')) await page.evaluate(key => sessionStorage.removeItem(key), RESUME_KEY);
  await page.goto('/?nodraw&steady');
  await page.fill('#name', name); await page.click('#create'); await page.click('#start');
  const ready = () => page.waitForFunction(() => {
    const g = window.__escape.game(); return g?.presentationReady && !g.intro.active;
  });
  await ready();
  // This fixture exercises the broadcast HUD and its floor-2 pickups. The standard
  // full-suite server starts at L1, so enter L4 explicitly instead of relying on a custom preview server.
  await page.evaluate(() => window.__escape.debug('level', 3));
  await page.waitForFunction(() => window.__escape.game()?.level.index === 3);
  await ready();
  await expect.poll(() => page.evaluate(() => window.__escape.game()?.snaps ?? 0)).toBeGreaterThan(2);
  await page.evaluate(async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    window.__escape.debug('safe', 600);
  });
  await expect(page.locator('#banner')).toBeHidden({ timeout: 15_000 });
  await expect(page.locator('#broadcast-status')).toContainText('午夜广播');
  mkdirSync(evidence, { recursive: true });
}
async function compact(page: Page, phone: boolean) {
  await expect(root(page)).not.toHaveAttribute('open');
  await expect(summary(page)).toHaveAccessibleName('设置');
  await expect(page.locator('#feedback-settings')).toHaveCount(0);
  await expect(summary(page)).toHaveCount(1);
  const geometry = await page.evaluate((phone) => {
    const rect = (selector: string) => {
      const r = document.querySelector(selector)!.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const settings = rect('#settings-open');
    const neighbors = ['#room-code', '#broadcast-status', ...(phone ? ['#touch-map', '#touch-base'] : [])]
      .map(selector => ({ selector, ...rect(selector) }));
    return { settings, neighbors, renderer: (() => {
      const gl = window.__escape.game()!.renderer.getContext(), info = gl.getExtension('WEBGL_debug_renderer_info');
      return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    })() };
  }, phone);
  expect(geometry.settings.width).toBeGreaterThanOrEqual(44); expect(geometry.settings.height).toBe(44);
  for (const n of geometry.neighbors) {
    expect(geometry.settings.right <= n.x || n.right <= geometry.settings.x ||
      geometry.settings.bottom <= n.y || n.bottom <= geometry.settings.y, n.selector).toBe(true);
  }
  return geometry;
}

test.describe('desktop single settings entry', () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test('single entry, keyboard controls, Escape, outside close and saved preferences', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    await solo(page, '桌面小设置');
    const geometry = await compact(page, false);
    await shot(page, `${evidence}/desktop-closed.png`);
    await summary(page).focus(); await page.keyboard.press('Enter');
    await expect(root(page)).toHaveAttribute('open', '');
    await settingsShot(page, `${evidence}/desktop-open.png`);
    await expect(page.locator('#settings-close')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#settings-sensitivity')).toBeFocused();
    await page.keyboard.press('Tab');
    const volume = page.getByRole('slider', { name: '音效音量', exact: true });
    await expect(volume).toBeFocused(); await volume.press('Home');
    await expect(volume).toHaveAttribute('aria-valuetext', '0%');
    await page.keyboard.press('Tab'); await expect(page.locator('#settings-muted')).toBeFocused();
    await page.keyboard.press('Space'); await expect(page.locator('#settings-muted')).toBeChecked();
    await page.keyboard.press('Tab'); await expect(page.locator('#settings-haptics')).toBeFocused();
    await page.keyboard.press('Space'); await expect(page.locator('#settings-haptics')).not.toBeChecked();
    const before = await page.evaluate(() => ({ ...window.__escape.game()!.pos, light: window.__escape.game()!.light }));
    await page.keyboard.press('KeyF'); await page.keyboard.press('KeyW');
    expect(await page.evaluate(() => ({ ...window.__escape.game()!.pos, light: window.__escape.game()!.light }))).toEqual(before);
    await page.keyboard.press('Escape');
    await expect(root(page)).not.toHaveAttribute('open'); await expect(summary(page)).toBeFocused();
    await summary(page).click(); await volume.focus(); await page.mouse.click(5, 5);
    await expect(root(page)).not.toHaveAttribute('open'); await expect(page.locator('#settings-volume')).not.toBeFocused();
    await page.keyboard.press('KeyF');
    await expect.poll(() => page.evaluate(() => window.__escape.game()!.light)).toBe(!before.light);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('escape.feedback')!))).toEqual({ volume: 0, muted: true, haptics: false });
    await solo(page, '设置保留'); await compact(page, false); await summary(page).click();
    await expect(page.locator('#settings-volume')).toHaveValue('0');
    await expect(page.locator('#settings-muted')).toBeChecked(); await expect(page.locator('#settings-haptics')).not.toBeChecked();
    writeFileSync(`${evidence}/desktop.json`, JSON.stringify({ geometry, errors }, null, 2));
    expect(errors).toEqual([]);
  });
});

for (const size of [{ width: 844, height: 390 }, { width: 667, height: 375 }]) {
  test.describe(`phone single settings entry ${size.width}`, () => {
    test.use({ viewport: size, hasTouch: true, isMobile: true });
    test('tap controls, map overlay and world pickup after closing remain usable', async ({ page }) => {
      const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
      const acts: unknown[] = []; page.on('websocket', ws => ws.on('framesent', frame => {
        try { const m = JSON.parse(String(frame.payload)); if (m.t === 'act') acts.push(m); } catch { /* binary */ }
      }));
      await solo(page, `手机${size.width}`); await page.setViewportSize(size);
      const geometry = await compact(page, true);
      await shot(page, `${evidence}/phone-${size.width}-closed.png`);
      await summary(page).tap(); await expect(root(page)).toHaveAttribute('open', '');
      const open = await root(page).boundingBox();
      expect(open!.y).toBeGreaterThanOrEqual(12);
      expect(open!.y + open!.height).toBeLessThanOrEqual(size.height - 12);
      await settingsShot(page, `${evidence}/phone-${size.width}-open.png`);
      const before = await page.evaluate(() => ({ ...window.__escape.game()!.pos, yaw: window.__escape.game()!.input.yaw, light: window.__escape.game()!.light }));
      const volume = page.locator('#settings-volume');
      await volume.scrollIntoViewIfNeeded(); const slider = await volume.boundingBox();
      await page.touchscreen.tap(slider!.x + slider!.width * .3, slider!.y + slider!.height / 2);
      await page.locator('#settings-muted').tap(); await expect(page.locator('#settings-muted')).toBeChecked();
      await page.locator('#settings-haptics').tap(); await expect(page.locator('#settings-haptics')).not.toBeChecked();
      await settingsShot(page, `${evidence}/phone-${size.width}-controls.png`);
      expect(await page.evaluate(() => ({ ...window.__escape.game()!.pos, yaw: window.__escape.game()!.input.yaw, light: window.__escape.game()!.light }))).toEqual(before);
      expect(acts).toEqual([]);
      await page.locator('#settings-close').tap();
      await expect(root(page)).not.toHaveAttribute('open');
      // Returning from the modal restores the existing touch/world interaction pipeline.
      const item = await page.evaluate(() => {
        const g = window.__escape.game() as any;
        const item = g.items.find((i: any) => i.kind === 'battery' && i.p[1] < 10);
        window.__escape.debug('tp', item.p[0] + .8, item.p[2], 2); return item;
      });
      await expect.poll(() => page.evaluate(x => Math.abs(window.__escape.game()!.pos.x - x), item.p[0] + .8)).toBeLessThan(.2);
      await expect.poll(() => page.evaluate(() => {
        const g = window.__escape.game()!;
        return Math.hypot(g.camera.position.x - g.pos.x, g.camera.position.z - g.pos.z);
      }), { timeout: 15_000 }).toBeLessThan(.01);
      await page.evaluate(p => {
        const g = window.__escape.game()!;
        const dx = p[0] - g.camera.position.x, dz = p[2] - g.camera.position.z;
        g.input.yaw = Math.atan2(-dx, -dz) + .45;
        g.input.pitch = Math.atan2(p[1] + .03 - g.camera.position.y, Math.hypot(dx, dz));
      }, item.p);
      // A screenshot can delay the next nodraw animation frame. Wait for the actual view to aim,
      // rather than projecting the item through the previous frame's camera rotation.
      await expect.poll(() => page.evaluate(() => {
        const g = window.__escape.game()!;
        return Math.abs(g.camera.rotation.x - g.input.pitch) + Math.abs(g.camera.rotation.y - g.input.yaw);
      }), { timeout: 15_000 }).toBeLessThan(.001);
      const point = await page.evaluate(id => {
        const g = window.__escape.game() as any;
        // nodraw skips renderer.render(), which normally refreshes this matrix after moving/aiming.
        g.camera.updateMatrixWorld();
        const v = g.itemMeshes.get(id).position.clone().project(g.camera);
        return { x: (v.x + 1) * innerWidth / 2, y: (1 - v.y) * innerHeight / 2 };
      }, item.id);
      expect(point.x).toBeGreaterThan(0);
      expect(point.x).toBeLessThan(size.width);
      expect(point.y).toBeGreaterThan(0); expect(point.y).toBeLessThan(size.height);
      await page.touchscreen.tap(point.x, point.y);
      await expect(root(page)).not.toHaveAttribute('open');
      await expect.poll(() => page.evaluate(id => (window.__escape.game() as any).items.some((i: any) => i.id === id), item.id)).toBe(false);
      await page.locator('#touch-map').tap(); await expect(page.locator('#map')).toBeVisible(); await expect(summary(page)).toBeHidden();
      await page.locator('#touch-map').tap(); await expect(page.locator('#map')).toBeHidden(); await compact(page, true);
      const yaw = await page.evaluate(() => window.__escape.game()!.input.yaw);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 420, y: 210 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 500, y: 210 }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect.poll(() => page.evaluate(() => window.__escape.game()!.input.yaw)).not.toBe(yaw);
      writeFileSync(`${evidence}/phone-${size.width}.json`, JSON.stringify({ geometry, open, point, acts, errors }, null, 2));
      expect(errors).toEqual([]);
    });
  });
}
