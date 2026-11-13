// From game/:
// python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npm run build
// python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- node tests/shot-monitor-animation.mjs
// Owns only its server on 4434; does not reuse or stop an existing server.
// Real L2/ws checks come first. The labelled replay then feeds the same Mobs and MonitorAnimator
// deterministic snapshots in a small review scene; it does not replace the animation implementation.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';

const out = resolve('test-results/monitor-animation');
const baseURL = 'http://127.0.0.1:4434';
mkdirSync(out, { recursive: true });
const report = { passed: false, errors: [], live: {}, replay: {}, externalVideoScore: '未外部评分：本会话没有可调用的 Gemini 视频工具。' };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const findFfmpeg = () => {
  if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0) return 'ffmpeg';
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  try {
    for (const dir of readdirSync(cache).filter((name) => name.startsWith('ffmpeg-'))) {
      for (const file of readdirSync(join(cache, dir)).filter((name) => /^ffmpeg(?:-|\.)/.test(name))) {
        const bin = join(cache, dir, file);
        if (spawnSync(bin, ['-version'], { stdio: 'ignore' }).status === 0) return bin;
      }
    }
  } catch { /* Raw Playwright video remains available without a trimming binary. */ }
  return undefined;
};
let server, browser, context, page, video, videoEpoch;
const serverLog = createWriteStream(resolve(out, 'server.log'));

try {
  const occupied = await fetch(`${baseURL}/healthz`).then(() => true).catch(() => false);
  assert.equal(occupied, false, '4434 is occupied; refusing to reuse or stop another server');
  server = spawn(process.execPath, ['dist-server/index.js'], {
    cwd: process.cwd(), env: { ...process.env, PORT: '4434', HOST: '127.0.0.1', NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.pipe(serverLog); server.stderr.pipe(serverLog);
  for (let i = 0; ; i++) {
    if (await fetch(`${baseURL}/healthz`).then((r) => r.ok).catch(() => false)) break;
    assert.ok(i < 100 && server.exitCode === null, 'built server did not become ready');
    await pause(100);
  }
  const args = browserArgs(['--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']);
  assert.ok(args.includes('--use-angle=metal'), 'this evidence run requires Metal');
  browser = await chromium.launch({ headless: true, args });
  context = await browser.newContext({ baseURL, viewport: { width: 960, height: 540 }, deviceScaleFactor: 1,
    recordVideo: { dir: out, size: { width: 960, height: 540 } } });
  videoEpoch = Date.now();
  page = await context.newPage(); video = page.video();
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.goto('/?steady');
  await page.fill('#name', '值日生动作验收');
  await page.click('#create'); await page.click('#start');
  await page.waitForFunction(() => window.__escape.game()?.spawnSynced, null, { timeout: 90_000 });
  await page.evaluate(() => { window.__escape.debug('safe', 600, 1); window.__escape.debug('key', -1); window.__escape.debug('tp', -61, 66); });
  await page.waitForFunction(() => window.__escape.game()?.level.index === 1, null, { timeout: 30_000 });
  await page.evaluate(() => { window.__escape.debug('safe', 600, 1); window.__escape.debug('safe', 600, 2); });
  await page.waitForSelector('#fade-overlay', { state: 'hidden', timeout: 20_000 });
  await page.waitForFunction(() => window.__escape.game()?.spawnSynced && window.__escape.game()?.body.y > 3, null, { timeout: 20_000 });
  report.renderer = await page.evaluate(() => {
    const gl = window.__escape.game().renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
  assert.match(report.renderer, /Apple|Metal/i);
  const place = async (distance) => {
    await page.evaluate(() => {
      window.__escape.debug('tp', 40, 84.2);
      const g = window.__escape.game(); g.light = true; g.input.yaw = Math.PI / 2; g.input.pitch = -0.08;
    });
    await page.waitForFunction(() => {
      const g = window.__escape.game(); return Math.hypot(g.body.x - 40, g.body.z - 84.2) < 0.2;
    }, null, { timeout: 10_000 });
    await page.waitForTimeout(150);
    await page.evaluate((d) => window.__escape.debug('monitor', d), distance);
    await page.waitForFunction(() => window.__escape.game().mobs.byId.get(2)?.anim === 'freeze', null, { timeout: 10_000 });
  };
  const sample = () => page.evaluate(() => {
    const g = window.__escape.game(), o = g.mobs.byId.get(2);
    o.mesh.updateMatrixWorld(true);
    return { at: performance.now(), anim: o.anim, p: o.mesh.position.toArray(), phase: o.monitorAnim.phase,
      frozen: o.monitorAnim.frozen, bones: Object.fromEntries(Object.entries(o.warden.bones).map(([k, b]) => [k, [...b.position.toArray(), ...b.quaternion.toArray()]])) };
  });
  const shot = async (name) => {
    await page.waitForFunction(() => document.getElementById('blink-overlay').hidden);
    await page.screenshot({ path: resolve(out, name) });
  };
  await place(4.5);
  await shot('live-first-freeze-front.png');
  report.live.firstFreeze = [await sample()];
  await page.waitForTimeout(450);
  report.live.firstFreeze.push(await sample());
  await shot('live-first-freeze-front-later.png');
  assert.deepEqual(report.live.firstFreeze[0].bones, report.live.firstFreeze[1].bones, 'watched monitor bones moved');
  assert.equal(report.live.firstFreeze[0].phase, report.live.firstFreeze[1].phase);

  // Log every real client frame while looking away, then turn back before capture range.
  await place(12);
  report.live.runAndFreeze = await page.evaluate(async () => {
    const g = window.__escape.game(), trace = [], began = performance.now();
    let firstRun = NaN, done = false;
    g.input.yaw = -Math.PI / 2;
    return await new Promise((resolve, reject) => {
      const tick = () => {
        const o = g.mobs.byId.get(2), now = performance.now();
        trace.push({ t: now - began, anim: o.anim, p: o.mesh.position.toArray(), phase: o.monitorAnim.phase,
          leg: [o.warden.bones.thighL.rotation.x, o.warden.bones.thighR.rotation.x], arm: o.warden.bones.upperArmL.quaternion.toArray() });
        if (o.anim === 'run' && !Number.isFinite(firstRun)) firstRun = now;
        if (Number.isFinite(firstRun) && now - firstRun > 240) g.input.yaw = Math.PI / 2;
        if (Number.isFinite(firstRun) && o.anim === 'freeze' && now - firstRun > 260) done = true;
        if (done) resolve(trace);
        else if (now - began > 8000) reject(new Error('real monitor did not run then freeze'));
        else requestAnimationFrame(tick);
      }; requestAnimationFrame(tick);
    });
  });
  const moving = report.live.runAndFreeze.filter((s) => s.anim === 'run');
  assert.ok(moving.length >= 3, 'real sprint needs multiple observed frames');
  assert.ok(new Set(moving.map((s) => s.phase.toFixed(3))).size >= 3, 'real sprint phase did not advance');
  report.live.midStrideFreeze = [await sample()];
  await shot('live-midstride-freeze-0.png');
  await page.waitForTimeout(400); report.live.midStrideFreeze.push(await sample());
  await shot('live-midstride-freeze-1.png');
  assert.deepEqual(report.live.midStrideFreeze[0].bones, report.live.midStrideFreeze[1].bones, 'mid-stride freeze changed bones');
  assert.equal(report.live.midStrideFreeze[0].phase, report.live.midStrideFreeze[1].phase);
  await page.evaluate(() => window.__escape.debug('safe', 600, 2));
  await page.waitForFunction(() => window.__escape.game().mobs.byId.get(2)?.anim === 'idle');
  await shot('live-idle-front.png');
  report.live.idle = await sample();

  // Same built product modules, same mob instance, same renderer. Only snapshots and review camera are controlled.
  await page.exposeFunction('__saveMonitorFrame', (name, data) => {
    writeFileSync(resolve(out, name), Buffer.from(data.split(',')[1], 'base64'));
  });
  report.replayVideoOffsetSeconds = (Date.now() - videoEpoch) / 1000;
  report.replay = await page.evaluate(async () => {
    const g = window.__escape.game(), T = window.__escape.THREE, mobs = g.mobs;
    const onSnap = mobs.onSnap.bind(mobs); mobs.onSnap = () => {};
    g.draw = false; g.update = () => {};
    const canvas = g.renderer.domElement; canvas.style.visibility = '';
    for (const e of document.querySelectorAll('#hud, #hint, #blink-overlay, #fade-overlay, #jasmine')) e.style.display = 'none';
    const label = document.createElement('div');
    Object.assign(label.style, { position: 'fixed', left: '20px', top: '16px', color: '#fff', font: '16px sans-serif', background: '#111b', padding: '10px', zIndex: '999' });
    document.body.append(label);
    const scene = new T.Scene(); scene.background = new T.Color(0x464c56);
    scene.add(new T.HemisphereLight(0xe7edf8, 0x3a3430, 2));
    const key = new T.DirectionalLight(0xffffff, 2.1); key.position.set(-2, 5, -3); scene.add(key);
    const rim = new T.DirectionalLight(0xaec8ff, 1.4); rim.position.set(3, 3, 2); scene.add(rim);
    const floor = new T.Mesh(new T.PlaneGeometry(200, 200), new T.MeshStandardMaterial({ color: 0x565d65, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.008; scene.add(floor, new T.GridHelper(200, 200, 0x89929f, 0x707984));
    const camera = new T.PerspectiveCamera(38, 960 / 540, 0.05, 90), o = mobs.byId.get(2); scene.add(o.mesh);
    const results = { description: '受控快照回放；真实已构建 Mobs / MonitorAnimator；非服务器 AI 流程', captures: [], trace: [], blink: null, teleport: null };
    const shots = [
      [0.5, 'replay-idle-front.png'], [1.4, 'replay-idle-side.png'],
      [2.45, 'replay-run-0.png'], [2.55, 'replay-run-1.png'], [2.65, 'replay-run-2.png'],
      [5.4, 'replay-freeze-0.png'], [6.4, 'replay-freeze-1.png'], [7.45, 'replay-blink-landed.png'], [8.45, 'replay-teleport-landed.png'],
      [10.3, 'replay-idle-return.png'],
    ];
    const t0 = performance.now(); let last = t0, snapIndex = -1, shotIndex = 0, blinked = false, teleported = false;
    let blinkCheck = false, teleportCheck = false;
    const bodyPose = () => Object.fromEntries(Object.entries(o.warden.bones).map(([k, b]) => [k, [...b.position.toArray(), ...b.quaternion.toArray()]]));
    return await new Promise((resolve, reject) => {
      const tick = async (now) => {
        try {
          const t = (now - t0) / 1000, dt = Math.min((now - last) / 1000, 0.1); last = now;
          const anim = t < 2 || t >= 9.3 ? 'idle' : t < 5 ? 'run' : 'freeze';
          let z = -7.8 * Math.max(0, Math.min(3, t - 2)), x = 0;
          if (t >= 7.2) x = 1.4;
          if (t >= 8.2) x = 9.4;
          const i = Math.floor(t / 0.05);
          if (i !== snapIndex) {
            const q = Math.floor(t / 0.05) * 0.05;
            z = -7.8 * Math.max(0, Math.min(3, q - 2));
            onSnap([{ id: 2, kind: 'monitor', anim, p: [x, 0, z], yaw: 0 }], now); snapIndex = i;
          }
          if (t >= 7.2 && !blinked) { mobs.blink(now, 0.2); blinked = true; blinkCheck = true; }
          if (t >= 8.2 && !teleported) { teleported = true; teleportCheck = true; }
          const phaseBefore = o.monitorAnim.phase;
          mobs.update(now, dt);
          if (blinkCheck) { results.blink = { actual: o.mesh.position.toArray(), expected: [x, 0, z], phaseBefore, phaseAfter: o.monitorAnim.phase }; blinkCheck = false; }
          if (teleportCheck) { results.teleport = { actual: o.mesh.position.toArray(), expected: [x, 0, z], phaseBefore, phaseAfter: o.monitorAnim.phase }; teleportCheck = false; }
          const p = o.mesh.position;
          if (t < 1.05) camera.position.set(p.x + 0.2, 1.3, p.z - 3.8);
          else if (t < 2) camera.position.set(p.x + 3.8, 1.25, p.z - 0.1);
          else camera.position.set(p.x + 3.2, 1.25, p.z - 2.7);
          camera.lookAt(p.x, 0.97, p.z);
          label.textContent = `受控动作回放 · ${anim === 'run' ? '7.8 m/s 僵直冲刺' : anim === 'freeze' ? '被注视：冻结原姿态' : '立正：双手贴裤缝'} · ${t.toFixed(1)} s`;
          g.renderer.render(scene, camera);
          results.trace.push({ t, anim, p: p.toArray(), phase: o.monitorAnim.phase, bones: bodyPose() });
          if (shots[shotIndex] && t >= shots[shotIndex][0]) {
            const name = shots[shotIndex++][1]; await window.__saveMonitorFrame(name, canvas.toDataURL('image/png'));
            results.captures.push({ name, t, phase: o.monitorAnim.phase });
          }
          if (t >= 11) resolve(results); else requestAnimationFrame(tick);
        } catch (e) { reject(e); }
      }; requestAnimationFrame(tick);
    });
  });
  for (const k of ['blink', 'teleport']) {
    assert.deepEqual(report.replay[k].actual, report.replay[k].expected, `${k} did not land in its first frame`);
    assert.equal(report.replay[k].phaseBefore, report.replay[k].phaseAfter, `${k} advanced the sprint cycle`);
  }
  const held = report.replay.trace.filter((s) => s.t > 5.3 && s.t < 7);
  assert.ok(held.length > 15);
  for (const s of held) { assert.equal(s.phase, held[0].phase); assert.deepEqual(s.bones, held[0].bones); }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  if (context) await context.close().catch(() => {});
  if (video) {
    const raw = resolve(out, 'session.webm'); await video.saveAs(raw).catch(() => {});
    report.video = raw;
    if (report.replayVideoOffsetSeconds !== undefined) {
      const ffmpeg = findFfmpeg();
      const clip = resolve(out, 'replay.webm');
      if (ffmpeg) {
        const ff = spawnSync(ffmpeg, ['-y', '-ss', String(Math.max(0, report.replayVideoOffsetSeconds - 1)), '-i', raw, '-t', '13', '-an', '-c:v', 'copy', clip], { encoding: 'utf8' });
        if (ff.status === 0) report.replayVideo = clip;
        else report.videoTrimIssue = ff.stderr.slice(-500);
      } else report.videoTrimIssue = '未找到 ffmpeg，保留完整 session.webm 与回放起始秒数。';
    }
  }
  if (browser) await browser.close().catch(() => {});
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise((r) => server.once('exit', r)), pause(3000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  serverLog.end();
  writeFileSync(resolve(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, renderer: report.renderer, liveRunFrames: report.live.runAndFreeze?.filter((s) => s.anim === 'run').length,
    replayFrames: report.replay.trace?.length, screenshots: report.replay.captures?.length, video: report.replayVideo ?? report.video, failure: report.failure }, null, 2));
}
