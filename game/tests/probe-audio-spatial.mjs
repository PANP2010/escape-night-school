// Real Chromium WebAudio probe. Requires an already-running Vite source server on :4422.
// This script never starts a server, builds assets, requests microphone access, or plays a WAV.
import { chromium } from '@playwright/test';
import { browserArgs } from './browser-args.mjs';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const gameRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(gameRoot, 'test-results/audio-spatial');
const baseURL = 'http://127.0.0.1:4422';
const lifecycleStorageKey = 'audio-spatial-native-lifecycle';
const sampleRate = 48_000, seconds = 0.8;
const launchArgs = browserArgs(['--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'], { softwareGL: '0' });
const checks = [], captures = new Map(), lifecycleMarks = [], errors = [];
const sourceHash = () => createHash('sha256').update(readFileSync(join(gameRoot, 'client/src/sound.ts'))).digest('hex');
const report = {
  sourceSha256: sourceHash(),
  source: '/src/sound.ts', baseURL, sampleRate, seconds, platform: process.platform, launchArgs,
  safety: { headless: true, explicitMuteAudio: true, microphone: false, screenshots: false, video: false },
  offlineAdapter: {
    purpose: 'Sound requires running state before scheduling. Only pre-render state/resume/suspend/close are adapted.',
    native: 'OfflineAudioContext, every audio node, automation, stereo render and compressor are native Chromium WebAudio.',
    lifecycle: 'Adapter state is not lifecycle evidence. Lifecycle below uses a separate native AudioContext in this same browser session.',
    isolation: 'Set the active frame while locked; do not create ambience. Invoke public door/footstep methods through the actual Sound event graph.',
  },
  checks,
};
const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), ...detail });
const db = (a, b) => 20 * Math.log10(Math.max(a, 1e-15) / Math.max(b, 1e-15));
const ratio = (a, b) => a / Math.max(b, 1e-15);
const rounded = (value) => typeof value === 'number' ? Number(value.toPrecision(7)) : value;

// Radix-2 FFT. Band RMS follows Parseval; silence-padding does not invent high frequencies.
function bandEnergy(samples, rate, lo = 1500, hi = 8000) {
  let n = 1; while (n < samples.length) n *= 2;
  const re = new Float64Array(n), im = new Float64Array(n); re.set(samples);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [re[i], re[j]] = [re[j], re[i]];
  }
  for (let width = 2; width <= n; width *= 2) {
    const angle = -2 * Math.PI / width, wr0 = Math.cos(angle), wi0 = Math.sin(angle);
    for (let start = 0; start < n; start += width) {
      let wr = 1, wi = 0;
      for (let j = 0; j < width / 2; j++) {
        const a = start + j, b = a + width / 2;
        const r = re[b] * wr - im[b] * wi, v = re[b] * wi + im[b] * wr;
        re[b] = re[a] - r; im[b] = im[a] - v; re[a] += r; im[a] += v;
        const next = wr * wr0 - wi * wi0; wi = wr * wi0 + wi * wr0; wr = next;
      }
    }
  }
  let total = 0, high = 0, weighted = 0;
  for (let k = 1; k < n / 2; k++) {
    const hz = k * rate / n, power = 2 * (re[k] ** 2 + im[k] ** 2);
    total += power; weighted += hz * power;
    if (hz >= lo && hz <= hi) high += power;
  }
  // Normalize to the actual capture length rather than the zero-padded FFT length.
  return { total: total / (n * samples.length), high: high / (n * samples.length), weighted, sum: total };
}

function measure(pcm, rate) {
  const frames = pcm.length / 8;
  const channels = [new Float32Array(frames), new Float32Array(frames)];
  const energy = [0, 0], energyByFrame = new Float64Array(frames);
  let peak = 0, finite = true;
  for (let i = 0; i < frames; i++) for (let ch = 0; ch < 2; ch++) {
    const x = pcm.readFloatLE(i * 8 + ch * 4); channels[ch][i] = x;
    finite &&= Number.isFinite(x); peak = Math.max(peak, Math.abs(x));
    energy[ch] += x * x; energyByFrame[i] += x * x;
  }
  const rms = energy.map((e) => Math.sqrt(e / frames));
  const bands = channels.map((samples) => bandEnergy(samples, rate));
  const total = energy[0] + energy[1];
  let accumulated = 0, energyStart01 = 0, energyEnd99 = 0, foundStart = false;
  for (let i = 0; total > 0 && i < frames; i++) {
    accumulated += energyByFrame[i];
    if (!foundStart && accumulated >= total * 0.01) { energyStart01 = i / rate; foundStart = true; }
    if (accumulated >= total * 0.99) { energyEnd99 = i / rate; break; }
  }
  return {
    frames, finite, peak, rms: Math.sqrt(total / (2 * frames)),
    leftRms: rms[0], rightRms: rms[1], balanceDb: db(rms[1], rms[0]),
    highBandHz: [1500, 8000], highRms: Math.sqrt((bands[0].high + bands[1].high) / 2),
    highFraction: ratio(bands[0].high + bands[1].high, bands[0].total + bands[1].total),
    centroidHz: ratio(bands[0].weighted + bands[1].weighted, bands[0].sum + bands[1].sum),
    energyStart01, energyEnd99, energySpan98: energyEnd99 - energyStart01,
  };
}

function wav(pcm, rate) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); // IEEE float preserves peaks without clipping/quantization.
  header.writeUInt16LE(2, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 8, 28);
  header.writeUInt16LE(8, 32); header.writeUInt16LE(32, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

if (process.argv.includes('--help')) {
  console.log('With Vite already serving this worktree on 127.0.0.1:4422: node tests/probe-audio-spatial.mjs');
  console.log('Writes native stereo float WAV files and report.json under game/test-results/audio-spatial.');
  process.exit(0);
}

mkdirSync(out, { recursive: true });
let browser, context;
try {
  if (!launchArgs.includes('--mute-audio') || !launchArgs.includes('--use-angle=metal')) {
    throw new Error('This probe requires explicit --mute-audio and ANGLE Metal before launching a browser');
  }
  browser = await chromium.launch({ headless: true, args: launchArgs });
  report.chromium = browser.version();
  context = await browser.newContext({ baseURL, viewport: { width: 640, height: 360 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    const prefix = 'AUDIO_SPATIAL_LIFECYCLE ';
    if (m.text().startsWith(prefix)) {
      try { lifecycleMarks.push(JSON.parse(m.text().slice(prefix.length))); } catch { /* Preserve actual page errors separately. */ }
    }
  });
  // A same-origin harness imports source TS through Vite without constructing the game, WS, or renderer.
  await page.route('**/__audio_spatial_probe__*', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><title>Spatial audio probe</title><button id="gesture">Run trusted audio gesture</button>',
  }));
  await page.goto('/__audio_spatial_probe__');
  await page.evaluate(async ({ modules, sampleRate, seconds, lifecycleStorageKey }) => {
    const { Sound } = await import(modules.sound);
    const { CollisionWorld } = await import(modules.collision);
    const { lineOfSight } = await import(modules.nav);
    const NativeAudio = window.AudioContext, NativeOffline = window.OfflineAudioContext;
    const nativeState = Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'state').get;
    if (!NativeAudio || !NativeOffline) throw new Error('Native WebAudio is unavailable');
    const state = window.__spatial = {
      Sound, NativeAudio, created: [], counts: { resume: 0, suspend: 0, close: 0 },
      operations: [], pendingOperations: new Set(), command: null, pending: null, nativeSound: null,
    };
    const frame = { x: 0, y: 1.6, z: 0, yaw: 0, indoors: false, down: false, threat: 0, active: true, power: true };
    const seedRandom = (seed) => () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
    const encode = (buffer) => {
      const interleaved = new Float32Array(buffer.length * 2);
      const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
      for (let i = 0; i < buffer.length; i++) { interleaved[i * 2] = left[i]; interleaved[i * 2 + 1] = right[i]; }
      const bytes = new Uint8Array(interleaved.buffer); let binary = '';
      for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
      return btoa(binary);
    };
    state.observe = (action, promise) => {
      const operation = { id: state.operations.length + 1, action, status: 'pending' };
      state.operations.push(operation);
      const settled = Promise.resolve(promise).then(
        () => { operation.status = 'fulfilled'; },
        (error) => { operation.status = 'rejected'; operation.error = String(error.message ?? error); },
      );
      state.pendingOperations.add(settled);
      void settled.then(() => state.pendingOperations.delete(settled));
      return promise; // Sound receives the original native control promise.
    };
    class ObservedAudio extends NativeAudio {
      constructor(...args) { super(...args); state.created.push(this); }
      resume() { state.counts.resume++; return state.observe('resume', super.resume()); }
      suspend() { state.counts.suspend++; return state.observe('suspend', super.suspend()); }
      close() { state.counts.close++; return state.observe('close', super.close()); }
    }
    state.createNative = () => {
      window.AudioContext = ObservedAudio;
      const sound = state.nativeSound = new Sound(); sound.update(frame);
      sound.click(); sound.footstep(); sound.door({ x: 1, y: 1, z: 0 }, true);
      return { diagnostics: sound.diagnostics, created: state.created.length, counts: { ...state.counts } };
    };
    state.snapshot = () => ({
      diagnostics: state.nativeSound.diagnostics, created: state.created.length, counts: { ...state.counts },
      hidden: document.hidden, visibilityState: document.visibilityState,
      pendingOperations: state.pendingOperations.size, operations: state.operations.map((operation) => ({ ...operation })),
    });
    state.whenSettled = async () => {
      // Native state may still equal its old value while a control message is pending.
      // Await the actual requested operations before calling any sample a final state.
      while (state.pendingOperations.size) await Promise.allSettled([...state.pendingOperations]);
      const rejected = state.operations.filter((operation) => operation.status === 'rejected');
      if (rejected.length) throw new Error('Native audio control rejected: ' + JSON.stringify(rejected));
      return state.snapshot();
    };
    state.updateNative = () => { state.nativeSound.update(frame); return state.snapshot(); };
    state.preferences = (volume, muted) => { state.nativeSound.setPreferences(volume, muted); return state.snapshot(); };
    state.telemetry = () => {
      // Navigation can discard console messages. Persist the actual browser event and
      // read-only Sound snapshot synchronously before its document is destroyed.
      localStorage.removeItem(lifecycleStorageKey);
      for (const type of ['visibilitychange', 'pagehide', 'pageshow']) {
        const target = type === 'visibilitychange' ? document : window;
        target.addEventListener(type, (event) => {
          const mark = { type, isTrusted: event.isTrusted, persisted: event.persisted ?? null, ...state.snapshot() };
          const marks = JSON.parse(localStorage.getItem(lifecycleStorageKey) ?? '[]');
          marks.push(mark); localStorage.setItem(lifecycleStorageKey, JSON.stringify(marks));
          console.info('AUDIO_SPATIAL_LIFECYCLE ' + JSON.stringify(mark));
        });
      }
    };
    document.querySelector('#gesture').addEventListener('click', (event) => {
      const command = state.command;
      state.pending = (async () => {
        if (!event.isTrusted || !navigator.userActivation.isActive) throw new Error('Audio gesture is not trusted/active');
        if (command.action !== 'offline') {
          const sound = state.nativeSound, sequence = [{ stage: 'before', ...state.snapshot() }];
          if (command.action === 'pause-unlock') { sound.pause(); sequence.push({ stage: 'after-pause', ...state.snapshot() }); }
          sound.unlock(); sequence.push({ stage: 'after-unlock', ...state.snapshot() });
          if (command.action === 'unlock-pause') { sound.pause(); sequence.push({ stage: 'after-pause', ...state.snapshot() }); }
          // All calls above run synchronously inside the trusted handler. Only settlement waits.
          const settled = await state.whenSettled();
          return { trusted: event.isTrusted, action: command.action, sequence, settled };
        }
        const previousRandom = Math.random; let sound, ac;
        class OfflineBridge extends NativeOffline {
          mode = 'suspended';
          constructor() { super(2, Math.round(sampleRate * seconds), sampleRate); ac = this; }
          get state() { return this.mode; }
          resume() { this.mode = 'running'; return Promise.resolve(); }
          suspend() { this.mode = 'suspended'; return Promise.resolve(); }
          close() { this.mode = 'closed'; return Promise.resolve(); }
        }
        try {
          Math.random = seedRandom(command.seed ?? 0x51a7);
          window.AudioContext = OfflineBridge;
          sound = new Sound();
          const listener = { ...frame, ...command.listener };
          sound.update(listener); // Actual Sound graph remains locked; no ambient bed masks an event.
          sound.unlock();
          if (!ac || !(ac instanceof NativeOffline)) throw new Error('Sound did not create a native OfflineAudioContext');
          sound.setPreferences(command.volume ?? 0.65, Boolean(command.muted));
          // Let the public preference smoothing settle naturally before the measured event.
          // Suspension and continuation are native OfflineAudioContext operations, not a fake clock.
          const nativeStateBeforeRendering = nativeState.call(ac);
          const suspension = NativeOffline.prototype.suspend.call(ac, 0.125);
          const rendering = NativeOffline.prototype.startRendering.call(ac);
          await suspension;
          const eventTime = ac.currentTime;
          const world = new CollisionWorld(command.boxes ?? []);
          const occluded = command.source ? !lineOfSight(world, listener, command.source) : false;
          const accepted = command.kind === 'door'
            ? sound.door(command.source, command.open, occluded)
            : sound.footstep(Boolean(command.crouch), Boolean(command.run), command.source, occluded, command.sourceIndoors ?? true);
          const before = sound.diagnostics;
          const nodes = [...sound.voices].flatMap((voice) => voice.nodes.map((node) => node.constructor.name));
          await NativeOffline.prototype.resume.call(ac);
          const rendered = await rendering;
          await new Promise((done) => setTimeout(done, 0));
          return {
            pcm: encode(rendered), sampleRate: rendered.sampleRate, channels: rendered.numberOfChannels,
            trusted: event.isTrusted, accepted, occluded, nativeContext: true, nativeStateBeforeRendering, eventTime,
            nativeStateAfterRendering: nativeState.call(ac), before, after: sound.diagnostics, nodes,
          };
        } finally {
          sound?.dispose(); Math.random = previousRandom; window.AudioContext = NativeAudio;
        }
      })();
    });
  }, {
    modules: {
      sound: '/src/sound.ts',
      collision: `/@fs${gameRoot}/shared/campus/collision.ts`,
      nav: `/@fs${gameRoot}/shared/campus/nav.ts`,
    }, sampleRate, seconds, lifecycleStorageKey,
  });

  const gesture = async (command) => {
    await page.evaluate((command) => { window.__spatial.command = command; window.__spatial.pending = null; }, command);
    await page.locator('#gesture').click();
    return page.evaluate(() => window.__spatial.pending);
  };
  const capture = async (name, options) => {
    const { pcm: encoded, ...metadata } = await gesture({ action: 'offline', ...options });
    const pcm = Buffer.from(encoded, 'base64'), signal = measure(pcm, sampleRate);
    const evidence = { name, ...metadata, signal: Object.fromEntries(Object.entries(signal).map(([k, v]) => [k, rounded(v)])), setup: options };
    captures.set(name, { pcm, ...evidence });
    writeFileSync(join(out, `${name}.wav`), wav(pcm, sampleRate));
    check(`${name}: native stereo signal is finite and below clipping`, signal.finite && signal.peak < 0.95 && metadata.nativeContext && metadata.channels === 2, { peak: rounded(signal.peak) });
    if (!options.muted) check(`${name}: actual Sound event reaches rendered destination`, metadata.accepted && signal.peak > 1e-5 && metadata.nodes.includes('StereoPannerNode'), { peak: rounded(signal.peak), accepted: metadata.accepted });
    return evidence.signal;
  };
  const source = { x: 4, y: 1.6, z: 0 };
  const right = await capture('direction-right', { source });
  const left = await capture('direction-left', { source: { ...source, x: -4 } });
  const turned = await capture('yaw-half-turn', { source, listener: { yaw: Math.PI } });
  const front = await capture('direction-front', { source: { x: 0, y: 1.6, z: -4 } });
  const quarter = await capture('yaw-quarter-turn', { source: { x: 0, y: 1.6, z: -4 }, listener: { yaw: Math.PI / 2 } });
  check('right/left sources reach the matching ear', right.balanceDb > 5 && left.balanceDb < -5, { rightDb: right.balanceDb, leftDb: left.balanceDb });
  check('a fixed world source changes ear after a half yaw turn', turned.balanceDb < -5, { beforeDb: right.balanceDb, afterDb: turned.balanceDb });
  check('a frontal source centers, then turns right after quarter yaw', Math.abs(front.balanceDb) < 3 && quarter.balanceDb > 5, { frontDb: front.balanceDb, turnedDb: quarter.balanceDb });

  // Feet and listener ears are deliberately different heights. Do not call the 1.45 m ear/foot delta a storey.
  const listener = { y: 5.2 }, sameFloor = { x: 0, y: 3.75, z: -4 }, below = { ...sameFloor, y: 0.15 };
  const same = await capture('floor-same', { listener, source: sameFloor });
  const lower = await capture('floor-below-clear', { listener, source: below });
  const slab = await capture('floor-below-slab', { listener, source: below, boxes: [{ minX: -10, maxX: 10, minY: 3.35, maxY: 3.65, minZ: -10, maxZ: 10 }] });
  const wall = await capture('wall-occluded', { listener, source: sameFloor, boxes: [{ minX: -10, maxX: 10, minY: 3.6, maxY: 7, minZ: -2.1, maxZ: -1.9 }] });
  check('same horizontal distance: lower floor loses RMS and upper-band energy', lower.rms < same.rms * 0.7 && lower.highFraction < same.highFraction * 0.8, { rmsRatio: rounded(ratio(lower.rms, same.rms)), highFractionRatio: rounded(ratio(lower.highFraction, same.highFraction)) });
  check('actual collision slab adds audible attenuation and low-pass loss', captures.get('floor-below-slab').occluded && slab.rms < lower.rms * 0.5 && slab.highFraction < lower.highFraction * 0.6, { rmsRatio: rounded(ratio(slab.rms, lower.rms)), highFractionRatio: rounded(ratio(slab.highFraction, lower.highFraction)) });
  check('actual collision wall adds audible attenuation and low-pass loss', captures.get('wall-occluded').occluded && wall.rms < same.rms * 0.5 && wall.highFraction < same.highFraction * 0.6, { rmsRatio: rounded(ratio(wall.rms, same.rms)), highFractionRatio: rounded(ratio(wall.highFraction, same.highFraction)) });

  const doorOpen = await capture('door-open', { kind: 'door', source: { x: 0, y: 1, z: -2 }, open: true });
  const doorClose = await capture('door-close', { kind: 'door', source: { x: 0, y: 1, z: -2 }, open: false });
  check('door opening creak lasts longer than the closing thud', doorOpen.energySpan98 > doorClose.energySpan98 * 1.5, { open98Seconds: doorOpen.energySpan98, close98Seconds: doorClose.energySpan98 });
  check('door closing has a stronger transient than opening', doorClose.peak > doorOpen.peak * 1.3, { openPeak: doorOpen.peak, closePeak: doorClose.peak });
  const materialSource = { x: 0, y: 0.15, z: -3 };
  const indoor = await capture('step-indoor-source-outdoor-listener', { source: materialSource, sourceIndoors: true });
  const outdoor = await capture('step-outdoor-source-indoor-listener', { source: materialSource, sourceIndoors: false, listener: { indoors: true } });
  const indoorListener = await capture('step-indoor-source-indoor-listener', { source: materialSource, sourceIndoors: true, listener: { indoors: true } });
  check('source indoor tiles retain more high-frequency energy than outdoor ground', indoor.centroidHz > outdoor.centroidHz * 1.15 && indoor.highFraction > outdoor.highFraction * 1.4, { centroidRatio: rounded(ratio(indoor.centroidHz, outdoor.centroidHz)), highFractionRatio: rounded(ratio(indoor.highFraction, outdoor.highFraction)) });
  check('cross-door listener location does not replace the source footstep material', Buffer.compare(captures.get('step-indoor-source-outdoor-listener').pcm, captures.get('step-indoor-source-indoor-listener').pcm) === 0, { outdoorListenerCentroid: indoor.centroidHz, indoorListenerCentroid: indoorListener.centroidHz });

  const full = await capture('volume-full', { source: materialSource });
  const half = await capture('volume-half', { source: materialSource, volume: 0.325 });
  const muted = await capture('volume-muted', { source: materialSource, muted: true });
  check('halving master volume halves the rendered RMS', ratio(half.rms, full.rms) > 0.45 && ratio(half.rms, full.rms) < 0.55, { rmsRatio: rounded(ratio(half.rms, full.rms)) });
  check('mute rejects the event and produces exact digital silence', !captures.get('volume-muted').accepted && muted.peak === 0 && captures.get('volume-muted').before.activeSources === 0, { peak: muted.peak, activeSources: captures.get('volume-muted').before.activeSources });

  // Fixed seeds make the centered stereo-noise audit reproducible. It is reported separately from pan routing.
  const centered = [];
  for (let i = 0; i < 12; i++) centered.push(await capture(`centered-seed-${String(i + 1).padStart(2, '0')}`, { source: { x: 0, y: 0.15, z: 0 }, seed: 0x51a7 + i * 7919 }));
  const absBalances = centered.map((m) => Math.abs(m.balanceDb)).sort((a, b) => a - b);
  report.centeredNoiseAudit = {
    count: centered.length, balanceDb: centered.map((m) => m.balanceDb),
    medianAbsDb: rounded((absBalances[5] + absBalances[6]) / 2), maxAbsDb: rounded(absBalances.at(-1)),
    eventsOver3Db: absBalances.filter((x) => x > 3).length,
    verdict: absBalances.at(-1) > 3 ? 'review-required: a centered short noise event can favor one ear by more than 3 dB' : 'all centered seeds stay within 3 dB',
    note: 'Diagnostic audit of independent noise channels; pan direction/yaw assertions above remain mandatory.',
  };
  check('all twelve centered noise seeds stay within 3 dB between ears', absBalances.at(-1) <= 3, {
    medianAbsDb: report.centeredNoiseAudit.medianAbsDb, maxAbsDb: report.centeredNoiseAudit.maxAbsDb,
    eventsOver3Db: report.centeredNoiseAudit.eventsOver3Db,
  });
  check('native offline completion releases every finite event voice', [...captures.values()].every((capture) => capture.after.activeSources === 0), {
    remaining: [...captures.values()].filter((capture) => capture.after.activeSources !== 0).map((capture) => ({ name: capture.name, activeSources: capture.after.activeSources })),
  });

  const native = report.nativeLifecycle = { initial: await page.evaluate(() => window.__spatial.createNative()), marks: lifecycleMarks };
  await page.evaluate(() => window.__spatial.telemetry());
  check('server-style events while locked do not construct an AudioContext', native.initial.created === 0 && native.initial.diagnostics.state === 'locked' && native.initial.diagnostics.activeSources === 0, native.initial);
  native.unlockPause = await gesture({ action: 'unlock-pause' });
  native.afterUnlockPause = native.unlockPause.settled;
  check('native trusted unlock then pause settles suspended and locked', native.afterUnlockPause.diagnostics.state === 'suspended' && !native.afterUnlockPause.diagnostics.unlocked && native.afterUnlockPause.diagnostics.activeSources === 0 && native.afterUnlockPause.pendingOperations === 0, native.afterUnlockPause);
  native.unlock = await gesture({ action: 'unlock' });
  check('native trusted unlock fulfills its control request and settles running', native.unlock.settled.diagnostics.state === 'running' && native.unlock.settled.pendingOperations === 0, native.unlock.settled);
  await page.evaluate(() => window.__spatial.updateNative());
  native.pauseUnlock = await gesture({ action: 'pause-unlock' });
  native.afterPauseUnlock = await page.evaluate(() => window.__spatial.updateNative());
  check('native trusted pause then unlock settles running on the same context', native.afterPauseUnlock.created === 1 && native.afterPauseUnlock.diagnostics.state === 'running' && native.afterPauseUnlock.diagnostics.unlocked && native.afterPauseUnlock.diagnostics.ambientSources === 5 && native.afterPauseUnlock.pendingOperations === 0, native.afterPauseUnlock);
  native.zeroVolume = await page.evaluate(() => window.__spatial.preferences(0, false));
  native.muted = await page.evaluate(() => window.__spatial.preferences(0.65, true));
  const beforePreferences = native.muted.counts.resume;
  native.unmutedWithoutGesture = await page.evaluate(() => window.__spatial.preferences(0.65, false));
  check('zero volume and mute stop every native source', native.zeroVolume.diagnostics.activeSources === 0 && native.muted.diagnostics.activeSources === 0, { zeroVolume: native.zeroVolume.diagnostics, muted: native.muted.diagnostics });
  check('preferences alone never construct or resume a context', native.unmutedWithoutGesture.created === 1 && native.unmutedWithoutGesture.counts.resume === beforePreferences, native.unmutedWithoutGesture);
  await gesture({ action: 'unlock' });
  await page.evaluate(() => window.__spatial.updateNative());

  // Headless hosts differ in tab visibility. Attempt real tab/minimize operations; never override document.hidden.
  const background = await context.newPage();
  await background.goto('about:blank'); await background.bringToFront();
  native.background = { method: 'background-tab', verified: false };
  await page.waitForTimeout(100);
  let hidden = await page.evaluate(() => document.hidden), windowSession, windowId;
  if (!hidden) {
    try {
      await background.close(); await page.bringToFront();
      windowSession = await context.newCDPSession(page);
      ({ windowId } = await windowSession.send('Browser.getWindowForTarget'));
      await windowSession.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      await page.waitForFunction(() => document.hidden, null, { timeout: 2000, polling: 100 });
      hidden = true; native.background.method = 'native-window-minimize';
    } catch (error) { native.background.availability = String(error.message).split('\n')[0]; }
  }
  if (hidden) {
    await page.waitForFunction(() => !window.__spatial.snapshot().diagnostics.unlocked, null, { polling: 100 });
    native.background.hiddenSnapshot = await page.evaluate(() => window.__spatial.whenSettled());
    const snapshot = native.background.hiddenSnapshot;
    native.background.verified = snapshot.diagnostics.state === 'suspended' && !snapshot.diagnostics.unlocked && snapshot.diagnostics.activeSources === 0 && snapshot.pendingOperations === 0;
    check('native hidden document stops voices and fulfills suspension', native.background.verified, snapshot);
  } else {
    native.background.note = 'This headless host did not expose a real hidden state. No visibility assertion is reported as passed; trusted native pagehide is checked below.';
  }
  if (windowSession && windowId !== undefined) {
    await windowSession.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {});
    await windowSession.detach();
  }
  if (!background.isClosed()) await background.close();
  await page.bringToFront();
  await page.waitForFunction(() => !document.hidden, null, { polling: 100 });
  if (hidden) {
    native.background.visibleWithoutGesture = await page.evaluate(() => window.__spatial.updateNative());
    check('native visibility restoration alone cannot resume audio', native.background.visibleWithoutGesture.diagnostics.state === 'suspended' && native.background.visibleWithoutGesture.diagnostics.activeSources === 0, native.background.visibleWithoutGesture);
  }
  await gesture({ action: 'unlock' });
  native.beforeNavigation = await page.evaluate(() => window.__spatial.updateNative());
  await page.goto('/__audio_spatial_probe__?after-native-pagehide');
  native.persistedMarks = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '[]'), lifecycleStorageKey);
  const realPagehide = native.persistedMarks.filter((m) => m.type === 'pagehide' && m.isTrusted).at(-1);
  native.pagehide = realPagehide ?? null;
  check('a real browser navigation emits trusted pagehide and releases voices', realPagehide && !realPagehide.diagnostics.unlocked && realPagehide.diagnostics.activeSources === 0 && realPagehide.counts.suspend > native.beforeNavigation.counts.suspend, { observed: realPagehide ?? null });
  native.raceEvidence = 'These native sequences verify final states on this run. Immediate state samples are retained; they do not claim a delayed race window was reproduced.';
  check('the source harness has no uncaught browser errors', errors.length === 0, { errors });
} catch (error) {
  report.error = String(error.stack ?? error);
} finally {
  if (context) await context.close();
  if (browser) await browser.close();
  report.sourceSha256After = sourceHash();
  check('Sound source is unchanged throughout the native probe', report.sourceSha256 === report.sourceSha256After, {
    beforeSha256: report.sourceSha256, afterSha256: report.sourceSha256After,
  });
  report.captures = [...captures.values()].map(({ pcm, ...capture }) => capture);
  report.errors = errors;
  report.status = report.error || checks.some((item) => !item.pass) ? 'failed' : 'passed';
  report.visibilityVerified = Boolean(report.nativeLifecycle?.background?.verified);
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  // Keep terminal output bounded; WAV/graph details and every assertion are in report.json.
  console.log(JSON.stringify({
    status: report.status, checks: checks.length, failed: checks.filter((item) => !item.pass),
    centeredNoiseAudit: report.centeredNoiseAudit, visibilityVerified: report.visibilityVerified,
    error: report.error, evidence: 'test-results/audio-spatial/report.json',
  }, null, 2));
}
if (report.status !== 'passed') process.exitCode = 1;
