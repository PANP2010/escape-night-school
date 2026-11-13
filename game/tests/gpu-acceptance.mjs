// The GPU runner calls --renderer-only before executing any user command.
// Full acceptance: npm run build && ESC_GPU=1 node tests/gpu-acceptance.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { gpuOpeningReady } from './gpu-acceptance-state.mjs';

const rendererOnly = process.argv.includes('--renderer-only');
const dir = 'test-results/gpu';
const args = browserArgs(['--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']);
const report = { at: new Date().toISOString(), node: process.version, args, rendererOnly, passed: false };
let browser, server, page;
const watchdog = setTimeout(() => {
  console.error('GPU acceptance exceeded 180 seconds');
  server?.kill('SIGTERM');
  process.exit(1);
}, 180_000);

function rendererInfo(page, game = false) {
  return page.evaluate((game) => {
    const gl = game ? window.__escape.game().renderer.getContext()
      : document.createElement('canvas').getContext('webgl2');
    if (!gl) throw new Error('WebGL2 context creation failed');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
      version: gl.getParameter(gl.VERSION), contextLost: gl.isContextLost(),
    };
  }, game);
}

function assertNvidia(info) {
  assert.equal(info.contextLost, false, 'GPU context must remain live');
  assert.match(info.renderer ?? '', /NVIDIA/i, 'renderer must identify actual NVIDIA hardware');
  assert.doesNotMatch(info.renderer ?? '', /SwiftShader|llvmpipe|lavapipe|software/i,
    'software rendering cannot satisfy GPU acceptance');
}

async function startServer() {
  if (process.env.ESC_GPU_BASE_URL) return process.env.ESC_GPU_BASE_URL;
  const port = Number(process.env.ESC_GPU_PORT ?? 4290);
  server = spawn(process.execPath, ['dist-server/index.js'], {
    env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'inherit', 'inherit'],
  });
  server.on('error', (error) => { report.serverError = String(error); });
  const base = `http://127.0.0.1:${port}`;
  await expect.poll(async () => {
    if (server.exitCode !== null || report.serverError) throw new Error('built server failed to start');
    try { return (await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })).ok; }
    catch { return false; }
  }, { timeout: 30_000 }).toBe(true);
  return base;
}

await mkdir(dir, { recursive: true });
if (!rendererOnly) await rm(`${dir}/l1-1080p.png`, { force: true });
try {
  browser = await chromium.launch({ args, timeout: 45_000 });
  report.browserVersion = browser.version();
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  page = await context.newPage();
  report.renderer = await rendererInfo(page);
  assertNvidia(report.renderer);
  if (!rendererOnly) {
    const base = await startServer();
    // Match the local gate's documented existing low preset, with full 1080p drawing.
    await context.addInitScript(() => {
      localStorage.setItem('escape.settings', JSON.stringify({ pixelRatio: 1, postprocessing: false }));
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base, { timeout: 60_000 });
    await page.fill('#name', 'GPU验收');
    await page.click('#create');
    await page.click('#start');
    await expect(page.locator('#hud')).toBeVisible({ timeout: 60_000 });
    await page.waitForFunction(gpuOpeningReady, null, { timeout: 45_000 });
    report.gameRenderer = await rendererInfo(page, true);
    assertNvidia(report.gameRenderer);
    report.sample = await page.evaluate(() => new Promise((resolve) => {
      const g = window.__escape.game();
      const started = performance.now(), firstFrame = g.renderer.info.render.frame, firstSnaps = g.snaps;
      let frames = 0;
      const tick = () => {
        frames++;
        const elapsedMs = performance.now() - started;
        if (elapsedMs < 30_000) return requestAnimationFrame(tick);
        resolve({
          elapsedMs, frames, averageFps: frames * 1000 / elapsedMs,
          renderedFrames: g.renderer.info.render.frame - firstFrame,
          snapshots: g.snaps - firstSnaps, level: g.level.index, draw: g.draw,
          width: g.renderer.domElement.width, height: g.renderer.domElement.height,
        });
      };
      requestAnimationFrame(tick);
    }));
    assert.equal(report.sample.level, 0, 'the 30s sample must remain in L1');
    assert.equal(report.sample.draw, true);
    assert.ok(report.sample.renderedFrames > 30, 'the real game must keep drawing during the 30s sample');
    assert.ok(report.sample.snapshots > 30, 'the real WebSocket server must keep publishing');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${dir}/l1-1080p.png` });
  }
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.stack : String(error);
  if (page && !page.isClosed()) {
    try {
      report.lastState = await page.evaluate(() => {
        const g = window.__escape?.game();
        return g ? { level: g.level.index, presentationReady: g.presentationReady,
          spawnSynced: g.spawnSynced, canControl: g.canControl, introActive: g.intro.active,
          snaps: g.snaps, draw: g.draw, down: g.down } : { game: null };
      });
      if (!rendererOnly) await page.screenshot({ path: `${dir}/failure-1080p.png`, timeout: 5000 });
    } catch (diagnosticError) {
      report.diagnosticFailure = String(diagnosticError);
    }
  }
  process.exitCode = 1;
} finally {
  try {
    await writeFile(`${dir}/${rendererOnly ? 'renderer' : 'acceptance'}.json`, JSON.stringify(report, null, 2) + '\n');
  } finally {
    await browser?.close();
    server?.kill('SIGTERM');
    clearTimeout(watchdog);
  }
  console.log(JSON.stringify(report, null, 2));
}
