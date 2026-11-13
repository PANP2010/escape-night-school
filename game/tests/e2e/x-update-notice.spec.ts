import { devices, expect, test, type Page } from '@playwright/test';
import published from '../../client/public/version.json' with { type: 'json' };
import { shot } from './draw';

/** Checks immediately through the same recovery path used when connectivity returns. */
async function checkAgain(page: Page) {
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/version.json');
  await page.evaluate(() => dispatchEvent(new Event('online')));
  await (await response).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

test('release metadata is deployed, notes close/reopen by keyboard, and seen state is per version and browser', async ({ page, request, browser }) => {
  const response = await request.get('/version.json');
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(response.headers()['content-type']).toContain('application/json');
  expect(await response.json()).toEqual(published);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem('escape.updates.seen.0.2.0', '1'));
  await page.goto('/');
  const details = page.locator('#updates-details');
  const toggle = page.getByRole('button', { name: '更新内容', exact: true });
  await expect(details).toBeVisible();
  await expect(page.locator('#updates')).toContainText(`v${published.id}`);
  await expect(page.locator('.updates-teaser')).toHaveText(published.entries[0]);
  await page.screenshot({ path: 'test-results/update-notice-desktop.png' });
  await page.getByRole('button', { name: '关闭更新内容' }).focus();
  await page.keyboard.press('Enter');
  await expect(details).toBeHidden();
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(details).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(details).toBeHidden();
  await page.reload();
  await expect(details).toBeHidden();
  await expect(page.locator('.updates-teaser')).toBeVisible();
  const independent = await browser.newContext();
  const fresh = await independent.newPage();
  await fresh.goto(page.url());
  await expect(fresh.locator('#updates-details')).toBeVisible();
  await independent.close();
});

test('request failures recover silently and first success establishes a baseline even for a cached client', async ({ page }) => {
  let status = 503;
  let record: unknown = { ...published, id: '0.3.1' };
  let requests = 0;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/version.json', async (route) => {
    requests++;
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(record) });
  });
  await page.goto('/');
  await expect.poll(() => requests).toBe(1);
  await expect(page.locator('#update-available')).toBeHidden();
  status = 200;
  await checkAgain(page); // first success: only establish the server baseline
  await expect(page.locator('#update-available')).toBeHidden();
  await checkAgain(page); // the client is still on the prior version
  await expect(page.locator('#update-available')).toContainText('v0.3.1');
  record = { invalid: true };
  await checkAgain(page);
  await expect(page.locator('#update-available')).toContainText('v0.3.1');
  record = published;
  await checkAgain(page);
  await expect(page.locator('#update-available')).toBeHidden();
  expect(errors).toEqual([]);
});

test('new deployment stays passive during a live mobile session; refresh requires a player action after completion', async ({ browser, baseURL }) => {
  const { defaultBrowserType: _type, ...mobile } = devices['iPhone 13 landscape'];
  const context = await browser.newContext({ ...mobile, baseURL });
  const page = await context.newPage();
  let record = published;
  let requests = 0;
  let navigations = 0;
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations++; });
  await page.route('**/version.json', (route) => {
    requests++;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(record) });
  });
  await page.goto('/?nodraw');
  await expect.poll(() => requests).toBe(1);
  await page.fill('#name', '更新测试');
  await page.click('#create');
  await expect(page.locator('#waiting')).toBeVisible();
  await page.click('#start');
  await expect(page.locator('#hud')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => window.__escape.game()?.snaps ?? 0)).toBeGreaterThan(1);
  const before = await page.evaluate(() => window.__escape.game()!.snaps);
  const originalNavigations = navigations;
  record = { ...published, id: '0.3.1' };
  await checkAgain(page);
  await expect(page.locator('#update-available')).toHaveText('新版本已上线，本局结束后刷新体验。刷新体验');
  await expect(page.locator('#update-available button')).toBeHidden();
  expect(await page.locator('#update-available').evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');
  await expect.poll(() => page.evaluate(() => window.__escape.game()!.snaps)).toBeGreaterThan(before);
  expect(navigations).toBe(originalNavigations);
  // The level introduction temporarily hides this panel; measure the regular playing HUD.
  await expect(page.locator('#objective')).toBeVisible();
  const notice = await page.locator('#update-available').boundingBox();
  for (const selector of ['#room-code', '#objective', '#touch-map', '#touch-chat', '#settings-open', '#host-status', '.story-view__toggle']) {
    const control = await page.locator(selector).boundingBox();
    expect(control, selector).not.toBeNull();
    const overlaps = notice!.x < control!.x + control!.width && notice!.x + notice!.width > control!.x &&
      notice!.y < control!.y + control!.height && notice!.y + notice!.height > control!.y;
    expect(overlaps, `notice must not cover ${selector}`).toBe(false);
  }
  await page.locator('#touch-map').tap();
  await expect(page.locator('#map')).toBeVisible();
  await expect(page.locator('#update-available')).toBeHidden();
  await page.screenshot({ path: 'test-results/update-notice-mobile-map.png' });
  await page.locator('#map .close').tap();
  await expect(page.locator('#update-available')).toBeVisible();
  await page.evaluate(() => window.__escape.net.onMsg({ t: 'fade', secs: 0.1, restart: true }));
  await expect(page.locator('#update-available button')).toBeHidden();
  await expect(page.locator('#fade-overlay')).toBeHidden();
  await shot(page, 'test-results/update-notice-playing.png');
  // Exercise the real completion handler without playing all eight chapters in a UI test.
  await page.evaluate(() => window.__escape.net.onMsg({ t: 'complete', level: 7 }));
  const refresh = page.locator('#update-available button');
  await expect(refresh).toBeVisible();
  await refresh.focus();
  await refresh.press('Enter');
  await expect(page.locator('#lobby')).toBeVisible();
  expect(navigations).toBe(originalNavigations + 1);
  await context.close();
});

test('storage blocked: mobile notes stay readable and entry controls still work', async ({ browser, baseURL }) => {
  const { defaultBrowserType: _type, ...mobile } = devices['iPhone 13 landscape'];
  const context = await browser.newContext({ ...mobile, baseURL });
  await context.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage blocked', 'SecurityError'); } });
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#updates-details')).toBeVisible();
  // The public lobby scrolls vertically on landscape phones; both sections stay reachable.
  await page.locator('#create').scrollIntoViewIfNeeded();
  await expect(page.locator('#create')).toBeInViewport();
  await page.getByRole('button', { name: '关闭更新内容' }).scrollIntoViewIfNeeded();
  await expect(page.getByRole('button', { name: '关闭更新内容' })).toBeInViewport();
  const notes = await page.locator('#updates').boundingBox();
  const entry = await page.locator('#entry').boundingBox();
  expect(entry!.y + entry!.height).toBeLessThanOrEqual(notes!.y);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/update-notice-mobile.png' });
  await page.getByRole('button', { name: '关闭更新内容' }).click();
  await expect(page.locator('#updates-details')).toBeHidden();
  await page.getByRole('button', { name: '更新内容', exact: true }).click();
  await expect(page.locator('#updates-details')).toBeVisible();
  await page.fill('#name', '手机玩家');
  await page.click('#create');
  await expect(page.locator('#waiting')).toBeVisible();
  await expect(page.locator('#wait-members')).toContainText('手机玩家');
  expect(errors).toEqual([]);
  await context.close();
});
