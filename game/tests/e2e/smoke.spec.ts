import { writeFileSync } from 'node:fs';
import { expect, test, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test';

// Contexts from browser.newContext() are not auto-closed; leftover software-WebGL pages starve later tests.
const opened: BrowserContext[] = [];
const newPage = async (browser: Browser, storageState: BrowserContextOptions['storageState']) => {
  const c = await browser.newContext({ storageState }); opened.push(c); return c.newPage();
};
test.afterEach(async () => { await Promise.all(opened.splice(0).map((c) => c.close())); });

const state = (page: Page) => page.evaluate(() => {
  const g = window.__escape.game();
  return { code: window.__escape.code, snaps: g?.snaps ?? 0, remotes: g?.remotes.size ?? 0, x: g?.pos.x ?? 0, z: g?.pos.z ?? 0 };
});

async function createRoom(page: Page, errors: string[]) {
  page.on('pageerror', (e) => errors.push(e.message));
  // cold start (first test of the suite): bundle/fonts/nav art load slowly under software WebGL
  await page.goto('/', { timeout: 60_000 });
  await page.fill('#name', '甲');
  await page.click('#create');
  await page.click('#start');
  await expect(page.locator('#hud')).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await state(page)).snaps, { timeout: 15_000 }).toBeGreaterThan(5);
}

test('a single 300ms W press moves the player on the first try', async ({ browser, storageState }) => {
  test.setTimeout(120_000);
  const a = await newPage(browser, storageState);
  const errors: string[] = [];
  await createRoom(a, errors);
  // World publication already draws the spawn. Wait for actual control authority: ten arbitrary rAFs can take
  // longer than the server's spawn protection under software GL, letting a catch/restart erase the first move.
  await a.waitForFunction(() => {
    const g = window.__escape.game();
    return !!g && g.presentationReady && g.canControl && !g.intro.active;
  }, null, { timeout: 15_000 });
  await a.locator('body > canvas').click();
  const before = await state(a);
  await a.keyboard.down('KeyW');
  await a.waitForTimeout(300);
  await a.keyboard.up('KeyW');
  // a cold software-WebGL frame can stall past the whole press (shader compile); Input.tapped carries the press to the
  // next frame, so poll for the move instead of reading once. Frames are dt-clamped (0.1 s → 0.26 m): require ≥1 frame of walk, not 300 ms worth.
  await expect.poll(async () => { const s = await state(a); return Math.hypot(s.x - before.x, s.z - before.z); }, { timeout: 10_000 }).toBeGreaterThan(0.05);
  expect(errors).toEqual([]);
});
