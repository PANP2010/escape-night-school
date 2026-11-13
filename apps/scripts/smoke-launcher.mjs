import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserArgs } from '../../game/tests/browser-args.mjs';

const apps = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const { _electron } = createRequire(new URL('../../game/package.json', import.meta.url))('@playwright/test');
const output = join(apps, 'output/launcher-review');
await mkdir(output, { recursive: true });
const executableIndex = process.argv.indexOf('--executable');
const packagedExecutable = executableIndex >= 0 ? process.argv[executableIndex + 1] : undefined;
const electron = await _electron.launch({
  executablePath: packagedExecutable || require('electron'),
  args: [...browserArgs(['--mute-audio', '--renderer-process-limit=1']), ...(packagedExecutable ? [] : [apps])],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
});
const errors = [];
try {
  const page = await electron.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForSelector('#solo');
  await page.waitForFunction(() => document.querySelector('#version')?.textContent?.includes('个章节'));
  await page.evaluate(() => document.fonts.ready);
  const version = await page.locator('#version').innerText();
  const board = await page.evaluate(() => {
    const launcher = document.querySelector('#launcher');
    const texture = getComputedStyle(launcher, '::before').backgroundImage;
    if (!launcher.classList.contains('chalk-board') || !texture.includes('feTurbulence') || /\.webp|\.png/.test(texture))
      throw new Error('Native launcher must retain the code-drawn chalk board.');
    return { codeDrawn: true, texture: 'inline SVG turbulence' };
  });
  const screenshot = join(output, 'desktop-launcher.png');
  await page.screenshot({ path: screenshot });
  if (errors.length) throw new Error(errors.join('\n'));
  const report = { actualElectron: true, packaged: Boolean(packagedExecutable), muted: true, version, board, screenshot, errors };
  if (process.argv.includes('--solo')) {
    const opened = electron.waitForEvent('window');
    await page.click('#solo');
    const game = await opened;
    game.on('pageerror', error => errors.push(error.message));
    await game.waitForSelector('#create', { timeout: 45_000 });
    const address = game.url();
    if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(address)) throw new Error('Solo must use its bundled loopback server.');
    await game.fill('#name', '本地成品验收');
    await game.click('#create');
    await game.click('#start');
    await game.waitForFunction(() => window.__escape?.game()?.presentationReady, { timeout: 60_000 });
    const skip = game.locator('#intro-skip');
    if (await skip.isVisible()) await skip.click();
    await game.waitForFunction(() => !window.__escape.game().intro.active, { timeout: 20_000 });
    const before = await game.evaluate(() => { const g = window.__escape.game(); return { x: g.pos.x, z: g.pos.z, snaps: g.snaps }; });
    await game.locator('body > canvas').click();
    await game.keyboard.down('KeyW');
    await game.waitForTimeout(300);
    await game.keyboard.up('KeyW');
    await game.waitForFunction(({ x, z }) => { const g = window.__escape.game(); return Math.hypot(g.pos.x - x, g.pos.z - z) > .05; }, before, { timeout: 10_000 });
    const result = await game.evaluate(() => {
      const g = window.__escape.game(), gl = g.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { level: g.level.index, snaps: g.snaps, renderer: String(gl.getParameter(ext?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER)), x: g.pos.x, z: g.pos.z };
    });
    report.localGame = { address, before, ...result };
    report.gameScreenshot = join(output, 'desktop-local-game.png');
    await game.screenshot({ path: report.gameScreenshot });
    if (errors.length) throw new Error(errors.join('\n'));
  }
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally { await electron.close(); }
