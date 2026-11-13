// Same-device real WebSocket benchmark. TCP delay affects frames; CDP HTTP throttling does not.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { delayProxy } from './e2e/delay-proxy.mjs';
import { browserArgs } from './browser-args.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const build = process.env.ESC_DOOR_BUILD ?? root;
const port = Number(process.env.ESC_DOOR_PORT ?? 4495);
const label = process.env.ESC_DOOR_LABEL ?? 'after';
const out = `${root}/test-results/door-latency`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stats = xs => {
  const sorted = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return { n: sorted.length, p50: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))] };
};
const report = { label, build, started: new Date().toISOString(), cases: [], errors: [] };
let server, browser, proxy;
try {
  server = spawn(process.execPath, ['dist-server/index.js'], { cwd: build,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'development' }, stdio: 'ignore' });
  for (let i = 0; ; i++) {
    if (await fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.ok).catch(() => false)) break;
    if (i > 100) throw Error('server did not start'); await sleep(50);
  }
  browser = await chromium.launch({ args: browserArgs(['--mute-audio', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']) });
  for (const mobile of [false, true]) for (const rtt of [150, 250]) {
    proxy = await delayProxy('127.0.0.1', port, rtt / 2);
    const baseURL = `http://127.0.0.1:${proxy.port}`;
    const ctx = await browser.newContext({ baseURL, viewport: mobile ? { width: 844, height: 390 } : { width: 960, height: 540 },
      isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('pageerror', e => report.errors.push(e.message));
    await page.goto('/?steady'); await page.fill('#name', '响应基准'); await page.click('#create'); await page.click('#start');
    await page.waitForFunction(() => window.__escape.game()?.presentationReady && !window.__escape.game().intro.active);
    await page.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); window.__escape.debug('safe', 600); });
    await page.setViewportSize(mobile ? { width: 844, height: 390 } : { width: 960, height: 540 });
    const d = await page.evaluate(() => {
      const g = window.__escape.game();
      return g.doors.filter(d => (d.y0 ?? 0) === 0 && !g.regionLocked(d.id) && !g.doorLocked[d.id])
        .sort((a, b) => Math.hypot(a.x - g.pos.x, a.z - g.pos.z) - Math.hypot(b.x - g.pos.x, b.z - g.pos.z))[0];
    });
    await page.evaluate(d => window.__escape.debug('tp', d.x + (d.alongX ? 0 : 1.3), d.z + (d.alongX ? 1.3 : 0), 0), d);
    await page.waitForFunction(d => {
      const g = window.__escape.game(); return Math.hypot(g.pos.x - d.x - (d.alongX ? 0 : 1.3), g.pos.z - d.z - (d.alongX ? 1.3 : 0)) < .2;
    }, d);
    await page.evaluate(d => { const g = window.__escape.game(); g.input.yaw = d.alongX ? 0 : Math.PI / 2; g.input.pitch = -.1; }, d);
    await sleep(3500); // Let the opening title leave the real world/touch target clear.
    const peer = await ctx.newPage();
    await peer.goto('/?nodraw&steady'); await peer.fill('#name', '联机旁观');
    await peer.fill('#code', await page.evaluate(() => window.__escape.code)); await peer.click('#join');
    await peer.waitForFunction(() => window.__escape.game()?.presentationReady && !window.__escape.game().intro.active);
    await page.bringToFront();
    await page.evaluate(id => {
      const g = window.__escape.game(), p = window.__doorProbe = { id, rows: [], active: null, errors: [], baselineCorrections: g.corrections };
      const render = g.renderer.render.bind(g.renderer);
      g.renderer.render = (...args) => {
        const a = p.active;
        if (a && g.doorSwing[id] > .02 && a.visual === undefined) a.visual = performance.now();
        if (a && !g.doorOpen[id] && g.doorSwing[id] >= .5) p.errors.push('unconfirmed door passed collision threshold');
        if (a && g.doorOpen[id] && g.doorSwing[id] >= .5 && a.passable === undefined) a.passable = performance.now();
        return render(...args);
      };
      const send = g.net.send.bind(g.net);
      g.net.send = m => { if (p.active && (m.t === 'act' && m.kind === 'use' || m.t === 'door') && m.id === id) p.active.sent ??= performance.now(); return send(m); };
      const receive = window.__escape.net.onMsg;
      window.__escape.net.onMsg = m => {
        if (p.active && ['doors', 'snap'].includes(m.t) && m.doors?.some(d => d.id === id && d.open)) p.active.confirmed ??= performance.now();
        return receive(m);
      };
      addEventListener('keydown', e => { if (e.code === 'KeyE' && p.active) p.active.event ??= performance.now(); }, true);
      addEventListener('touchstart', e => { if (p.active) p.active.event ??= performance.now(); }, true);
    }, d.id);
    const rows = [];
    for (let i = 0; i < 5; i++) {
      await page.waitForFunction(id => { const g = window.__escape.game(); return !g.doorOpen[id] && g.doorSwing[id] === 0; }, d.id);
      await page.evaluate(() => { window.__doorProbe.active = { before: performance.now() }; });
      assert.equal(await page.evaluate(() => window.__escape.game().target()?.id), d.id);
      if (mobile) await page.locator('#touch-btns .main').tap(); else await page.keyboard.press('KeyE');
      await page.waitForFunction(() => window.__doorProbe.active.passable !== undefined);
      await peer.waitForFunction(id => window.__escape.game().doorOpen[id], d.id);
      const a = await page.evaluate(() => { const p = window.__doorProbe; const a = p.active; p.active = null; return a; });
      rows.push({ eventToSend: a.sent - a.event, eventToFirstVisual: a.visual - a.event,
        eventToPassable: a.passable - a.event, roundTrip: a.confirmed - a.sent });
      await page.evaluate(id => window.__escape.net.send({ t: 'door', id }), d.id);
      await peer.waitForFunction(id => !window.__escape.game().doorOpen[id], d.id);
      await sleep(500);
    }
    const final = await page.evaluate(() => {
      const g = window.__escape.game(), gl = g.renderer.getContext();
      return { errors: window.__doorProbe.errors, corrections: g.corrections - window.__doorProbe.baselineCorrections,
        renderer: gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL), triangles: g.renderer.info.render.triangles };
    });
    assert.deepEqual(final.errors, []); assert.equal(final.corrections, 0); assert.ok(final.triangles > 1000);
    const result = { mobile, rtt, door: d.id, rows, summary: Object.fromEntries(Object.keys(rows[0]).map(k => [k, stats(rows.map(r => r[k]))])), ...final };
    report.cases.push(result); console.log(JSON.stringify(result));
    await mkdir(out, { recursive: true }); await page.screenshot({ path: `${out}/${label}-${mobile ? 'phone' : 'desktop'}-${rtt}.png` });
    await ctx.close(); proxy.close(); proxy = undefined;
  }
  assert.deepEqual(report.errors, []); report.passed = true;
} catch (e) { report.error = e.stack ?? String(e); process.exitCode = 1; }
finally {
  proxy?.close(); await browser?.close(); server?.kill('SIGTERM');
  await mkdir(out, { recursive: true }); await writeFile(`${out}/${label}.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(report.error ?? `PASS ${report.cases.length} cases`);
}
