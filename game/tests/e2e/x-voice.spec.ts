import { toggleSettings } from './settings-controls.ts';
import { expect, test, type CDPSession, type Page, type TestInfo } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { WARDEN_LINES } from '../../shared/lines.ts';

const CANONICAL = '你喜欢我吗？看着我的眼睛，你真的喜欢我吗？！';
type BrowserVoice = { say(text: string, dist: number): void; ac?: AudioContext };
type VoiceGame = { voice: BrowserVoice; draw: boolean };
interface RecordedAudio { sampleRate: number; pcm: number[]; outputConnections: number }
interface Capture {
  mix: GainNode;
  processor: ScriptProcessorNode;
  chunks: Float32Array[];
  recording: boolean;
  connectionsAtStart: number;
}
interface VoiceProbe {
  contexts: Map<BaseAudioContext, Capture>;
  connections: BaseAudioContext[];
  speechCalls: string[];
  serverLines: { id: string; text: string }[];
  begin(ac: AudioContext): void;
  end(ac: AudioContext): RecordedAudio;
}
declare global { interface Window { __voiceProbe: VoiceProbe } }

const sessions = new WeakMap<Page, CDPSession>();
// Chromium's ordinary page.evaluate()/waitForFunction() set userGesture:true.
// Use the raw protocol for the entire autoplay check so automation cannot unlock audio.
async function withoutGesture<R, A>(page: Page, fn: (argument: A) => R, argument: A): Promise<Awaited<R>> {
  let session = sessions.get(page);
  if (!session) { session = await page.context().newCDPSession(page); sessions.set(page, session); }
  const response = await session.send('Runtime.evaluate', {
    expression: `(${fn.toString()})(${JSON.stringify(argument) ?? 'undefined'})`,
    userGesture: false, returnByValue: true, awaitPromise: true,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value as Awaited<R>;
}

// Capture a parallel, muted branch of the actual destination-bound signal. The original
// connection remains audible, while the ScriptProcessor writes silence to avoid doubling it.
// This exercises the browser's real oscillator/filter/gain processing, without faking Web Audio.
async function installProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const contexts = new Map<BaseAudioContext, Capture>();
    const connections: BaseAudioContext[] = [];
    const outputBuses = new WeakSet<AudioNode>();
    const speechCalls: string[] = [];
    const original = AudioNode.prototype.connect as unknown as (this: AudioNode, ...args: unknown[]) => AudioNode | void;
    function capture(ac: AudioContext): Capture {
      const existing = contexts.get(ac);
      if (existing) return existing;
      const mix = ac.createGain();
      mix.channelCount = 1;
      mix.channelCountMode = 'explicit';
      const processor = ac.createScriptProcessor(1024, 1, 1);
      const state: Capture = { mix, processor, chunks: [], recording: false, connectionsAtStart: 0 };
      processor.onaudioprocess = (event) => {
        if (state.recording) state.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
        event.outputBuffer.getChannelData(0).fill(0);
      };
      original.call(mix, processor);
      original.call(processor, ac.destination);
      contexts.set(ac, state);
      return state;
    }
    AudioNode.prototype.connect = function (this: AudioNode, destination: AudioNode | AudioParam, ...ports: number[]) {
      const result = original.call(this, destination, ...ports);
      if (destination === this.context.destination) {
        outputBuses.add(this);
        original.call(this, capture(this.context as AudioContext).mix);
      } else if (destination instanceof AudioNode && outputBuses.has(destination)) {
        // Count each phrase entering its context-wide master; the capture branch bypasses this wrapper.
        connections.push(this.context);
      }
      return result;
    } as typeof AudioNode.prototype.connect;
    const failSpeech = (name: string) => { speechCalls.push(name); throw new Error(`System speech is forbidden: ${name}`); };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => failSpeech('speechSynthesis') });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      configurable: true, value: function () { failSpeech('SpeechSynthesisUtterance'); },
    });
    window.__voiceProbe = {
      contexts, connections, speechCalls, serverLines: [],
      begin(ac) {
        const state = capture(ac);
        state.chunks = [];
        state.connectionsAtStart = connections.filter((context) => context === ac).length;
        state.recording = true;
      },
      end(ac) {
        const state = capture(ac);
        state.recording = false;
        const pcm = new Float32Array(state.chunks.reduce((n, chunk) => n + chunk.length, 0));
        let offset = 0;
        for (const chunk of state.chunks) { pcm.set(chunk, offset); offset += chunk.length; }
        return {
          sampleRate: ac.sampleRate, pcm: Array.from(pcm),
          outputConnections: connections.filter((context) => context === ac).length - state.connectionsAtStart,
        };
      },
    };
  });
}

async function startWithoutGesture(page: Page, receiveServerLines = false): Promise<void> {
  await page.goto('/?nodraw');
  const bootstrap = async (receiveLines: boolean) => {
    const wait = async (ready: () => boolean) => {
      const start = performance.now();
      while (!ready()) {
        if (performance.now() - start > 25_000) throw new Error('Room bootstrap timed out');
        await new Promise((done) => setTimeout(done, 40));
      }
    };
    await wait(() => !!window.__escape && (window.__escape.net as unknown as { ws: WebSocket }).ws.readyState === WebSocket.OPEN);
    if (!receiveLines) {
      // Local signal measurements must not mix in a naturally scheduled patrol line.
      // The separate touch/server test keeps the complete WebSocket message path.
      const original = window.__escape.net.onMsg;
      window.__escape.net.onMsg = (message) => {
        if (message.t === 'event' && message.kind === 'line') return;
        original(message);
      };
    }
    // No fill/click/tap: trusted input here would invalidate the autoplay regression.
    window.__escape.net.send({ t: 'hello', name: '对白验证' });
    window.__escape.net.send({ t: 'create' });
    await wait(() => !!window.__escape.code);
    window.__escape.net.send({ t: 'start' });
    await wait(() => (window.__escape.game()?.snaps ?? 0) > 2);
    // A protocol vote preserves the no-trusted-input autoplay regression while releasing the intro lock.
    const intro = window.__escape.game()!.intro;
    if (intro.active) window.__escape.net.send({ t: 'intro-skip', id: intro.id });
    await wait(() => !window.__escape.game()!.intro.active);
    // Isolate local voice measurements from an unrelated ambient NPC line.
    window.__escape.debug('safe', 600, 1); window.__escape.debug('safe', 600, 2);
  };
  if (page.context().browser()?.browserType().name() === 'chromium') await withoutGesture(page, bootstrap, receiveServerLines);
  else await page.evaluate(bootstrap, receiveServerLines);
}

async function begin(page: Page, text?: string, dist = 4): Promise<void> {
  await page.evaluate(({ text, dist }) => {
    const voice = (window.__escape.game() as unknown as VoiceGame).voice;
    if (!voice.ac) throw new Error('Voice AudioContext was not unlocked');
    window.__voiceProbe.begin(voice.ac);
    if (text !== undefined) voice.say(text, dist);
  }, { text, dist });
}

async function end(page: Page): Promise<RecordedAudio> {
  return page.evaluate(() => {
    const voice = (window.__escape.game() as unknown as VoiceGame).voice;
    return window.__voiceProbe.end(voice.ac!);
  });
}

function rms(pcm: readonly number[]): number {
  return Math.sqrt(pcm.reduce((sum, value) => sum + value * value, 0) / Math.max(1, pcm.length));
}

// A Hann-windowed FFT of several live PCM windows provides broad timbre checks.
// These intentionally allow variation in pitch/melody and avoid pinning filter settings.
function spectrum(pcm: readonly number[], sampleRate: number) {
  const n = 4096, power = new Float64Array(n / 2);
  let windows = 0;
  for (let start = 0; start + n <= pcm.length; start += n) {
    if (rms(pcm.slice(start, start + n)) < 0.003) continue;
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = pcm[start + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const angle = -2 * Math.PI / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0; j < len / 2; j++) {
          const cos = Math.cos(angle * j), sin = Math.sin(angle * j), a = i + j, b = a + len / 2;
          const tr = re[b] * cos - im[b] * sin, ti = re[b] * sin + im[b] * cos;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    for (let i = 1; i < n / 2; i++) power[i] += re[i] ** 2 + im[i] ** 2;
    if (++windows === 12) break;
  }
  let total = 0, low = 0, high = 0, strongest = 0;
  for (let i = 1; i < power.length; i++) {
    const hz = i * sampleRate / n;
    total += power[i];
    if (hz >= 60 && hz <= 450) low += power[i];
    if (hz >= 3000) high += power[i];
    if (power[i] > power[strongest]) strongest = i;
  }
  return { lowEnergy60to450Hz: low / (total || 1), highEnergyAbove3kHz: high / (total || 1), strongestHz: strongest * sampleRate / n };
}

function metrics(record: RecordedAudio) {
  const { pcm, sampleRate } = record;
  let peak = 0, first = -1, last = -1;
  for (let i = 0; i < pcm.length; i++) {
    peak = Math.max(peak, Math.abs(pcm[i]));
    if (Math.abs(pcm[i]) > 0.001) { if (first < 0) first = i; last = i; }
  }
  return {
    sampleRate, duration: pcm.length / sampleRate, rms: rms(pcm), peak,
    firstSound: first / sampleRate, lastSound: last / sampleRate,
    outputConnections: record.outputConnections, ...spectrum(pcm, sampleRate),
  };
}

async function save(record: RecordedAudio, label: string, testInfo: TestInfo) {
  const prefix = resolve('test-results', `voice-browser-${testInfo.project.name}-${label}`);
  const wave = Buffer.alloc(44 + record.pcm.length * 2), raw = Buffer.alloc(record.pcm.length * 4);
  wave.write('RIFF', 0); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(record.sampleRate, 24); wave.writeUInt32LE(record.sampleRate * 2, 28);
  wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
  for (let i = 0; i < record.pcm.length; i++) {
    wave.writeInt16LE(Math.round(Math.max(-1, Math.min(1, record.pcm[i])) * 32767), 44 + i * 2);
    raw.writeFloatLE(record.pcm[i], i * 4);
  }
  const result = metrics(record);
  await Promise.all([
    writeFile(`${prefix}.wav`, wave), writeFile(`${prefix}.f32le`, raw),
    writeFile(`${prefix}.json`, JSON.stringify(result, null, 2) + '\n'),
  ]);
  await testInfo.attach(label, { path: `${prefix}.wav`, contentType: 'audio/wav' });
  return result;
}

function expectBaritone(result: ReturnType<typeof metrics>): void {
  expect(result.sampleRate).toBeGreaterThanOrEqual(8000);
  expect(result.rms).toBeGreaterThan(0.005);
  expect(result.rms).toBeLessThan(0.3);
  expect(result.peak).toBeGreaterThan(0.03);
  expect(result.peak).toBeLessThan(0.9);
  expect(result.lowEnergy60to450Hz).toBeGreaterThan(0.65);
  expect(result.highEnergyAbove3kHz).toBeLessThan(0.05);
  expect(result.strongestHz).toBeGreaterThan(65);
  expect(result.strongestHz).toBeLessThan(220);
}

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  await installProbe(page);
});
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
  expect(await page.evaluate(() => window.__voiceProbe?.speechCalls ?? [])).toEqual([]);
});

test('voice: script-started game has subtitles before input; trusted keyboard produces rounded PCM and distance attenuation', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await startWithoutGesture(page);
  expect(await withoutGesture(page, () => navigator.userActivation?.hasBeenActive ?? false, undefined)).toBe(false);
  const subtitle = page.locator('#subtitle');
  const timing = await withoutGesture(page, async (text: string) => {
    const voice = (window.__escape.game() as unknown as VoiceGame).voice;
    const el = document.getElementById('subtitle')!;
    const started = performance.now();
    const finished = new Promise<number>((done) => {
      const observer = new MutationObserver(() => {
        if (!el.textContent) { observer.disconnect(); done(performance.now() - started); }
      });
      observer.observe(el, { childList: true, characterData: true, subtree: true });
    });
    voice.say(text, 4);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
    return { text: el.textContent, duration: el.style.animationDuration, hasContext: !!voice.ac, clearedAfter: await finished };
  }, CANONICAL);
  await writeFile(resolve('test-results', `voice-browser-${testInfo.project.name}-subtitle-timing.json`), JSON.stringify(timing, null, 2) + '\n');
  expect(timing.text).toBe(CANONICAL);
  expect(timing.duration).toBe('3.5s');
  expect(timing.hasContext).toBe(false);
  expect(timing.clearedAfter).toBeGreaterThan(3300);
  expect(timing.clearedAfter).toBeLessThan(4200);
  expect(await withoutGesture(page, () => document.getElementById('subtitle')!.textContent, undefined)).toBe('');
  expect(await withoutGesture(page, () => !!(window.__escape.game() as unknown as VoiceGame).voice.ac, undefined)).toBe(false);

  await page.keyboard.press('g');
  await expect.poll(() => page.evaluate(() => (window.__escape.game() as unknown as VoiceGame).voice.ac?.state)).toBe('running');
  // G also emits a gameplay toast on the next frame; let it finish before measuring dialogue.
  await expect(page.locator('#subtitle')).toBeEmpty({ timeout: 5000 });
  await begin(page);
  await page.waitForTimeout(350);
  const unlocked = await save(await end(page), 'unlock-no-backlog', testInfo);
  expect(unlocked.rms).toBeLessThan(0.00001);
  expect(unlocked.outputConnections).toBe(0);

  await begin(page, CANONICAL, 4);
  await expect(subtitle).toHaveText(CANONICAL);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `test-results/voice-browser-${testInfo.project.name}-keyboard-subtitle.png` });
  await page.waitForTimeout(2300);
  const near = await save(await end(page), 'keyboard-near', testInfo);
  expectBaritone(near);
  expect(near.outputConnections).toBe(1);

  await begin(page, CANONICAL, 22);
  await page.waitForTimeout(2700);
  const middle = await save(await end(page), 'distance-22m', testInfo);
  expect(middle.rms / near.rms).toBeGreaterThan(0.33);
  expect(middle.rms / near.rms).toBeLessThan(0.67);

  await begin(page, CANONICAL, 40);
  await page.waitForTimeout(800);
  await page.evaluate((text) => (window.__escape.game() as unknown as VoiceGame).voice.say(text, 80), CANONICAL);
  await page.waitForTimeout(800);
  const far = await save(await end(page), 'silent-40m-and-beyond', testInfo);
  expect(far.rms).toBeLessThan(0.00001);
  expect(far.outputConnections).toBe(0);
});

test('voice: simultaneous lines collapse to the latest; interrupting a live line leaves no overlap or queue', async ({ page }, testInfo) => {
  test.setTimeout(75_000);
  await startWithoutGesture(page);
  await page.keyboard.press('g');
  await expect.poll(() => page.evaluate(() => (window.__escape.game() as unknown as VoiceGame).voice.ac?.state)).toBe('running');
  // G also emits a gameplay toast on the next frame; let it finish before measuring dialogue.
  await expect(page.locator('#subtitle')).toBeEmpty({ timeout: 5000 });
  await begin(page);
  await page.evaluate((text) => {
    const voice = (window.__escape.game() as unknown as VoiceGame).voice;
    for (let i = 0; i < 12; i++) voice.say(text, 4);
    voice.say('粗疏', 4);
  }, CANONICAL);
  await expect(page.locator('#subtitle')).toHaveText('粗疏');
  await page.waitForTimeout(2500);
  const burst = await save(await end(page), 'latest-of-13-lines', testInfo);
  expectBaritone(burst);
  expect(burst.outputConnections).toBe(1);
  expect(burst.lastSound).toBeLessThan(1.6);

  await begin(page, CANONICAL, 4);
  await page.waitForTimeout(350);
  await page.evaluate(() => (window.__escape.game() as unknown as VoiceGame).voice.say('粗疏', 4));
  await page.waitForTimeout(2300);
  const interrupted = await end(page);
  const result = await save(interrupted, 'interrupt-long-with-short', testInfo);
  expectBaritone(result);
  expect(result.outputConnections).toBe(2);
  expect(result.lastSound).toBeLessThan(1.8);
  expect(rms(interrupted.pcm.slice(Math.floor(interrupted.sampleRate * 1.8)))).toBeLessThan(0.00001);
});

test('voice: game sound controls scale PCM, silence an active line, and never replay muted dialogue', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await startWithoutGesture(page);
  await page.keyboard.press('g');
  await expect.poll(() => page.evaluate(() => (window.__escape.game() as unknown as VoiceGame).voice.ac?.state)).toBe('running');
  // G also emits a gameplay toast on the next frame; let it finish before measuring dialogue.
  await expect(page.locator('#subtitle')).toBeEmpty({ timeout: 5000 });
  await toggleSettings(page);
  const volume = page.locator('#settings-volume');
  await volume.press('End');
  await expect(volume).toHaveValue('1');
  await begin(page, CANONICAL, 4);
  await page.waitForTimeout(2700);
  const full = await save(await end(page), 'settings-full-volume', testInfo);
  expectBaritone(full);
  expect(full.outputConnections).toBe(1);

  await volume.evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = '0.25'; input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(volume).toHaveAttribute('aria-valuetext', '25%');
  await begin(page, CANONICAL, 4);
  await page.waitForTimeout(2700);
  const quiet = await save(await end(page), 'settings-quarter-volume', testInfo);
  expect(quiet.outputConnections).toBe(1);
  expect(quiet.rms / full.rms).toBeGreaterThan(0.17);
  expect(quiet.rms / full.rms).toBeLessThan(0.35);

  await begin(page, CANONICAL, 4);
  await page.waitForTimeout(350);
  const active = metrics(await end(page));
  expect(active.outputConnections).toBe(1);
  expect(active.rms).toBeGreaterThan(0.001);
  await page.check('#settings-muted');
  await page.waitForTimeout(100);
  await begin(page, CANONICAL, 4);
  await expect(page.locator('#subtitle')).toHaveText(CANONICAL);
  await page.waitForTimeout(350);
  await page.uncheck('#settings-muted');
  await page.waitForTimeout(350);
  const silent = await save(await end(page), 'settings-mute-and-unmute-no-backlog', testInfo);
  expect(silent.outputConnections).toBe(0);
  expect(silent.rms).toBeLessThan(0.00001);

  await begin(page, '粗疏', 4);
  await page.waitForTimeout(1600);
  const fresh = await save(await end(page), 'settings-fresh-after-unmute', testInfo);
  expect(fresh.outputConnections).toBe(1);
  expect(fresh.rms).toBeGreaterThan(0.001);
});

test('voice: L4 announcements share game volume, cancel on fade, and leave dialogue usable after changing level', async ({ page }, testInfo) => {
  test.setTimeout(75_000);
  await startWithoutGesture(page);
  await page.keyboard.press('g');
  await expect.poll(() => page.evaluate(() => (window.__escape.game() as unknown as VoiceGame).voice.ac?.state)).toBe('running');
  // G also emits a gameplay toast on the next frame; let it finish before measuring dialogue.
  await expect(page.locator('#subtitle')).toBeEmpty({ timeout: 5000 });
  // Construct the production L4 view and deliver authoritative station snapshots;
  // this isolates client feedback from the separate L4 puzzle/server regression.
  expect(await page.evaluate(() => {
    const game = window.__escape.game()!;
    game.loadLevel(3, 6401);
    return (game.broadcastView as unknown as { voice: BrowserVoice }).voice === (game as unknown as VoiceGame).voice;
  })).toBe(true);
  const announce = (id: number) => page.evaluate((id) => window.__escape.game()!.onMsg({
    t: 'broadcast', off: false, clues: [null, null, null, null], nextIn: 60,
    call: { id, left: 10, shielded: false },
  }), id);
  await toggleSettings(page);
  await page.check('#settings-muted');
  await begin(page);
  await announce(1);
  await expect(page.locator('#subtitle')).toContainText('午夜点名');
  await page.waitForTimeout(350);
  const muted = await save(await end(page), 'broadcast-muted', testInfo);
  expect(muted.outputConnections).toBe(0);
  expect(muted.rms).toBeLessThan(0.00001);

  await page.uncheck('#settings-muted');
  await begin(page);
  await announce(2);
  await page.waitForTimeout(350);
  expect(metrics(await end(page)).rms).toBeGreaterThan(0.001);
  await page.evaluate(() => window.__escape.game()!.onMsg({ t: 'fade', secs: 3, restart: false }));
  await page.waitForTimeout(100);
  await begin(page);
  await announce(3);
  await page.waitForTimeout(350);
  const faded = await save(await end(page), 'broadcast-after-fade', testInfo);
  expect(faded.outputConnections).toBe(0);
  expect(faded.rms).toBeLessThan(0.00001);
  await expect(page.locator('#subtitle')).toBeEmpty();

  await page.evaluate(() => window.__escape.game()!.loadLevel(0, 6402));
  await begin(page, '粗疏', 4);
  await page.waitForTimeout(1600);
  const fresh = await save(await end(page), 'dialogue-after-broadcast-dispose', testInfo);
  expect(fresh.outputConnections).toBe(1);
  expect(fresh.rms).toBeGreaterThan(0.001);
});

test.describe('touch activation', () => {
  test.use({ hasTouch: true, viewport: { width: 844, height: 390 } });
  test('voice: real touch unlocks audio and real server warden line reaches exact subtitles and PCM', async ({ page }, testInfo) => {
    test.setTimeout(75_000);
    await startWithoutGesture(page, true);
    expect(await withoutGesture(page, () => navigator.userActivation.hasBeenActive, undefined)).toBe(false);
    expect(await withoutGesture(page, () => !!(window.__escape.game() as unknown as VoiceGame).voice.ac, undefined)).toBe(false);
    await page.touchscreen.tap(420, 120);
    await expect.poll(() => page.evaluate(() => (window.__escape.game() as unknown as VoiceGame).voice.ac?.state)).toBe('running');
  // G also emits a gameplay toast on the next frame; let it finish before measuring dialogue.
  await expect(page.locator('#subtitle')).toBeEmpty({ timeout: 5000 });
    await begin(page);
    await page.evaluate(() => {
      const net = window.__escape.net, original = net.onMsg;
      net.onMsg = (message) => {
        if (message.t === 'event' && message.kind === 'line') window.__voiceProbe.serverLines.push({ id: message.id, text: message.text });
        original(message);
      };
      window.__escape.debug('warden', 6);
    });
    await expect.poll(() => page.evaluate(() => window.__voiceProbe.serverLines.length), { timeout: 15_000 }).toBeGreaterThan(0);
    const line = await page.evaluate(() => window.__voiceProbe.serverLines[0]);
    const source = WARDEN_LINES.find((entry) => entry.id === line.id);
    expect(source).toBeDefined();
    const texts = source!.text.includes('{xx}')
      ? ['学习者', '奋斗者', '追梦者', '逃跑者', '奔跑者', '躲藏者', '旁观者', '值日者'].map((role) => source!.text.replace('{xx}', role))
      : [source!.text];
    expect(texts).toContain(line.text);
    await expect(page.locator('#subtitle')).toHaveText(line.text, { timeout: 10_000 });
    expect(await page.locator('#subtitle').evaluate((el) => el.style.animationDuration)).toBe('3.5s');
    await page.screenshot({ path: `test-results/voice-browser-${testInfo.project.name}-touch-server-subtitle.png` });
    await page.waitForTimeout(2400);
    const record = await end(page);
    const result = await save(record, 'touch-server-warden', testInfo);
    expectBaritone(result);
    expect(result.outputConnections).toBeGreaterThan(0);
    await writeFile(resolve('test-results', `voice-browser-${testInfo.project.name}-server-line.json`), JSON.stringify({ line, ...result }, null, 2) + '\n');
  });
});
