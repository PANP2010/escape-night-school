// Run against this worktree's Vite server (default http://127.0.0.1:4443):
// node tests/voice-preferences.mjs
// Exactly one muted Chromium process is launched. Headed tabs are switched for
// native visibilitychange; pagehide is explicitly a synthetic handler test.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const baseURL = process.env.VOICE_BASE_URL ?? 'http://127.0.0.1:4443';
const out = process.env.VOICE_EVIDENCE ?? fileURLToPath(new URL('../test-results/voice-preferences/', import.meta.url));
const canonical = '你喜欢我吗？看着我的眼睛，你真的喜欢我吗？！';
mkdirSync(out, { recursive: true });
const report = {
  baseURL, canonical,
  implementation: {
    audio: 'Native OfflineAudioContext renders the production Voice.babble graph; native AudioContext tests the public lifecycle.',
    offlineScheduling: 'Only the offline fixture injects its native context/master and calls the production babble method, because public say requires a running real-time context. Preferences and cancellation use public methods.',
    visibility: 'One isolated Chromium profile is attached through connectOverCDP(noDefaults:true). Playwright never enables focus emulation. Native document.hidden and trusted visibilitychange come from switching two headed tabs; no visibility property is modified.',
    pagehide: 'Synthetic PageTransitionEvent handler integration on a native AudioContext; not a native navigation/BFCache test.',
    audioOutput: 'Chromium --mute-audio; PCM is measured before the OS output device.',
  },
  offline: {}, lifecycle: {}, pageErrors: [], passed: false,
};

function metrics(pcm, rate, from = 0, to = pcm.length / rate) {
  const start = Math.max(0, Math.floor(from * rate));
  const end = Math.min(pcm.length, Math.ceil(to * rate));
  assert(end > start, 'PCM measurement window must contain samples');
  let sum = 0, peak = 0;
  for (let i = start; i < end; i++) {
    assert(Number.isFinite(pcm[i]), 'PCM must contain finite samples');
    sum += pcm[i] * pcm[i];
    peak = Math.max(peak, Math.abs(pcm[i]));
  }
  return { from: start / rate, to: end / rate, samples: end - start, rms: Math.sqrt(sum / (end - start)), peak };
}

function saveAudio(label, record) {
  const raw = Buffer.alloc(record.pcm.length * 4);
  const wave = Buffer.alloc(44 + record.pcm.length * 2);
  wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(record.sampleRate, 24); wave.writeUInt32LE(record.sampleRate * 2, 28);
  wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34);
  wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
  for (let i = 0; i < record.pcm.length; i++) {
    raw.writeFloatLE(record.pcm[i], i * 4);
    wave.writeInt16LE(Math.round(Math.max(-1, Math.min(1, record.pcm[i])) * 32767), 44 + i * 2);
  }
  writeFileSync(`${out}/${label}.f32le`, raw);
  writeFileSync(`${out}/${label}.wav`, wave);
  const { pcm, ...details } = record;
  const result = { ...details, encoding: 'f32le mono (raw), s16le mono (WAV)', full: metrics(pcm, record.sampleRate) };
  report.offline[label] = result;
  return result;
}

// Focus emulation belongs to the CDP session that enabled it: disabling it in a
// second session cannot undo Playwright's default session. Attach without those
// overrides to this test's own headed Chromium and disposable profile instead.
const profile = mkdtempSync(join(tmpdir(), 'escape-voice-evidence-'));
const child = spawn(chromium.executablePath(), [
  `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run',
  '--no-default-browser-check', '--disable-component-update', '--disable-background-networking',
  '--use-angle=metal', '--mute-audio', '--window-size=800,620', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const exited = once(child, 'exit').catch(() => {});
let browser, context;
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Native Chromium startup timed out')), 15_000);
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Native Chromium exited during startup: ${code}`)); });
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, isLocal: true });
  context = browser.contexts()[0];
  await context.route('**/__voice_preferences_probe__*', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><title>Voice preferences evidence</title><button id="gesture">Enable dialogue audio</button><p id="subtitle"></p>',
  }));
  await context.addInitScript(() => {
    const speechCalls = [], oscillators = [], oscillatorRecords = new WeakMap();
    const createOscillator = BaseAudioContext.prototype.createOscillator;
    const connect = AudioNode.prototype.connect;
    const disconnect = AudioNode.prototype.disconnect;
    BaseAudioContext.prototype.createOscillator = function (...args) {
      const node = createOscillator.apply(this, args);
      const record = { node, context: this, connected: false, starts: 0 };
      const start = node.start;
      node.start = function (...startArgs) {
        const result = start.apply(this, startArgs);
        record.starts++;
        return result;
      };
      oscillatorRecords.set(node, record);
      oscillators.push(record);
      return node;
    };
    AudioNode.prototype.connect = function (...args) {
      const result = connect.apply(this, args);
      const record = oscillatorRecords.get(this);
      if (record) record.connected = true;
      return result;
    };
    AudioNode.prototype.disconnect = function (...args) {
      const result = disconnect.apply(this, args);
      const record = oscillatorRecords.get(this);
      if (record && args.length === 0) record.connected = false;
      return result;
    };
    const forbidden = (name) => { speechCalls.push(name); throw new Error(`System speech is forbidden: ${name}`); };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => forbidden('speechSynthesis') });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      configurable: true, value: function () { forbidden('SpeechSynthesisUtterance'); },
    });
    const events = [];
    for (const name of ['pointerdown', 'keydown', 'visibilitychange', 'pagehide', 'pageshow']) {
      (name === 'visibilitychange' ? document : window).addEventListener(name, (event) => {
        events.push({ type: event.type, trusted: event.isTrusted, hidden: document.hidden, at: performance.now() });
      }, true);
    }
    window.__voiceEvidence = {
      speechCalls, oscillators, events,
      snapshot() {
        const voice = this.voice, ac = voice?.ac;
        const sources = oscillators.filter((record) => record.context === ac);
        return {
          hidden: document.hidden, activated: navigator.userActivation?.hasBeenActive ?? false,
          context: ac?.state ?? 'absent', contextTime: ac?.currentTime ?? null, sampleRate: ac?.sampleRate ?? null,
          createdSources: sources.length,
          connectedSources: sources.filter((record) => record.starts > 0 && record.connected).length,
          playing: voice?.playing.size ?? 0, subtitle: document.getElementById('subtitle').textContent,
          line: document.getElementById('subtitle').dataset.line ?? null,
          pageHidden: voice?.pageHidden ?? false, needsGesture: voice?.needsGesture ?? false,
          disposed: voice?.disposed ?? false,
          speechCalls: [...speechCalls], events: [...events],
        };
      },
    };
  });
  const background = await context.newPage();
  await background.goto(`${baseURL}/__voice_preferences_probe__?background`);
  const page = await context.newPage();
  page.on('pageerror', (error) => report.pageErrors.push(error.message));
  background.on('pageerror', (error) => report.pageErrors.push(error.message));
  await page.goto(`${baseURL}/__voice_preferences_probe__`);
  await page.bringToFront();
  const cdp = await context.newCDPSession(page);
  // Playwright evaluate normally sets userGesture:true. Raw CDP keeps every
  // setup, observation and scripted say from accidentally granting activation.
  async function raw(fn, argument) {
    const response = await cdp.send('Runtime.evaluate', {
      expression: `(${fn.toString()})(${JSON.stringify(argument) ?? 'undefined'})`,
      userGesture: false, returnByValue: true, awaitPromise: true,
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    return response.result.value;
  }
  const snapshot = () => raw(() => window.__voiceEvidence.snapshot());
  const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
  async function until(predicate, description, timeout = 6000) {
    const deadline = Date.now() + timeout;
    let value;
    do {
      value = await snapshot();
      if (predicate(value)) return value;
      await delay(25);
    } while (Date.now() < deadline);
    throw new Error(`${description}: ${JSON.stringify(value)}`);
  }
  await page.bringToFront();
  await until((state) => !state.hidden, 'Primary page must be natively visible before setup');
  await raw(async () => {
    const { Voice } = await import('/src/voice.ts');
    window.__voiceEvidence.Voice = Voice;
  });

  for (const scenario of [
    { label: 'volume-1', volume: 1 },
    { label: 'volume-025', volume: 0.25 },
    { label: 'pre-muted', volume: 1, muted: true, publicSay: true },
    { label: 'volume-zero', volume: 0, publicSay: true },
    { label: 'mute-active', volume: 1, action: 'mute', at: 0.64 },
    { label: 'cancel-active', volume: 1, action: 'cancel', at: 0.64 },
    { label: 'cancel-before-attack', volume: 1, action: 'cancel-before-attack' },
  ]) {
    const record = await raw(async ({ scenario, canonical }) => {
      const { Voice } = window.__voiceEvidence;
      const sampleRate = 48000, duration = 2.8;
      const ac = new OfflineAudioContext(1, Math.round(sampleRate * duration), sampleRate);
      const subtitle = document.createElement('p');
      const voice = new Voice(subtitle);
      const master = ac.createGain();
      master.connect(ac.destination);
      voice.ac = ac;
      voice.master = master;
      voice.activated = true;
      voice.setPreferences(scenario.volume, !!scenario.muted);
      if (scenario.publicSay) voice.say(canonical, 4);
      else voice.babble(ac, canonical.length, 1);
      let actionTime = null, sourcesAfterAction = null;
      if (scenario.action === 'cancel-before-attack') {
        actionTime = ac.currentTime;
        voice.cancel();
        sourcesAfterAction = voice.playing.size;
      }
      const pause = scenario.at === undefined ? null : ac.suspend(scenario.at);
      const rendering = ac.startRendering();
      if (pause) {
        await pause;
        actionTime = ac.currentTime;
        if (scenario.action === 'mute') voice.setPreferences(1, true);
        else voice.cancel();
        sourcesAfterAction = voice.playing.size;
        await ac.resume();
      }
      const rendered = await rendering;
      const result = {
        sampleRate, seconds: rendered.length / sampleRate,
        pcm: Array.from(rendered.getChannelData(0)), actionTime, sourcesAfterAction,
        subtitle: subtitle.textContent, line: subtitle.dataset.line ?? null,
      };
      // OfflineAudioContext has no close(); remove only this fixture's context
      // reference before the ordinary listener/node cleanup in Voice.dispose.
      voice.cancel();
      voice.ac = undefined;
      voice.dispose();
      return result;
    }, { scenario, canonical });
    const result = saveAudio(scenario.label, record);
    if (scenario.label === 'volume-1' || scenario.label === 'volume-025') {
      result.steady = metrics(record.pcm, record.sampleRate, 0.35, 1.8);
      assert(result.steady.rms > 0.005, `${scenario.label} must produce native PCM`);
    } else if (scenario.publicSay || scenario.action === 'cancel-before-attack') {
      assert.equal(result.full.peak, 0, `${scenario.label} must render exact silence without an attack spike`);
      if (scenario.publicSay) {
        assert.equal(record.subtitle, canonical, 'Mute/zero volume must preserve the canonical subtitle');
        assert.equal(record.line, canonical);
      } else {
        assert(record.actionTime < 0.008, 'Cancellation must precede the production attack');
        assert.equal(record.sourcesAfterAction, 0);
      }
    } else {
      assert.equal(record.sourcesAfterAction, 0, `${scenario.label} must synchronously release playback`);
      result.before = metrics(record.pcm, record.sampleRate, 0.2, record.actionTime - 0.025);
      result.after = metrics(record.pcm, record.sampleRate, record.actionTime + 128 / record.sampleRate);
      assert(result.before.rms > 0.01, `${scenario.label} must interrupt an already audible signal`);
      assert(result.after.peak <= 1e-7, `${scenario.label} must leave zero signal after cancellation`);
      assert(result.after.rms <= 1e-8, `${scenario.label} must leave zero RMS after cancellation`);
    }
  }
  report.volumeRatio = report.offline['volume-025'].steady.rms / report.offline['volume-1'].steady.rms;
  assert(Math.abs(report.volumeRatio - 0.25) < 0.001, `Native PCM volume ratio must be 0.25, got ${report.volumeRatio}`);

  await raw((text) => {
    const probe = window.__voiceEvidence;
    probe.voice = new probe.Voice();
    probe.voice.setPreferences(0.25, false);
    probe.voice.say(text, 4);
  }, canonical);
  report.lifecycle.beforeGesture = await snapshot();
  assert.equal(report.lifecycle.beforeGesture.activated, false, 'Setup must not grant user activation');
  assert.equal(report.lifecycle.beforeGesture.context, 'absent', 'Preferences and pre-gesture say must not unlock audio');
  assert.equal(report.lifecycle.beforeGesture.subtitle, canonical);
  await page.click('#gesture');
  await until((state) => state.context === 'running', 'Trusted click must unlock the native context');
  await delay(180);
  report.lifecycle.unlockNoReplay = await snapshot();
  assert(report.lifecycle.unlockNoReplay.events.some((event) => event.type === 'pointerdown' && event.trusted));
  assert.equal(report.lifecycle.unlockNoReplay.createdSources, 0, 'Unlock must not replay a pre-gesture line');

  const say = () => raw((text) => window.__voiceEvidence.voice.say(text, 4), canonical);
  await raw(() => window.__voiceEvidence.voice.setPreferences(1, false));
  await say();
  await until((state) => state.playing > 0 && state.connectedSources > 0, 'Public say must start a real source');
  await delay(150);
  await raw(() => window.__voiceEvidence.voice.setPreferences(0.25, true));
  report.lifecycle.mute = await snapshot();
  assert.equal(report.lifecycle.mute.playing, 0);
  assert.equal(report.lifecycle.mute.connectedSources, 0);
  assert.equal(report.lifecycle.mute.subtitle, canonical);
  const mutedSourceCount = report.lifecycle.mute.createdSources;
  await say();
  await raw(() => window.__voiceEvidence.voice.setPreferences(0.25, false));
  await delay(180);
  report.lifecycle.unmuteNoReplay = await snapshot();
  assert.equal(report.lifecycle.unmuteNoReplay.createdSources, mutedSourceCount, 'Unmute must not queue a muted line');
  assert.equal(report.lifecycle.unmuteNoReplay.playing, 0);
  assert.equal(report.lifecycle.unmuteNoReplay.subtitle, canonical);
  assert.equal(report.lifecycle.unmuteNoReplay.line, canonical);

  await say();
  await until((state) => state.playing > 0, 'A fresh line must play before native backgrounding');
  await background.bringToFront();
  report.lifecycle.hidden = await until((state) => state.hidden && state.context === 'suspended' && state.playing === 0 && state.connectedSources === 0,
    'Native tab switching must hide the document, release all sources and suspend audio');
  assert(report.lifecycle.hidden.events.some((event) => event.type === 'visibilitychange' && event.hidden && event.trusted),
    'The hidden event must come from the browser');
  assert.equal(report.lifecycle.hidden.subtitle, '');
  const hiddenSourceCount = report.lifecycle.hidden.createdSources;
  await delay(250);
  report.lifecycle.hiddenStable = await snapshot();
  assert.equal(report.lifecycle.hiddenStable.context, 'suspended');
  assert.equal(report.lifecycle.hiddenStable.playing, 0);
  assert.equal(report.lifecycle.hiddenStable.connectedSources, 0);
  assert(report.lifecycle.hiddenStable.contextTime - report.lifecycle.hidden.contextTime <= 128 / report.lifecycle.hidden.sampleRate,
    'The hidden audio clock must stop within one render quantum');
  await page.bringToFront();
  await until((state) => !state.hidden, 'Foreground tab must become visible');
  await say();
  await raw(() => window.__voiceEvidence.voice.unlock());
  await delay(180);
  report.lifecycle.visibleNoReplay = await snapshot();
  assert.equal(report.lifecycle.visibleNoReplay.context, 'suspended', 'Return requires fresh trusted input');
  assert.equal(report.lifecycle.visibleNoReplay.createdSources, hiddenSourceCount);
  assert.equal(report.lifecycle.visibleNoReplay.playing, 0);
  assert.equal(report.lifecycle.visibleNoReplay.subtitle, canonical);
  await page.click('#gesture');
  await until((state) => state.context === 'running', 'Fresh trusted input must resume after hidden');
  await delay(100);
  assert.equal((await snapshot()).createdSources, hiddenSourceCount, 'Fresh activation must not replay an old line');

  await say();
  await until((state) => state.playing > 0, 'A fresh line must play before the pagehide handler test');
  await raw(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  report.lifecycle.pagehideSynthetic = await until((state) => state.pageHidden && state.context === 'suspended' && state.playing === 0 && state.connectedSources === 0,
    'Synthetic pagehide handler must release sources and suspend the real context');
  assert(report.lifecycle.pagehideSynthetic.events.some((event) => event.type === 'pagehide' && !event.trusted));
  assert.equal(report.lifecycle.pagehideSynthetic.subtitle, '');
  const pagehideSourceCount = report.lifecycle.pagehideSynthetic.createdSources;
  await say();
  assert.equal((await snapshot()).subtitle, '', 'pagehide must block new captions/audio until pageshow');
  await raw(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await say();
  await delay(180);
  report.lifecycle.pageshowSyntheticNoReplay = await snapshot();
  assert.equal(report.lifecycle.pageshowSyntheticNoReplay.context, 'suspended');
  assert.equal(report.lifecycle.pageshowSyntheticNoReplay.createdSources, pagehideSourceCount);
  assert.equal(report.lifecycle.pageshowSyntheticNoReplay.playing, 0);
  assert.equal(report.lifecycle.pageshowSyntheticNoReplay.subtitle, canonical);
  await page.click('#gesture');
  await until((state) => state.context === 'running', 'Trusted input must resume after pageshow');
  assert.equal((await snapshot()).createdSources, pagehideSourceCount);
  await say();
  await until((state) => state.playing > 0, 'A fresh line must play before dispose');
  await raw(() => window.__voiceEvidence.voice.dispose());
  report.lifecycle.disposed = await until((state) => state.context === 'closed' && state.playing === 0 && state.connectedSources === 0,
    'Dispose must close the native context and release all sources');
  const disposedSourceCount = report.lifecycle.disposed.createdSources;
  await raw((text) => {
    const voice = window.__voiceEvidence.voice;
    voice.setPreferences(1, false);
    voice.say(text, 4);
    return voice.unlock();
  }, canonical);
  await page.click('#gesture');
  report.lifecycle.afterDispose = await snapshot();
  assert.equal(report.lifecycle.afterDispose.context, 'closed');
  assert.equal(report.lifecycle.afterDispose.createdSources, disposedSourceCount);
  assert.equal(report.lifecycle.afterDispose.subtitle, '');
  assert.deepEqual(report.lifecycle.afterDispose.speechCalls, [], 'No system speech API may be accessed');
  assert.deepEqual(report.pageErrors, [], 'No browser exception is allowed');
  report.passed = true;
  console.log(JSON.stringify({ passed: true, evidence: out, volumeRatio: report.volumeRatio,
    nativeHidden: true, pagehideTrigger: 'synthetic PageTransitionEvent (handler integration)', speechCalls: 0 }, null, 2));
} catch (error) {
  report.error = error?.stack ?? String(error);
  throw error;
} finally {
  try {
    writeFileSync(`${out}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  } finally {
    try {
      // Browser.close() disconnects this CDP client. Process ownership stays here.
      if (browser) void browser.close().catch(() => {});
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      let timeout;
      const stopped = await Promise.race([
        exited.then(() => true),
        new Promise((resolve) => { timeout = setTimeout(() => resolve(false), 3000); }),
      ]);
      clearTimeout(timeout);
      if (!stopped) { child.kill('SIGKILL'); await exited; }
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  }
}
