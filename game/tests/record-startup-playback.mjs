// Real-time startup/playback evidence, after npm run build. No replay or virtual clock.
// ESC_GPU=1 draws both independent WS clients; software draws A while B continues normal updates without WebGL.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';

const port = Number(process.env.STARTUP_VIDEO_PORT ?? 4292), base = `http://127.0.0.1:${port}`;
const prefix = 'test-results/iter-59-motion', hardware = process.env.ESC_GPU === '1';
const report = { at: new Date().toISOString(), realTime: true, contexts: 2, drawnClients: hardware ? 2 : 1,
  limitation: hardware ? null : 'SwiftShader: client B updates and receives real WS snapshots without WebGL drawing.',
  passed: false, errors: [] };
let server, browser;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
await mkdir('test-results', { recursive: true });

try {
  if (await fetch(`${base}/healthz`).then(() => true, () => false)) throw Error(`${port} already in use`);
  server = spawn(process.execPath, ['dist-server/index.js'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'development' }, stdio: ['ignore', 'ignore', 'inherit'],
  });
  await expect.poll(async () => {
    if (server.exitCode !== null) throw Error(`Own built server exited: ${server.exitCode}`);
    return fetch(`${base}/healthz`).then(r => r.ok, () => false);
  }, { timeout: 20_000 }).toBe(true);
  browser = await chromium.launch({ args: browserArgs(['--mute-audio', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']) });
  const storageState = { cookies: [], origins: [{ origin: base, localStorage: [{ name: 'escape.settings',
    value: JSON.stringify({ pixelRatio: 1, postprocessing: false }) }] }] };
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ baseURL: base, storageState,
    viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 })));
  const [a, b] = await Promise.all(contexts.map(context => context.newPage())), pages = [a, b];
  for (const [client, p] of pages.entries()) {
    p.on('pageerror', e => report.errors.push({ client, error: e.message }));
    await p.goto('/?nodraw&steady');
    await p.fill('#name', client ? '同步录像乙' : '同步录像甲');
  }
  await a.click('#create');
  await expect(a.locator('#wait-code')).not.toBeEmpty();
  await b.fill('#code', await a.locator('#wait-code').innerText()); await b.click('#join');
  await expect(a.locator('#wait-members li')).toHaveCount(2); await a.click('#start');
  await Promise.all(pages.map(p => p.waitForFunction(() => {
    const g = window.__escape.game(); return g?.presentationReady && !g.intro.active;
  }, null, { timeout: 90_000 })));

  // The opening patrol is on the north corridor. Keep both cameras at the same authored corridor point,
  // looking west; no NPC positions, animation times, snapshots or simulation clocks are changed.
  const view = { x: -26, y: 1.55, z: 92.9, yaw: Math.PI / 2, pitch: -0.045 };
  report.view = view;
  await a.evaluate(() => window.__escape.debug('safe', 600, 2)); // monitors only; Warden keeps his natural patrol
  report.renderers = await Promise.all(pages.map((p, i) => p.evaluate(({ view, draw }) => {
    const g = window.__escape.game(); g.view = view; g.light = true; g.draw = draw;
    const gl = g.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { renderer: ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL), lost: gl.isContextLost() };
  }, { view, draw: hardware || i === 0 })));
  if (hardware) for (const r of report.renderers) {
    assert.match(r.renderer, /NVIDIA/i); assert.doesNotMatch(r.renderer, /SwiftShader|llvmpipe|software/i);
  }
  for (const [i, p] of pages.entries()) if (hardware || i === 0) {
    const first = await p.evaluate(() => window.__escape.game().renderer.info.render.frame);
    await p.waitForFunction(first => window.__escape.game().renderer.info.render.frame >= first + 3,
      first, { timeout: 60_000 });
  }

  const startWall = Date.now() + 750, duration = 14_000;
  await Promise.all(pages.map((p, i) => p.evaluate(({ startWall, duration, record }) => {
    const g = window.__escape.game(), capture = window.__startupCapture = { frames: [], startWall, duration, done: false };
    if (record) {
      const stream = g.renderer.domElement.captureStream(30), chunks = [];
      const mimeType = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9'].find(t => MediaRecorder.isTypeSupported(t));
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_000_000 });
      capture.recording = { stream, chunks, recorder };
      capture.recording.stopped = new Promise(resolve => { recorder.onstop = resolve; });
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    }
    const sample = () => {
      const wall = Date.now();
      if (wall >= startWall && !capture.started) {
        capture.started = wall; capture.recording?.recorder.start(200);
      }
      if (capture.started) {
        const o = g.mobs.byId.get(1), newest = o?.buf.at(o.buf.lastT());
        capture.frames.push({ wall, now: performance.now(), render: g.renderer.info.render.frame,
          authoritative: newest && [newest.x, newest.y, newest.z], mesh: o?.mesh.position.toArray(),
          anim: o?.anim, playback: o?.clock.t, newest: o?.buf.lastT(), speed: o?.buf.paceSpeed() });
      }
      if (wall < startWall + duration) requestAnimationFrame(sample);
      else {
        capture.ended = wall; capture.done = true;
        if (capture.recording) capture.recording.recorder.stop();
      }
    };
    requestAnimationFrame(sample);
  }, { startWall, duration, record: hardware || i === 0 })));
  await wait(duration + 1000);
  await Promise.all(pages.map(p => p.waitForFunction(() => window.__startupCapture.done, null, { timeout: 30_000 })));
  report.clients = await Promise.all(pages.map(p => p.evaluate(async () => {
    const capture = window.__startupCapture, recording = capture.recording;
    let base64;
    if (recording) {
      await recording.stopped;
      const blob = new Blob(recording.chunks, { type: recording.recorder.mimeType });
      const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = '';
      for (let k = 0; k < bytes.length; k += 16384) binary += String.fromCharCode(...bytes.subarray(k, k + 16384));
      base64 = btoa(binary); recording.stream.getTracks().forEach(track => track.stop());
    }
    return { frames: capture.frames, started: capture.started, ended: capture.ended, base64 };
  })));
  for (const [i, client] of report.clients.entries()) {
    if (client.base64) await writeFile(`${prefix}${i ? '-peer' : ''}.webm`, Buffer.from(client.base64, 'base64'));
    delete client.base64;
    client.renderedFrames = new Set(client.frames.map(f => f.render)).size;
    client.maximumFrameGap = Math.max(...client.frames.slice(1).map((f, k) => f.wall - client.frames[k].wall));
  }
  await a.screenshot({ path: `${prefix}.png`, timeout: 30_000 });
  try {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', `${prefix}.webm`, '-an', '-c:v', 'libx264',
      '-crf', '22', '-pix_fmt', 'yuv420p', `${prefix}.mp4`]);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    report.transcode = 'ffmpeg unavailable; convert the captured WebM locally after retrieval.';
  }
  assert.deepEqual(report.errors, []);
  assert.ok(report.clients[0].renderedFrames > 2, 'the recording must contain actual WebGL draws');
  report.passed = true;
} catch (error) {
  report.failure = error.stack ?? String(error); process.exitCode = 1;
} finally {
  await browser?.close(); server?.kill('SIGTERM');
  await writeFile(`${prefix}-facts.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, failure: report.failure, renderers: report.renderers,
    clients: report.clients?.map(({ renderedFrames, maximumFrameGap }) => ({ renderedFrames, maximumFrameGap })) }, null, 2));
}
