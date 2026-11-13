// Real game canvas, two independent Chromium GPU processes, authoritative WS.
// Run against the local acceptance server on 4290: node tests/probe-gpu.mjs
// ESC_SOFTWARE_GL=1 node tests/probe-gpu.mjs verifies the software fallback.
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { assertDebugAvailable } from './helpers.mjs';

const nvidia = process.platform === 'linux' && process.env.ESC_GPU === '1' && process.env.ESC_SOFTWARE_GL !== '1';
const software = !nvidia && (process.platform !== 'darwin' || process.env.ESC_SOFTWARE_GL === '1');
const mode = nvidia ? 'nvidia' : software ? 'software' : 'metal';
const dir = `test-results/gpu-probe-${mode}`;
const args = browserArgs(['--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']);
const evidence = { at: new Date().toISOString(), platform: process.platform, mode, args, clients: [], errors: [], passed: false };
const browsers = [];
async function sampleWithTimeout(page) {
  let timer;
  try {
    return await Promise.race([
      sampleRenderer(page),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('GPU frame sample timed out')), 15_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function sampleRenderer(page) {
  return page.evaluate(async () => {
    const g = window.__escape.game();
    const gl = g.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const started = performance.now(), firstFrame = g.renderer.info.render.frame;
    const frames = await new Promise((resolve) => {
      let count = 0;
      const end = performance.now() + 1000;
      const tick = () => { count++; if (performance.now() >= end) resolve(count); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });
    return {
      vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
      version: gl.getParameter(gl.VERSION), contextLost: gl.isContextLost(),
      framesInOneSecond: frames, elapsedMs: performance.now() - started,
      renderFrameDelta: g.renderer.info.render.frame - firstFrame,
      draw: g.draw, renderCalls: g.renderer.info.render.calls,
      triangles: g.renderer.info.render.triangles, snaps: g.snaps,
      id: g.myId, remotes: [...g.remotes.keys()],
    };
  });
}
await mkdir(dir, { recursive: true });
// A failed rerun must not leave screenshots from an earlier successful probe
// beside its new failure report.
await Promise.all(['renderer.json', 'client-1.png', 'client-2.png'].map((file) =>
  rm(`${dir}/${file}`, { force: true })));
try {
  const pages = [];
  for (const name of ['GPU甲', 'GPU乙']) {
    const browser = await chromium.launch({ args });
    browsers.push(browser);
    const page = await browser.newPage({ baseURL: 'http://127.0.0.1:4290', viewport: { width: 960, height: 600 } });
    page.on('pageerror', (error) => evidence.errors.push({ name, message: error.message }));
    await page.goto('/?steady');
    await page.fill('#name', name);
    pages.push(page);
  }
  const [a, b] = pages;
  await a.click('#create');
  await expect(a.locator('#wait-code')).not.toBeEmpty();
  const code = await a.evaluate(() => window.__escape.code);
  await b.fill('#code', code);
  await b.click('#join');
  for (const page of pages) await expect(page.locator('#wait-members li')).toHaveCount(2);
  await a.click('#start');
  for (const page of pages) {
    await expect(page.locator('#hud')).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => page.evaluate(() => {
      const g = window.__escape.game();
      return !!g?.spawnSynced && g.snaps > 5 && g.remotes.size === 1 && g.renderer.info.render.calls > 0;
    }), { timeout: 30_000 }).toBe(true);
  }
  await assertDebugAvailable(a);
  await a.evaluate(() => window.__escape.debug('safe', 600, 1));
  const samples = await Promise.allSettled(pages.map(sampleWithTimeout));
  // Keep each client's result even if its peer stalls or an assertion fails.
  evidence.clients = samples.map((sample, i) => ({
    browserVersion: browsers[i].version(),
    ...(sample.status === 'fulfilled' ? sample.value : { sampleError: String(sample.reason) }),
  }));
  for (const [i, page] of pages.entries()) {
    const sample = samples[i];
    if (sample.status === 'rejected') throw sample.reason;
    const info = sample.value;
    assert.ok(info.renderer, 'WEBGL_debug_renderer_info must expose the actual game renderer');
    assert.equal(info.contextLost, false);
    assert.equal(info.draw, true, 'both real clients must render the scene continuously');
    assert.ok(info.framesInOneSecond >= 2, 'the client animation loop must continue');
    assert.ok(info.renderFrameDelta >= 2, 'the game must draw new WebGL frames during the sample');
    if (software) assert.match(info.renderer, /SwiftShader/i);
    else {
      assert.match(info.renderer, nvidia ? /NVIDIA/i : /Apple/i);
      if (!nvidia) assert.match(info.renderer, /Metal/i);
      assert.doesNotMatch(info.renderer, /SwiftShader|llvmpipe|lavapipe|software/i);
    }
    await page.screenshot({ path: `${dir}/client-${i + 1}.png` });
  }
  assert.equal(evidence.clients[0].remotes[0], evidence.clients[1].id);
  assert.equal(evidence.clients[1].remotes[0], evidence.clients[0].id);
  assert.deepEqual(evidence.errors, []);
  evidence.passed = true;
} catch (error) {
  evidence.failure = error instanceof Error ? error.stack : String(error);
  throw error;
} finally {
  try {
    await writeFile(`${dir}/renderer.json`, JSON.stringify(evidence, null, 2) + '\n');
  } finally {
    await Promise.all(browsers.map((browser) => browser.close()));
  }
  console.log(JSON.stringify({ mode, passed: evidence.passed, renderers: evidence.clients.map((c) => c.renderer), evidence: `${dir}/renderer.json` }));
}
