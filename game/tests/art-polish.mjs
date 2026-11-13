import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const quick = process.env.ESC_ART_QUICK === '1';
const out = `${root}/test-results/art-polish${quick ? '-quick' : ''}`;
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ args: browserArgs(['--mute-audio']) });
const report = { started: new Date().toISOString(), cases: [], errors: [] };
const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let server;
try {
  for (const label of ['before', 'after']) {
    const cwd = label === 'before' ? '/private/tmp/escape-art-baseline-20261107' : root;
    const port = label === 'before' ? 4496 : 4497;
    server = spawn(process.execPath, ['dist-server/index.js'], { cwd, env: { ...process.env, PORT: String(port), NODE_ENV: 'development' }, stdio: 'ignore' });
    for (let n = 0; ; n++) {
      if (await fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.ok).catch(() => false)) break;
      if (n > 100) throw Error('server start failed'); await sleep(50);
    }
    const context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', e => report.errors.push(e.message));
    await page.goto('/?steady'); await page.fill('#name', '美术验收'); await page.click('#create'); await page.click('#start');
    await page.waitForFunction(() => window.__escape.game()?.presentationReady && !window.__escape.game().intro.active);
    await page.evaluate(async () => {
      if (document.fullscreenElement) await document.exitFullscreen();
      window.__escape.debug('safe', 600);
      const g = window.__escape.game(); g.draw = false; g.guideAt = Infinity;
      g.input.yaw = 0; g.input.pitch = 0; g.arrowOn = true;
    });
    await page.waitForTimeout(4000);
    const session = await context.newCDPSession(page);
    for (const [width, height, inset] of quick ? [[667, 375, 0]] : [[844, 390, 0], [667, 375, 0], [932, 430, 34]]) {
      await page.setViewportSize({ width, height });
      await session.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: inset ? 46 : 0, right: inset ? 46 : 0, bottom: inset } });
      await page.waitForTimeout(200);
      const result = { label, width, height, inset, rows: [], overlaps: [] };
      for (const floating of quick ? [true] : [false, true]) {
        if (floating) await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 210, y: height - 95 }] });
        for (const [nx, ny] of quick ? [[-4, -4]] : [[-4, -4], [-1, -1], [0, -5], [1, -1], [4, -4], [-4, 0], [4, 0], [0, 0], [-1, 1], [1, 1]]) {
          await page.evaluate(({ nx, ny }) => {
            const g = window.__escape.game(), p = g.camera.position.clone().set(nx, ny, .8).unproject(g.camera);
            g.guideAt = Infinity;
            g.guide = { x: p.x, y: p.y, z: p.z, dist: 100, goal: { x: p.x, y: p.y, z: p.z, exact: true, label: '贴纸③ · 3楼' } };
          }, { nx, ny });
          await page.waitForTimeout(170);
          const row = await page.evaluate(() => {
            const read = e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
            const tag = read(document.querySelector('#goal-arrow .d')), marker = read(document.querySelector('#goal-arrow .ar'));
            const arrow = { left: Math.min(tag.left, marker.left), right: Math.max(tag.right, marker.right), top: Math.min(tag.top, marker.top), bottom: Math.max(tag.bottom, marker.bottom) };
            const controls = ['touch-base', 'touch-btns', 'battery', 'stamina', 'keys', 'objective', 'touch-map', 'touch-chat'].flatMap(id => {
              const e = document.getElementById(id), r = e && read(e);
              return e && !e.hidden && r.right > r.left && r.bottom > r.top ? [{ id, ...r }] : [];
            });
            return { arrow, controls, angle: document.getElementById('goal-arrow').dataset.a };
          });
          const collisions = row.controls.filter(c => overlap(row.arrow, c)).map(c => c.id);
          result.rows.push({ nx, ny, floating, ...row, collisions });
          if (collisions.length) result.overlaps.push({ nx, ny, floating, collisions });
          if (label === 'after') {
            assert.deepEqual(collisions, [], `${width}x${height}, ${nx},${ny}, floating=${floating}`);
            assert.ok(row.arrow.left >= 0 && row.arrow.right <= width && row.arrow.top >= 0 && row.arrow.bottom <= height);
          }
          if (nx === -4 && ny === -4 && (!floating || quick)) {
            await page.evaluate(async () => {
              const g = window.__escape.game(); g.renderer.render(g.scene, g.camera); g.renderer.render(g.scene, g.camera);
              const img = document.createElement('img'); img.id = 'art-frame'; img.src = g.renderer.domElement.toDataURL();
              Object.assign(img.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', zIndex: '0', pointerEvents: 'none' });
              g.renderer.domElement.after(img); await img.decode();
            });
            await page.screenshot({ path: `${out}/${label}-arrow-${width}.png` });
            await page.evaluate(() => document.getElementById('art-frame')?.remove());
          }
        }
        if (floating) await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      }
      report.cases.push(result);
      console.log(`${label} ${width}x${height}: ${result.overlaps.length}/${result.rows.length} overlapping placements`);
    }
    await session.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 0, left: 0, right: 0, bottom: 0 } });
    await page.setViewportSize({ width: 1000, height: 650 });
    const bench = await page.evaluate(async () => {
      const g = window.__escape.game(); g.draw = false;
      g.camera.position.set(-6.5, 1.35, 24.2); g.camera.lookAt(-8.4, .5, 23);
      g.camera.updateMatrixWorld(); g.flashlight.visible = true; g.campus.update(0, g.camera);
      document.getElementById('hud').style.visibility = 'hidden'; document.getElementById('touch').style.visibility = 'hidden';
      g.renderer.render(g.scene, g.camera); g.renderer.render(g.scene, g.camera);
      const info = { calls: g.renderer.info.render.calls, triangles: g.renderer.info.render.triangles };
      const img = document.createElement('img'); img.id = 'art-frame'; img.src = g.renderer.domElement.toDataURL();
      Object.assign(img.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', zIndex: '10', pointerEvents: 'none' });
      g.renderer.domElement.after(img); await img.decode(); return info;
    });
    await page.screenshot({ path: `${out}/${label}-bench.png` });
    report[`${label}Bench`] = bench;
    console.log(`${label} bench: ${JSON.stringify(bench)}`);
    await context.close(); server.kill(); server = undefined;
    await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  }
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (e) { report.error = e.stack; process.exitCode = 1; }
finally {
  server?.kill(); await browser.close();
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(report.error ?? 'PASS');
}
