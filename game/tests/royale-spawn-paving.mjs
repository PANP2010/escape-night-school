// Fixed-camera evidence from the built game: night, low tier, torch/HUD off.
// Run against a real built server: BASE=http://127.0.0.1:4197 node tests/royale-spawn-paving.mjs before|after
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';

const tag = process.argv[2] ?? 'after';
assert.match(tag, /^(before|after)$/);
const baseURL = process.env.BASE ?? 'http://127.0.0.1:4197';
const out = `test-results/iter-47-${tag}`;
const browser = await chromium.launch({ args: browserArgs(['--mute-audio', '--no-sandbox']) });
const reports = [];
const watchdog = setTimeout(() => { console.error('spawn paving capture timed out'); process.exit(1); }, 240_000);
await mkdir('test-results', { recursive: true });
try {
  for (const [name, width, height] of [['desktop', 1280, 720], ['mobile', 844, 390]]) {
    const context = await browser.newContext({ baseURL, viewport: { width, height }, deviceScaleFactor: 1,
      isMobile: name === 'mobile', hasTouch: name === 'mobile' });
    await context.addInitScript(() => localStorage.setItem('escape.settings', JSON.stringify({ pixelRatio: 1, postprocessing: false })));
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('/?nodraw&steady&t=22:30');
    await page.fill('#name', '巡查小路');
    await page.selectOption('#mode-selector', 'royale');
    await page.click('#create');
    await page.click('#start');
    await page.waitForFunction(() => window.__escape?.game()?.presentationReady && window.__escape.game().snaps > 0,
      null, { timeout: 120_000 });
    const report = await page.evaluate(async () => {
      const g = window.__escape.game();
      g.view = { x: 6, y: 1.63, z: 192.3, yaw: 0, pitch: -0.12 };
      g.light = false;
      for (const sel of ['#hud', '#touch', '#map', '#loading', '#fade-overlay', '#blink-overlay'])
        for (const el of document.querySelectorAll(sel)) el.style.visibility = 'hidden';
      for (let i = 0; i < 3; i++) await new Promise(resolve => requestAnimationFrame(resolve));
      for (let i = 0; i < 2; i++) g.renderer.render(g.scene, g.camera);
      const canvas = g.renderer.domElement;
      const img = document.createElement('img');
      Object.assign(img.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh' });
      img.src = canvas.toDataURL();
      document.body.appendChild(img);
      await img.decode();
      const gl = g.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { view: g.view, light: g.light, camera: g.camera.position.toArray(),
        renderer: ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL),
        contextLost: gl.isContextLost(), snaps: g.snaps, triangles: g.renderer.info.render.triangles };
    });
    assert.equal(report.contextLost, false);
    assert.ok(report.snaps > 0 && report.triangles > 1000);
    assert.deepEqual(report.camera, [6, 1.63, 192.3]);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${out}-${name}.png` });
    reports.push({ name, ...report });
    console.log(JSON.stringify(reports.at(-1)));
    await context.close();
  }
} finally {
  await browser.close();
  clearTimeout(watchdog);
  await writeFile(`${out}.json`, JSON.stringify(reports, null, 2));
}
