// One browser, one context, one page; run from game/ against an already running server.
// node tests/probe-startup.mjs baseline [--profile] [--trace]
// node tests/probe-startup.mjs after [--profile] [--trace]
// This probe never builds, starts a server, changes game state, or bypasses drawing.
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';

const label = process.argv[2];
assert.ok(['baseline', 'after'].includes(label), 'Usage: node tests/probe-startup.mjs baseline|after [--profile] [--trace]');
const flags = new Set(process.argv.slice(3));
assert.ok([...flags].every((flag) => ['--profile', '--trace'].includes(flag)), 'Unknown probe option');
const baseURL = 'http://127.0.0.1:4449';
const out = fileURLToPath(new URL('../test-results/', import.meta.url));
const path = (suffix) => `${out}startup-${label}.${suffix}`;
const args = browserArgs(['--mute-audio']);
const evidence = {
  label, baseURL, at: new Date().toISOString(), args,
  configuration: { headless: true, viewport: { width: 960, height: 540 }, sampleTargetMs: 10_000, movementAttempt: 'Trusted KeyW held while waiting for readiness, then released before stable sampling' },
  timingNote: 'The first completed world frame is observed at the next rAF. firstRenderStarted/Completed describe the first instrumented render call, which can follow a synchronous publication render.',
  artifacts: { json: path('json'), screenshot: path('png'), video: path('webm') },
  pageErrors: [], consoleErrors: [], consoleWarnings: [], requestFailures: [], httpErrors: [], passed: false,
};
let browser, context, page, cdp, video, profileRunning = false, traceRunning = false;

function installProbe() {
  const p = window.__startupProbe = {
    timeOrigin: performance.timeOrigin, marks: {}, longtasks: [], frames: [], renders: [], inputs: [], incoming: [],
    stateChanges: [], socketErrors: [], browserErrors: [], actions: [], loadingProgress: [], sample: null, stopped: false,
    campusReadyKind: 'absent', campusReadyResolved: false, campusReadyError: null,
  };
  const mark = (name, at = performance.now()) => {
    if (p.marks[name] !== undefined) return;
    p.marks[name] = at;
    performance.mark(`startup-probe/${name}`);
  };
  const games = new WeakSet(), readyPromises = new WeakSet();
  let firstRenderFinished = false, lastFrameTime, previousState;
  function state(g = window.__escape?.game?.()) {
    // New startup code may keep campus absent until async construction finishes.
    const ready = typeof g?.worldReady === 'boolean' ? g.worldReady : g?.campus?.ready;
    let campusReady = null;
    if (typeof ready === 'boolean') { p.campusReadyKind = typeof g?.worldReady === 'boolean' ? 'worldReady:boolean' : 'campus.ready:boolean'; campusReady = ready; }
    else if (ready && typeof ready.then === 'function') {
      p.campusReadyKind = 'promise'; campusReady = p.campusReadyResolved;
      if (!readyPromises.has(ready)) {
        readyPromises.add(ready);
        ready.then(() => { p.campusReadyResolved = true; inspect(); }, (error) => { p.campusReadyError = String(error); });
      }
    }
    return {
      hasGame: !!g, campusPresent: !!g?.campus, campusReady, campusReadyKind: p.campusReadyKind,
      presentationReady: !!g?.presentationReady, spawnSynced: !!g?.spawnSynced,
      inputEnabled: g?.input?.enabled ?? null,
      draw: g?.draw ?? null, level: g?.level?.index ?? null,
      renderFrame: g?.renderer?.info?.render?.frame ?? null,
      renderCalls: g?.renderer?.info?.render?.calls ?? 0,
      triangles: g?.renderer?.info?.render?.triangles ?? 0,
      snaps: g?.snaps ?? 0,
    };
  }
  function inspect() {
    const g = window.__escape?.game?.();
    if (g && !games.has(g)) {
      games.add(g); mark('firstGame');
      const render = g.renderer.render;
      g.renderer.render = function (...parameters) {
        const start = performance.now();
        mark('firstRenderStarted', start);
        try { return render.apply(this, parameters); }
        finally {
          const end = performance.now();
          mark('firstRenderCompleted', end);
          firstRenderFinished = true;
          p.renders.push({ start, end, duration: end - start, frame: this.info.render.frame, calls: this.info.render.calls, triangles: this.info.render.triangles, ...state(g) });
        }
      };
    }
    const s = state(g);
    const loading = document.getElementById('campus-loading');
    if (loading && !loading.hidden) {
      mark('loadingVisible');
      const value = loading.querySelector('progress')?.value ?? 0;
      if (p.loadingProgress.at(-1)?.value !== value) p.loadingProgress.push({ at: performance.now(), value });
    }
    if (s.campusReady) mark('campusReady');
    if (s.spawnSynced) mark('spawnSynced');
    if (s.presentationReady) mark('presentationReady');
    if (s.inputEnabled) mark('firstInputEnabled');
    const signature = JSON.stringify([s.hasGame, s.campusPresent, s.campusReady, s.presentationReady, s.spawnSynced, s.inputEnabled, s.draw, s.level]);
    if (signature !== previousState) { p.stateChanges.push({ at: performance.now(), ...s }); previousState = signature; }
    return s;
  }
  p.inspect = inspect;
  p.mark = mark;
  p.snapshot = () => ({ ...p, inspect: undefined, mark: undefined, snapshot: undefined });
  document.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('#start')) mark('startClicked');
    if (event.target instanceof Element && event.target.closest('#create')) mark('createClicked');
  }, true);
  for (const kind of ['keydown', 'keyup']) document.addEventListener(kind, (event) => {
    if (event.code === 'KeyW') p.actions.push({ at: performance.now(), type: kind, code: event.code, trusted: event.isTrusted, ...inspect() });
  }, true);
  addEventListener('error', (event) => p.browserErrors.push({ at: performance.now(), type: 'error', message: event.message, filename: event.filename, line: event.lineno, column: event.colno }));
  addEventListener('unhandledrejection', (event) => p.browserErrors.push({ at: performance.now(), type: 'unhandledrejection', message: String(event.reason?.stack ?? event.reason) }));
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) p.longtasks.push({
        start: entry.startTime, duration: entry.duration, end: entry.startTime + entry.duration, name: entry.name,
        attribution: Array.from(entry.attribution ?? [], (item) => ({ name: item.name, containerType: item.containerType, containerSrc: item.containerSrc, containerId: item.containerId, containerName: item.containerName })),
      });
    }).observe({ type: 'longtask', buffered: true });
    p.longtaskSupported = true;
  } catch (error) { p.longtaskSupported = false; p.longtaskError = String(error); }
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(...parameters) {
      super(...parameters);
      this.addEventListener('error', () => p.socketErrors.push({ at: performance.now(), type: 'error', url: this.url }));
      this.addEventListener('close', (event) => p.socketErrors.push({ at: performance.now(), type: 'close', code: event.code, reason: event.reason, wasClean: event.wasClean }));
      this.addEventListener('message', (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.t === 'room' || message.t === 'correct' || message.t === 'error' || message.t === 'caught' || (message.t === 'snap' && p.marks.firstSnap === undefined)) {
          p.incoming.push({ at: performance.now(), message });
        }
        if (message.t === 'snap') mark('firstSnap');
        if (message.t === 'room' && message.started) mark('startedRoomReceived');
        queueMicrotask(inspect);
      });
    }
    send(data) {
      let message;
      try { message = typeof data === 'string' ? JSON.parse(data) : null; } catch { /* Preserve the real transport. */ }
      const at = performance.now();
      if (message?.t === 'start') mark('startSent', at);
      if (message?.t === 'input') {
        const s = inspect();
        p.inputs.push({ at, message, ...s, readyForInput: s.presentationReady && (s.campusReadyKind === 'absent' || s.campusReady === true) });
        mark('firstInputSent', at);
      }
      return super.send(data);
    }
  };
  function frame(timestamp) {
    if (p.stopped) return;
    const s = inspect();
    if (firstRenderFinished || (s.renderFrame > 0 && s.renderCalls > 0)) mark('firstRenderedFrameObservedAtNextRaf');
    p.frames.push({ timestamp, callbackAt: performance.now(), gap: lastFrameTime === undefined ? null : timestamp - lastFrameTime, ...s });
    lastFrameTime = timestamp;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function frameSummary(frames, start, end) {
  const selected = frames.filter((frame) => frame.callbackAt >= start && frame.callbackAt <= end);
  const gaps = selected.filter((frame, index) => index > 0 && frame.gap !== null).map((frame) => frame.gap).sort((a, b) => a - b);
  const percentile = (fraction) => gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * fraction))] : null;
  return {
    start, end, durationMs: end - start, frameCount: selected.length,
    fps: selected.length > 1 ? (selected.length - 1) * 1000 / (selected.at(-1).timestamp - selected[0].timestamp) : 0,
    maxGapMs: gaps.at(-1) ?? null, p50GapMs: percentile(0.5), p95GapMs: percentile(0.95), p99GapMs: percentile(0.99),
    gapsOver50Ms: gaps.filter((gap) => gap > 50).length, gapsOver100Ms: gaps.filter((gap) => gap > 100).length,
    renderedFrameDelta: selected.length > 1 ? selected.at(-1).renderFrame - selected[0].renderFrame : 0,
  };
}

function summarizeProfile(profile, anchor, longtasks) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const totals = new Map();
  let cursorUs = 0;
  const samples = (profile.samples ?? []).map((id, index) => {
    const durationUs = profile.timeDeltas?.[index] ?? 0;
    const startUs = cursorUs;
    cursorUs += durationUs;
    totals.set(id, (totals.get(id) ?? 0) + durationUs);
    return { id, startUs, endUs: cursorUs };
  });
  const describe = (id, durationUs) => {
    const frame = nodes.get(id)?.callFrame ?? {};
    return { functionName: frame.functionName || '(anonymous)', url: frame.url, line: (frame.lineNumber ?? -1) + 1, column: (frame.columnNumber ?? -1) + 1, sampledSelfMs: durationUs / 1000 };
  };
  return {
    note: 'CPU sampling estimates self time. Per-longtask alignment uses the midpoint of the browser timestamps surrounding Profiler.start; raw profile is retained for DevTools.',
    durationMs: (profile.endTime - profile.startTime) / 1000,
    alignmentUncertaintyMs: (anchor.after - anchor.before) / 2,
    topFunctions: [...totals].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([id, duration]) => describe(id, duration)),
    longestTasks: [...longtasks].sort((a, b) => b.duration - a.duration).slice(0, 10).map((task) => {
      const byFunction = new Map();
      const origin = (anchor.before + anchor.after) / 2;
      for (const sample of samples) {
        const overlap = Math.max(0, Math.min(sample.endUs / 1000 + origin, task.end) - Math.max(sample.startUs / 1000 + origin, task.start));
        if (overlap) byFunction.set(sample.id, (byFunction.get(sample.id) ?? 0) + overlap * 1000);
      }
      return { ...task, topFunctions: [...byFunction].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, duration]) => describe(id, duration)) };
    }),
  };
}

async function stopDiagnostics() {
  if (profileRunning) {
    profileRunning = false;
    const { profile } = await cdp.send('Profiler.stop');
    evidence.artifacts.cpuProfile = path('cpuprofile');
    await writeFile(path('cpuprofile'), JSON.stringify(profile));
    const current = await page.evaluate(() => window.__startupProbe.snapshot());
    evidence.cpuProfile = summarizeProfile(profile, evidence.profileAnchor, current.longtasks);
  }
  if (traceRunning) {
    traceRunning = false;
    const complete = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.end');
    const { stream } = await complete;
    let contents = '';
    for (;;) {
      const chunk = await cdp.send('IO.read', { handle: stream });
      contents += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data;
      if (chunk.eof) break;
    }
    await cdp.send('IO.close', { handle: stream });
    evidence.artifacts.chromeTrace = path('trace.json');
    await writeFile(path('trace.json'), contents);
  }
}

await mkdir(out, { recursive: true });
await Promise.all(['json', 'png', 'webm', 'cpuprofile', 'trace.json'].map((suffix) => rm(path(suffix), { force: true })));
try {
  browser = await chromium.launch({ headless: true, args });
  evidence.browserVersion = browser.version();
  context = await browser.newContext({
    baseURL, viewport: evidence.configuration.viewport, deviceScaleFactor: 1,
    recordVideo: { dir: `${out}startup-${label}-video`, size: { width: 960, height: 540 } },
  });
  await context.addInitScript(installProbe);
  page = await context.newPage();
  video = page.video();
  page.setDefaultTimeout(120_000);
  page.on('pageerror', (error) => evidence.pageErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') evidence.consoleErrors.push({ text: message.text(), location: message.location() });
    if (message.type() === 'warning') evidence.consoleWarnings.push({ text: message.text(), location: message.location() });
  });
  page.on('requestfailed', (request) => evidence.requestFailures.push({ url: request.url(), failure: request.failure() }));
  page.on('response', (response) => { if (response.status() >= 400) evidence.httpErrors.push({ url: response.url(), status: response.status() }); });
  if (flags.has('--profile') || flags.has('--trace')) cdp = await context.newCDPSession(page);
  if (flags.has('--trace')) {
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8,blink.user_timing,disabled-by-default-v8.cpu_profiler', transferMode: 'ReturnAsStream' });
    traceRunning = true;
  }
  await page.goto('/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__escape?.net && document.querySelector('#create'));
  await page.fill('#name', `启动测量${label === 'baseline' ? '前' : '后'}`);
  await page.click('#create');
  await page.waitForFunction(() => !!window.__escape?.code && !document.querySelector('#waiting').hidden);
  evidence.roomCode = await page.evaluate(() => window.__escape.code);
  if (flags.has('--profile')) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
    const before = await page.evaluate(() => performance.now());
    await cdp.send('Profiler.start');
    profileRunning = true;
    const after = await page.evaluate(() => performance.now());
    evidence.profileAnchor = { before, after };
  }
  await page.click('#start');
  await page.keyboard.down('KeyW');
  await page.waitForFunction((requireCampus) => {
    const s = window.__startupProbe.inspect();
    return s.presentationReady && (requireCampus ? s.campusReady === true : s.campusReady !== false) && s.renderFrame > 0 && s.renderCalls > 0 && s.triangles > 0;
  }, label === 'after', { polling: 'raf', timeout: 120_000 });
  await page.keyboard.up('KeyW');
  await page.waitForFunction(() => {
    const p = window.__startupProbe, now = performance.now(), s = p.inspect();
    const recent = p.frames.filter((frame) => frame.callbackAt >= now - 1500);
    if (recent.length < 30 || now - recent[0].callbackAt < 1200) return false;
    if (recent.some((frame) => frame.gap > 200 || !frame.presentationReady || frame.campusReady === false)) return false;
    if (p.longtasks.some((task) => task.end > now - 1500 && task.duration > 200)) return false;
    if (!s.draw || !s.presentationReady || s.renderCalls <= 0 || s.triangles <= 0 || s.renderFrame - recent[0].renderFrame < 25) return false;
    p.mark('stable');
    return true;
  }, null, { polling: 'raf', timeout: 120_000 });
  await stopDiagnostics();
  evidence.renderer = await page.evaluate(() => {
    const g = window.__escape.game(), gl = g.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      debugExtensionAvailable: !!ext,
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      version: gl.getParameter(gl.VERSION), shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      contextLost: gl.isContextLost(), draw: g.draw, pixelRatio: g.renderer.getPixelRatio(),
      canvas: { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight },
      level: g.level.index, levelName: g.level.name,
    };
  });
  await page.evaluate(() => {
    const p = window.__startupProbe;
    p.sample = { start: performance.now(), firstRenderFrame: window.__escape.game().renderer.info.render.frame };
    p.mark('sampleStarted', p.sample.start);
  });
  await page.waitForTimeout(10_000);
  await page.evaluate(() => {
    const p = window.__startupProbe;
    p.sample.end = performance.now();
    p.sample.lastRenderFrame = window.__escape.game().renderer.info.render.frame;
    p.mark('sampleEnded', p.sample.end);
  });
  await page.screenshot({ path: path('png') });
  evidence.probe = await page.evaluate(() => window.__startupProbe.snapshot());
  const p = evidence.probe, start = p.marks.startClicked;
  evidence.startup = frameSummary(p.frames, start, p.marks.stable);
  evidence.sample = frameSummary(p.frames, p.sample.start, p.sample.end);
  evidence.sample.actualRenderedFrameDelta = p.sample.lastRenderFrame - p.sample.firstRenderFrame;
  evidence.timingsFromStartMs = Object.fromEntries(Object.entries(p.marks).map(([name, at]) => [name, at - start]));
  evidence.longestStartupTasks = p.longtasks.filter((task) => task.end >= start && task.start <= p.marks.stable).sort((a, b) => b.duration - a.duration).slice(0, 20);
  evidence.inputsBeforeReadiness = p.inputs.filter((input) => !input.readyForInput);
  evidence.inputSummary = {
    total: p.inputs.length, beforeReadiness: evidence.inputsBeforeReadiness.length,
    firstAt: p.inputs[0]?.at ?? null,
    firstPosition: p.inputs[0]?.message.p ?? null,
    firstReadyAt: p.inputs.find((input) => input.readyForInput)?.at ?? null,
  };
  assert.equal(evidence.renderer.debugExtensionAvailable, true, 'Actual game renderer must expose debug renderer info');
  assert.match(evidence.renderer.renderer, /Apple/i, 'Probe must use Apple GPU');
  assert.match(evidence.renderer.renderer, /Metal/i, 'Probe must use Metal');
  assert.doesNotMatch(evidence.renderer.renderer, /SwiftShader|llvmpipe|software/i);
  assert.equal(evidence.renderer.contextLost, false);
  assert.equal(evidence.renderer.draw, true);
  assert.equal(evidence.renderer.level, 0, 'Probe must render the normal first level');
  assert.ok(p.longtaskSupported, 'Long Task API must be available');
  assert.ok(evidence.sample.durationMs >= 10_000);
  assert.ok(evidence.sample.actualRenderedFrameDelta >= 30, 'Real WebGL frames must continue throughout sampling');
  assert.ok(p.inputs.length > 0, 'Real input transport must remain active after readiness');
  if (label === 'after') {
    assert.notEqual(p.campusReadyKind, 'absent', 'After build must expose worldReady or campus.ready');
    assert.equal(p.campusReadyError, null);
    assert.equal(evidence.inputsBeforeReadiness.length, 0, 'No input may be uploaded before campus and presentation readiness');
  }
  assert.deepEqual(evidence.pageErrors, []);
  assert.deepEqual(evidence.consoleErrors, []);
  assert.deepEqual(evidence.requestFailures, []);
  assert.deepEqual(evidence.httpErrors, []);
  assert.deepEqual(p.browserErrors, []);
  assert.deepEqual(p.socketErrors, []);
  assert.ok(!p.incoming.some(({ message }) => message.t === 'error'), 'Server must not report an error');
  evidence.passed = true;
} catch (error) {
  evidence.failure = error instanceof Error ? error.stack : String(error);
  process.exitCode = 1;
} finally {
  if (page && !page.isClosed()) {
    try { await stopDiagnostics(); } catch (error) { evidence.diagnosticError = String(error); }
    try { evidence.probe ??= await page.evaluate(() => window.__startupProbe?.snapshot?.() ?? null); } catch (error) { evidence.captureError = String(error); }
    if (!evidence.passed) try { await page.screenshot({ path: path('png'), timeout: 15_000 }); } catch (error) { evidence.screenshotError = String(error); }
  }
  if (context) try { await context.close(); } catch (error) { evidence.contextCloseError = String(error); }
  if (video) try { await video.saveAs(path('webm')); await video.delete(); } catch (error) { evidence.videoError = String(error); }
  if (browser) try { await browser.close(); } catch (error) { evidence.browserCloseError = String(error); }
  await writeFile(path('json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ label, passed: evidence.passed, renderer: evidence.renderer?.renderer, timingsFromStartMs: evidence.timingsFromStartMs, sample: evidence.sample, inputsBeforeReadiness: evidence.inputSummary?.beforeReadiness, evidence: path('json'), failure: evidence.failure?.split('\n')[0] }));
}
