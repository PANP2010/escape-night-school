/** Real-time motion evidence. Run only through the shared browser gate, after building this worktree:
 * python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- node tests/record-remote-motion.mjs
 * One headless Metal browser, two real contexts and real WebSockets. Both pages draw continuously.
 * Canvas capture preserves real MediaRecorder timestamps; no virtual clock, replay, slow motion or frame duplication.
 */
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { webmFrameTimes } from './webm-frame-times.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const base = 'http://127.0.0.1:4452';
const out = resolve('test-results/remote-motion');
mkdirSync(out, { recursive: true });
if (process.platform !== 'darwin') throw Error('This evidence run requires the real Metal backend on macOS.');
if (await fetch(`${base}/healthz`).then(() => true, () => false)) throw Error('4452 is already in use; refusing to reuse or stop another server.');
const serverLog = createWriteStream(`${out}/server.log`);
const server = spawn(process.execPath, ['dist-server/index.js'], {
  cwd: process.cwd(), env: { ...process.env, PORT: '4452', HOST: '127.0.0.1', NODE_ENV: 'development' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.pipe(serverLog); server.stderr.pipe(serverLog);
let browser;
const errors = [], stages = [], shots = [];
const report = { backend: 'Metal', realtime: true, browserCount: 1, contexts: 2, drawnPages: 2, port: 4452,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  externalScore: null, externalScoreReason: 'No callable Gemini video review tool is available.' };
const delay = ms => new Promise(r => setTimeout(r, ms));
const quantile = (xs, p) => xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : null;

try {
  for (let k = 0; ; k++) {
    if (server.exitCode !== null) throw Error(`Own server exited: ${server.exitCode}`);
    if (await fetch(`${base}/healthz`).then(r => r.ok, () => false)) break;
    if (k > 200) throw Error('Own server startup timed out');
    await delay(100);
  }
  const args = browserArgs(['--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], { softwareGL: '0' });
  browser = await chromium.launch({ headless: true, args });
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ baseURL: base, viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 })));
  const [A, B] = await Promise.all(contexts.map(c => c.newPage()));
  for (const [i, p] of [A, B].entries()) {
    p.on('pageerror', e => errors.push({ page: i, error: String(e) }));
    await p.addInitScript(() => {
      window.__motionWire = { snaps: [], corrects: [] };
      const Original = window.WebSocket;
      window.WebSocket = class extends Original {
        constructor(...args) {
          super(...args);
          this.addEventListener('message', e => {
            const m = JSON.parse(e.data), t = performance.now();
            if (m.t === 'snap') window.__motionWire.snaps.push({ t, tick: m.tick, players: m.players, mobs: m.mobs });
            if (m.t === 'correct') window.__motionWire.corrects.push({ t, ...m });
          });
        }
      };
    });
    await p.goto('/?steady');
    await p.fill('#name', i ? '动作复验乙' : '动作复验甲');
  }
  await A.click('#create');
  await A.waitForFunction(() => !!window.__escape.code);
  const code = await A.evaluate(() => window.__escape.code);
  await B.fill('#code', code); await B.click('#join');
  await A.waitForSelector('#wait-members li:nth-child(2)'); await A.click('#start');
  await Promise.all([A, B].map(p => p.waitForFunction(() => window.__escape.game()?.spawnSynced, null, { timeout: 60_000 })));
  await A.evaluate(() => window.__escape.debug('safe', 600));
  // The long, clear south corridor supports actual AD/S/W movement without colliding with furniture.
  for (const [p, x] of [[A, -47], [B, -42]]) {
    await p.evaluate(x => window.__escape.debug('tp', x, 73.36, 0), x);
    await p.waitForFunction(x => Math.abs(window.__escape.game().pos.x - x) < 0.1, x);
  }
  await A.evaluate(() => { const g = window.__escape.game(); g.input.yaw = -Math.PI / 2; g.input.pitch = -0.06; g.light = true; });
  await B.evaluate(() => { const g = window.__escape.game(); g.input.yaw = 0; g.input.pitch = 0; });
  await delay(3000);
  const browserCdp = await browser.newBrowserCDPSession();
  report.commandLine = (await browserCdp.send('Browser.getBrowserCommandLine')).arguments;
  if (!report.commandLine.includes('--mute-audio') || !report.commandLine.includes('--use-angle=metal')) throw Error('Expected explicit Metal and mute-audio flags');
  const gpu = await browserCdp.send('SystemInfo.getInfo');
  report.gpu = gpu.gpu;
  report.webgl = await A.evaluate(() => {
    const gl = window.__escape.game().renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { vendor: ext && gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), renderer: ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) };
  });
  if (!/Metal/.test(report.webgl.renderer ?? '') || /SwiftShader|software/i.test(report.webgl.renderer ?? '')) throw Error('WebGL renderer did not confirm the real Metal backend');

  for (const p of [A, B]) await p.evaluate(() => {
    const g = window.__escape.game(), T = window.__escape.THREE;
    const tmp = new T.Vector3(), box = new T.Box3(); let measuredAt = -Infinity;
    const sole = Array.from({ length: 64 }, (_, i) => {
      const a = i * Math.PI * 2 / 64;
      return new T.Vector3(0, -0.045 + 0.048 * Math.sin(a), 0.035 + 0.13 * Math.cos(a));
    });
    window.__motion = { frames: [], renders: [], smootherEvents: [], stage: 'warmup', on: true };
    const hooked = new WeakSet();
    const watchSmoother = (smoother, kind) => {
      if (hooked.has(smoother)) return;
      hooked.add(smoother);
      for (const name of ['reset', 'catchUp']) {
        const call = smoother[name].bind(smoother);
        smoother[name] = (...args) => {
          window.__motion.smootherEvents.push({ t: performance.now(), stage: window.__motion.stage, kind, name });
          return call(...args);
        };
      }
    };
    const oldRender = g.renderer.render.bind(g.renderer);
    g.renderer.render = (...args) => { oldRender(...args); if (window.__motion.on) window.__motion.renders.push(performance.now()); };
    const loop = t => {
      if (!window.__motion.on) return;
      const [remoteId, r] = [...g.remotes.entries()][0] ?? [], o = g.mobs.byId.get(1);
      if (r) watchSmoother(r.sm, 'remote');
      if (o) watchSmoother(o.sm, 'mob');
      let remote = null;
      if (r) {
        const w = r.st.warden, bones = w.bones;
        r.mesh.updateMatrixWorld(true);
        const bone = name => { const b = bones[name]; b.getWorldPosition(tmp); return { p: tmp.toArray(), q: b.quaternion.toArray() }; };
        const soles = ['footL', 'footR'].map(name => {
          let lowest = null;
          for (const p of sole) {
            tmp.copy(p).applyMatrix4(bones[name].matrixWorld);
            if (!lowest || tmp.y < lowest[1]) lowest = tmp.toArray();
          }
          return lowest;
        });
        if (t - measuredAt >= 100) { box.setFromObject(w.root, true); measuredAt = t; }
        const authoritative = window.__motionWire.snaps.at(-1)?.players.find(p => p.id === remoteId);
        remote = { p: r.mesh.position.toArray(), yaw: r.mesh.rotation.y, f: r.f, clock: r.clock.t, latest: r.buf.lastT(),
          speed: r.buf.speed(), pace: r.buf.paceSpeed(), clip: w.anim.clip, loco: w.anim.loco,
          planted: [w.anim.planted(0), w.anim.planted(1)], bodyMinY: box.min.y, bodyMaxY: box.max.y,
          authoritative: authoritative?.p ?? null,
          soles,
          bones: Object.fromEntries(['footL', 'footR', 'thighL', 'thighR', 'chest', 'head'].map(n => [n, bone(n)])) };
      }
      window.__motion.frames.push({ t, wall: Date.now(), stage: window.__motion.stage, p: [g.pos.x, g.body.y, g.pos.z],
        remote, mob: o && { p: o.mesh.position.toArray(), clock: o.clock.t, latest: o.buf.lastT(), pace: o.buf.paceSpeed(), anim: o.anim } });
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  const shot = async name => { const file = `${out}/${name}.png`; await A.screenshot({ path: file }); shots.push(file); };
  await shot('standing-before');
  await A.evaluate(() => {
    const canvas = window.__escape.game().renderer.domElement;
    const stream = canvas.captureStream(60), chunks = [];
    const mimeType = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9'].find(t => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 6_000_000 });
    window.__motionRecording = { recorder, chunks, stream, start: performance.now() };
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.start(250);
  });
  const mark = async (name, keys = [], yaw = 0, ms = 2200, screenshot = false) => {
    const start = await A.evaluate(name => { window.__motion.stage = name; return performance.now(); }, name);
    await B.evaluate(({ name, yaw }) => {
      const i = window.__escape.game().input; i.yaw = yaw;
      window.__motion.stage = name;
    }, { name, yaw });
    for (const key of keys) await B.keyboard.down(key);
    if (screenshot) { await delay(ms / 2); await shot(name); await delay(ms / 2); }
    else await delay(ms);
    for (const key of keys) await B.keyboard.up(key);
    const end = await A.evaluate(() => { window.__motion.stage = 'transition'; return performance.now(); });
    stages.push({ name, start, end, keys, yaw, requestedMs: ms });
  };
  await mark('idle', [], 0, 3200);
  await mark('strafe-right', ['KeyD'], 0, 1200, true);
  await mark('strafe-left', ['KeyA'], 0, 1200);
  await mark('strafe-right-repeat', ['KeyD'], 0, 1200);
  await mark('strafe-left-repeat', ['KeyA'], 0, 1200);
  await mark('stop-after-strafe', [], 0, 1200);
  await mark('backward', ['KeyS'], Math.PI / 2, 1200, true);
  await mark('forward-return', ['KeyW'], Math.PI / 2, 1200);
  await mark('backward-repeat', ['KeyS'], Math.PI / 2, 1200);
  await mark('forward-return-repeat', ['KeyW'], Math.PI / 2, 1200);
  await mark('stand-to-crouch', ['KeyC'], -Math.PI / 2, 1300, true);
  await mark('crouch-forward', ['KeyC', 'KeyW'], -Math.PI / 2, 2400, true);
  await mark('stand-up', [], -Math.PI / 2, 1800, true);
  await mark('start-after-idle', ['KeyW'], Math.PI / 2, 1200);
  await mark('final-idle', [], Math.PI / 2, 3000, true);
  const video = await A.evaluate(async () => {
    const r = window.__motionRecording;
    await new Promise(resolve => { r.recorder.onstop = resolve; r.recorder.stop(); });
    const blob = new Blob(r.chunks, { type: r.recorder.mimeType });
    r.stream.getTracks().forEach(t => t.stop());
    const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = '';
    for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
    return { base64: btoa(binary), mimeType: blob.type, start: r.start, end: performance.now() };
  });
  writeFileSync(`${out}/remote-realtime.webm`, Buffer.from(video.base64, 'base64'));
  // Keep the live server's original positions/timestamps, but deliver actual mob snapshots in 500 ms batches.
  // A separate 2 s interruption checks recovery after the playback clock's resynchronization boundary.
  await A.evaluate(() => {
    const g = window.__escape.game(), onSnap = g.mobs.onSnap.bind(g.mobs);
    const hold = { queue: [], delivered: [], paused: false };
    g.mobs.onSnap = (mobs, t) => hold.queue.push({ mobs, t });
    hold.timer = setInterval(() => {
      if (hold.paused) return;
      const queued = hold.queue.splice(0);
      hold.delivered.push({ at: performance.now(), count: queued.length, timestamps: queued.map(q => q.t) });
      for (const q of queued) onSnap(q.mobs, q.t);
    }, 500);
    window.__motionMobHold = hold;
  });
  await mark('mob-batches-500ms', [], Math.PI / 2, 6000);
  await A.evaluate(() => { window.__motionMobHold.paused = true; });
  await mark('mob-snapshot-interruption-2s', [], Math.PI / 2, 2000);
  await A.evaluate(() => { window.__motionMobHold.paused = false; });
  await mark('mob-batch-recovery', [], Math.PI / 2, 6000);
  const samples = await Promise.all([A, B].map(p => p.evaluate(() => {
    window.__motion.on = false;
    if (window.__motionMobHold) clearInterval(window.__motionMobHold.timer);
    return { ...window.__motion, origin: performance.timeOrigin, wire: window.__motionWire,
      mobDeliveries: window.__motionMobHold?.delivered ?? [], corrections: window.__escape.game().corrections };
  })));
  // Navigation time origins differ between contexts; align every timestamp to observer A before phase analysis.
  for (const p of samples) {
    const offset = p.origin - samples[0].origin;
    for (const f of p.frames) f.t += offset;
    p.renders = p.renders.map(t => t + offset);
    for (const c of [...p.wire.corrects, ...p.wire.snaps]) c.t += offset;
    for (const e of p.smootherEvents) e.t += offset;
  }
  writeFileSync(`${out}/samples.json`, JSON.stringify({ stages, pages: samples }));
  report.video = { path: `${out}/remote-realtime.webm`, mimeType: video.mimeType, elapsedSeconds: (video.end - video.start) / 1000 };
  const encoded = webmFrameTimes(report.video.path);
  writeFileSync(`${out}/video-frame-timestamps.json`, JSON.stringify(encoded));
  const { timestampsMs, ...encodedSummary } = encoded;
  report.video = { ...report.video, ...encodedSummary };
  report.shots = shots; report.errors = errors;
  report.phases = stages.map(s => {
    const pages = samples.map(p => {
      const frames = p.frames.filter(f => f.t >= s.start && f.t <= s.end), renders = p.renders.filter(t => t >= s.start && t <= s.end);
      const dts = frames.slice(1).map((f, i) => f.t - frames[i].t);
      const steps = frames.slice(1).flatMap((f, i) => f.remote && frames[i].remote
        ? [Math.hypot(f.remote.p[0] - frames[i].remote.p[0], f.remote.p[2] - frames[i].remote.p[2])] : []);
      const mobSteps = frames.slice(1).flatMap((f, i) => f.mob && frames[i].mob ? [{
        step: Math.hypot(f.mob.p[0] - frames[i].mob.p[0], f.mob.p[2] - frames[i].mob.p[2]), dt: (f.t - frames[i].t) / 1000,
      }] : []);
      const stanceSlips = frames.slice(1).flatMap((f, i) => {
        const prev = frames[i], dt = (f.t - prev.t) / 1000;
        if (!f.remote || !prev.remote || f.t < s.start + 300 || dt <= 0) return [];
        return [0, 1].flatMap(k => f.remote.planted[k] && prev.remote.planted[k]
          ? [Math.hypot(f.remote.soles[k][0] - prev.remote.soles[k][0], f.remote.soles[k][2] - prev.remote.soles[k][2]) / dt] : []);
      });
      const qRange = name => [0, 1, 2, 3].map(i => { const v = frames.flatMap(f => f.remote ? [f.remote.bones[name].q[i]] : []); return v.length ? Math.max(...v) - Math.min(...v) : 0; });
      return { rafFrames: frames.length, rafFps: frames.length / ((s.end - s.start) / 1000), renderFrames: renders.length,
        renderFps: renders.length / ((s.end - s.start) / 1000), frameP95Ms: quantile(dts, .95), maxFrameMs: Math.max(0, ...dts),
        maxRemoteStep: Math.max(0, ...steps), bodyMinY: quantile(frames.flatMap(f => f.remote ? [f.remote.bodyMinY] : []), .5),
        rootMinusAuthoritativeFloor: quantile(frames.flatMap(f => f.remote?.authoritative ? [f.remote.p[1] - f.remote.authoritative[1]] : []), .5),
        stanceSlipMedian: quantile(stanceSlips, .5), stanceSlipMax: Math.max(0, ...stanceSlips), stanceSamples: stanceSlips.length,
        mob: { travel: mobSteps.reduce((a, p) => a + p.step, 0), maxStep: Math.max(0, ...mobSteps.map(p => p.step)),
          maxSpeed: Math.max(0, ...mobSteps.map(p => p.step / p.dt)), maxWalkExcess: Math.max(0, ...mobSteps.map(p => p.step - 2 * p.dt * 1.5)) },
        boneQuaternionRange: Object.fromEntries(['footL', 'footR', 'chest', 'head'].map(n => [n, qRange(n)])),
        corrects: p.wire.corrects.filter(c => c.t >= s.start && c.t <= s.end), clips: [...new Set(frames.flatMap(f => f.remote ? [f.remote.clip] : []))],
        smootherEvents: p.smootherEvents.filter(e => e.t >= s.start && e.t <= s.end),
        locomotion: [...new Set(frames.flatMap(f => f.remote ? [f.remote.loco] : []))] };
    });
    const inVideo = s.start >= video.start && s.end <= video.end;
    const pts = inVideo ? encoded.timestampsMs.filter(t => t - encoded.firstPtsMs >= s.start - video.start
      && t - encoded.firstPtsMs <= s.end - video.start) : [];
    const videoPhase = inVideo ? { frames: pts.length, encodedFps: pts.length / ((s.end - s.start) / 1000),
      maxGapMs: Math.max(0, ...pts.slice(1).map((t, i) => t - pts[i])),
      alignment: 'Recorder start + source PTS; the first captured frame may shift this window by approximately one display frame.' } : null;
    return { ...s, pages, video: videoPhase };
  });
  report.minimumMeasuredRenderFps = Math.min(...report.phases.flatMap(p => p.pages.map(p => p.renderFps)));
  report.minimumMeasuredEncodedPhaseFps = Math.min(...report.phases.flatMap(p => p.video ? [p.video.encodedFps] : []));
  report.meets30Fps = report.minimumMeasuredRenderFps >= 30 && encoded.measuredEncodedFps >= 30
    && report.minimumMeasuredEncodedPhaseFps >= 30 && encoded.repeatedTimestamps === 0 && encoded.ignoredNonVideoBlocks === 0;
  report.corrections = samples.map(p => p.corrections);
  writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ video: report.video, renderer: report.webgl, minimumMeasuredRenderFps: report.minimumMeasuredRenderFps,
    minimumMeasuredEncodedPhaseFps: report.minimumMeasuredEncodedPhaseFps, meets30Fps: report.meets30Fps, corrections: report.corrections, errors, report: `${out}/report.json` }, null, 2));
  if (!report.meets30Fps) throw Error('Measured real render rate fell below 30 fps. Evidence retained; this is not a passing run.');
  if (errors.length) throw Error('Browser page errors recorded');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise(resolve => { if (server.exitCode !== null || server.signalCode !== null) resolve(); else server.once('exit', resolve); });
  serverLog.end();
}
