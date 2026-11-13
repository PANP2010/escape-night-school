import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserArgs } from '../../game/tests/browser-args.mjs';

const apps = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const { _electron, chromium, expect } = createRequire(new URL('../../game/package.json', import.meta.url))('@playwright/test');
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const mode = arg('--mode') || 'solo', executable = arg('--executable');
assert.ok(['solo', 'lan', 'online'].includes(mode));
const output = join(apps, 'output/game-controls', mode);
await mkdir(output, { recursive: true });
const electron = await _electron.launch({ executablePath: executable || require('electron'),
  args: [...browserArgs(['--mute-audio']), ...(executable ? [] : [apps])],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } });
const errors = [], report = { actualElectron: true, packaged: Boolean(executable), mode, errors };
let browser;
try {
  const launcher = await electron.firstWindow();
  await launcher.waitForSelector('#solo');
  if (arg('--endpoint')) {
    await launcher.locator('details').evaluate(el => el.open = true);
    await launcher.fill('#endpoint', arg('--endpoint'));
  }
  if (mode === 'lan') { await launcher.click('#lan'); await launcher.waitForSelector('#host-play'); }
  const opened = electron.waitForEvent('window');
  await launcher.click(mode === 'lan' ? '#host-play' : `#${mode}`);
  const page = await opened;
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('#create', { timeout: 45_000 });
  await expect(page.locator('#lobby-connection')).toContainText('已连接');
  report.address = page.url();
  report.platform = await page.evaluate(() => window.nightSchoolNative);
  report.readOnlyPlatform = await page.evaluate(() => Object.isFrozen(window.nightSchoolNative));
  report.downloadsVisible = await page.locator('#native-downloads').isVisible();
  await page.fill('#name', `本地鼠标验收-${mode}`); await page.click('#create'); await page.click('#start');
  await page.waitForFunction(() => window.__escape?.game()?.presentationReady, null, { timeout: 60_000 });
  if (await page.locator('#intro-skip').isVisible()) await page.click('#intro-skip');
  await page.waitForFunction(() => !window.__escape.game().intro.active, null, { timeout: 20_000 });
  await page.evaluate(() => document.addEventListener('pointerlockerror', () => window.__pointerLockErrors = (window.__pointerLockErrors || 0) + 1));
  const canvas = page.locator('body > canvas');
  await canvas.click();
  try { await expect.poll(() => page.evaluate(() => !!document.pointerLockElement), { timeout: 3_000 }).toBe(true); }
  finally {
    report.pointerLock = await page.evaluate(() => ({ locked: document.pointerLockElement === window.__escape.game().renderer.domElement,
      errors: window.__pointerLockErrors || 0, enabled: window.__escape.game().input.enabled }));
  }
  const before = await page.evaluate(() => window.__escape.game().input.yaw);
  await page.mouse.move(400, 330); await page.mouse.move(480, 345);
  await expect.poll(() => page.evaluate(() => window.__escape.game().input.yaw)).not.toBe(before);
  report.look = { before, after: await page.evaluate(() => window.__escape.game().input.yaw) };
  // Escape releases capture; the normal settings and canvas gestures must still let the player resume.
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => !document.pointerLockElement)).toBe(true);
  if (await page.locator('#game-settings').isVisible()) await page.click('#settings-close');
  await canvas.click();
  await expect.poll(() => page.evaluate(() => document.pointerLockElement === window.__escape.game().renderer.domElement)).toBe(true);
  report.recapture = true;
  assert.equal(report.downloadsVisible, false, 'The installed desktop app must not offer another native download.');
  assert.equal(report.platform?.platform, 'desktop');
  assert.deepEqual(Object.keys(report.platform), ['platform']);
  assert.equal(report.readOnlyPlatform, true);
  await page.screenshot({ path: join(output, 'desktop-game.png') });
  await page.evaluate(() => document.exitPointerLock());
  // The same LAN/local server in a normal browser still advertises downloads and has no native privileges.
  browser = await chromium.launch({ headless: false, args: browserArgs(['--mute-audio']) });
  const web = await browser.newPage();
  web.on('pageerror', error => errors.push(error.message));
  await web.goto(report.address);
  await expect(web.locator('#native-downloads')).toBeVisible();
  assert.equal(await web.evaluate(() => window.nightSchoolNative), undefined);
  report.browserDownloadsVisible = true;
  await web.fill('#name', '浏览器视角验收'); await web.click('#create'); await web.click('#start');
  await web.waitForFunction(() => window.__escape?.game()?.presentationReady, null, { timeout: 60_000 });
  if (await web.locator('#intro-skip').isVisible()) await web.click('#intro-skip');
  await web.waitForFunction(() => !window.__escape.game().intro.active, null, { timeout: 20_000 });
  await web.bringToFront();
  await web.evaluate(() => document.addEventListener('pointerlockerror', () => window.__pointerLockErrors = (window.__pointerLockErrors || 0) + 1));
  await web.locator('body > canvas').click();
  try { await expect.poll(() => web.evaluate(() => !!document.pointerLockElement)).toBe(true); }
  finally { report.browserPointerLock = await web.evaluate(() => ({ focused: document.hasFocus(), locked: !!document.pointerLockElement,
    errors: window.__pointerLockErrors || 0, enabled: window.__escape.game().input.enabled,
    settings: window.__escape.game().settings.isOpen, intro: window.__escape.game().intro.active })); }
  const webBefore = await web.evaluate(() => window.__escape.game().input.yaw);
  await web.mouse.move(380, 300); await web.mouse.move(440, 315);
  await expect.poll(() => web.evaluate(() => window.__escape.game().input.yaw)).not.toBe(webBefore);
  report.browserMouseLook = true;
  const touch = await browser.newPage({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });
  touch.on('pageerror', error => errors.push(error.message));
  await touch.goto(`${report.address}?native=1&platform=desktop`);
  await expect(touch.locator('#native-downloads')).toBeVisible();
  await expect(touch.locator('#lobby-connection')).toContainText('已连接');
  assert.equal(await touch.evaluate(() => window.nightSchoolNative), undefined);
  report.touchDownloadsVisible = true;
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(report));
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close(); await electron.close();
}
