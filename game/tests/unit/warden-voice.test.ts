import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUBTITLE_S, Voice, voiceVolume } from '../../client/src/voice.ts';

type Listener = EventListenerOrEventListenerObject;

/** A DOM event surface without requiring a browser or a jsdom dependency. */
class GestureTarget {
  readonly listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, listener: Listener | null): void {
    if (!listener) return;
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: Listener | null): void {
    if (listener) this.listeners.get(type)?.delete(listener);
  }
  emit(type: string, trusted: boolean): void {
    const event = { type, isTrusted: trusted, repeat: false, button: 0, key: 'Enter', code: 'Enter' } as unknown as Event;
    for (const listener of [...this.listeners.get(type) ?? []]) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }
}

class AudioParamMock {
  private currentValue = 1;
  readonly values: number[] = [];
  get value(): number { return this.currentValue; }
  set value(value: number) { this.currentValue = value; this.values.push(value); }
  setValueAtTime(value: number): this { this.value = value; return this; }
  linearRampToValueAtTime(value: number): this { this.value = value; return this; }
  exponentialRampToValueAtTime(value: number): this { this.value = value; return this; }
  setTargetAtTime(value: number): this { this.value = value; return this; }
  setValueCurveAtTime(values: Float32Array): this { this.values.push(...values); return this; }
  cancelScheduledValues(): this { return this; }
  cancelAndHoldAtTime(): this { return this; }
}

class AudioNodeMock {
  readonly connections = new Set<AudioNodeMock>();
  readonly disconnect = vi.fn(() => this.connections.clear());
  readonly connect = vi.fn((node: AudioNodeMock) => { this.connections.add(node); return node; });
}

class GainMock extends AudioNodeMock { readonly gain = new AudioParamMock(); }
class FilterMock extends AudioNodeMock {
  type = 'lowpass';
  readonly frequency = new AudioParamMock();
  readonly Q = new AudioParamMock();
  readonly gain = new AudioParamMock();
  readonly detune = new AudioParamMock();
}
class SourceMock extends AudioNodeMock {
  type = 'sine';
  buffer: unknown;
  loop = false;
  readonly frequency = new AudioParamMock();
  readonly detune = new AudioParamMock();
  readonly playbackRate = new AudioParamMock();
  onended: ((event: Event) => unknown) | null = null;
  readonly start = vi.fn((_when?: number) => undefined);
  readonly stop = vi.fn((_when?: number) => undefined);
  readonly setPeriodicWave = vi.fn();
  finish(): void { this.onended?.(new Event('ended')); }
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let contexts: AudioContextMock[];
let nextResume: Deferred | undefined;
let nextSuspend: Deferred | undefined;
let failConstruction: boolean;

class AudioContextMock {
  readonly destination = new AudioNodeMock();
  readonly nodes: AudioNodeMock[] = [];
  readonly sources: SourceMock[] = [];
  readonly sampleRate = 48_000;
  currentTime = 10;
  state: AudioContextState = 'suspended';
  resumeState: AudioContextState = 'running';
  onstatechange: ((event: Event) => unknown) | null = null;
  readonly resume = vi.fn(async () => {
    const pending = nextResume;
    nextResume = undefined;
    if (pending) await pending.promise;
    // Closing a real AudioContext is terminal, including for an earlier pending resume.
    if (this.state !== 'closed') this.state = this.resumeState;
  });
  readonly suspend = vi.fn(async () => {
    const pending = nextSuspend;
    nextSuspend = undefined;
    if (pending) await pending.promise;
    if (this.state !== 'closed') this.state = 'suspended';
  });
  readonly close = vi.fn(async () => { this.state = 'closed'; });
  constructor() {
    if (failConstruction) throw new Error('audio device unavailable');
    contexts.push(this);
  }
  createGain(): GainMock { const node = new GainMock(); this.nodes.push(node); return node; }
  createBiquadFilter(): FilterMock { const node = new FilterMock(); this.nodes.push(node); return node; }
  createOscillator(): SourceMock { return this.source(); }
  createBufferSource(): SourceMock { return this.source(); }
  createPeriodicWave(): object { return {}; }
  createBuffer(channels: number, length: number): AudioBuffer {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { length, numberOfChannels: channels, sampleRate: this.sampleRate,
      duration: length / this.sampleRate, getChannelData: (channel: number) => data[channel] } as AudioBuffer;
  }
  private source(): SourceMock {
    const node = new SourceMock();
    this.sources.push(node);
    this.nodes.push(node);
    return node;
  }
}

function subtitle(): HTMLElement {
  const classes = new Set<string>();
  return {
    textContent: '', dataset: {}, style: {}, offsetWidth: 1,
    classList: {
      add: (...names: string[]) => { for (const name of names) classes.add(name); },
      remove: (...names: string[]) => { for (const name of names) classes.delete(name); },
      toggle: (name: string, active: boolean) => active ? classes.add(name) : classes.delete(name),
      contains: (name: string) => classes.has(name),
    },
  } as unknown as HTMLElement;
}

let windowEvents: GestureTarget;
let documentEvents: GestureTarget;
let systemSpeech: { speak: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; getVoices: ReturnType<typeof vi.fn> };
let utterance: ReturnType<typeof vi.fn>;
let voices: Voice[];

function newVoice(el: HTMLElement | null = subtitle()): Voice {
  const voice = new Voice(el);
  voices.push(voice);
  return voice;
}

async function flushAudio(): Promise<void> {
  // Resume, the playback continuation, and rejection handling may each use a microtask.
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function gesture(type = 'pointerdown', trusted = true): void {
  windowEvents.emit(type, trusted);
  documentEvents.emit(type, trusted);
}

function startedSources(): SourceMock[] {
  return contexts.flatMap((context) => context.sources).filter((source) => source.start.mock.calls.length > 0);
}

/** A context-wide master survives phrase cleanup, unlike the nodes owned by each utterance. */
function phraseNodes(ac: AudioContextMock): AudioNodeMock[] {
  // Connection history keeps ownership stable after dispose disconnects the master.
  return ac.nodes.filter((node) => !node.connect.mock.calls.some(([target]) => target === ac.destination));
}

function outputLevel(ac: AudioContextMock): number {
  const master = ac.nodes.find((node): node is GainMock => node instanceof GainMock && node.connections.has(ac.destination));
  if (!master) return 0;
  const outputs = ac.nodes.filter((node): node is GainMock => node instanceof GainMock && node.connections.has(master));
  return master.gain.value * outputs.reduce((sum, output) => sum + output.gain.value, 0);
}

function visibility(hidden: boolean): void {
  Object.assign(document, { hidden, visibilityState: hidden ? 'hidden' : 'visible' });
  documentEvents.emit('visibilitychange', true);
}

beforeEach(() => {
  vi.useFakeTimers();
  contexts = [];
  voices = [];
  nextResume = undefined;
  nextSuspend = undefined;
  failConstruction = false;
  windowEvents = new GestureTarget();
  documentEvents = new GestureTarget();
  vi.stubGlobal('window', Object.assign(windowEvents, { setTimeout, clearTimeout, AudioContext: AudioContextMock }));
  vi.stubGlobal('document', Object.assign(documentEvents, {
    getElementById: () => null, hidden: false, visibilityState: 'visible',
  }));
  vi.stubGlobal('AudioContext', AudioContextMock);
  vi.stubGlobal('navigator', { userActivation: { hasBeenActive: false } });
  vi.stubGlobal('webkitAudioContext', undefined);
  systemSpeech = { speak: vi.fn(), cancel: vi.fn(), getVoices: vi.fn(() => [{ lang: 'zh-CN' }]) };
  utterance = vi.fn();
  vi.stubGlobal('speechSynthesis', systemSpeech);
  vi.stubGlobal('SpeechSynthesisUtterance', utterance);
});

afterEach(async () => {
  for (const voice of voices) voice.dispose();
  await flushAudio();
  expect(systemSpeech.speak).not.toHaveBeenCalled();
  expect(systemSpeech.cancel).not.toHaveBeenCalled();
  expect(systemSpeech.getVoices).not.toHaveBeenCalled();
  expect(utterance).not.toHaveBeenCalled();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('角色074对白', () => {
  it('supports short higher monitor babble while retaining the shared mute and gesture gate', async () => {
    const voice = new Voice(null, { pitch: () => 230, syllableLimit: 2 }); voices.push(voice);
    voice.say('啊', 4); await flushAudio(); expect(startedSources()).toHaveLength(0);
    gesture(); voice.say('啊', 4); await flushAudio();
    const source = startedSources()[0];
    expect(source.frequency.values.length).toBe(6); // two rounded, wordless syllables
    expect(Math.min(...source.frequency.values)).toBeGreaterThan(190);
    expect(Math.max(...source.frequency.values)).toBeLessThan(290);
    voice.setPreferences(1, true);
    expect(source.stop).toHaveBeenCalled();
    const count = startedSources().length;
    voice.say('老', 4); await flushAudio(); expect(startedSources()).toHaveLength(count);
  });

  it('preserves each subtitle verbatim and gives the latest line its own 3.5 seconds', () => {
    const el = subtitle();
    const voice = newVoice(el);
    const line = '角色074：欸？同学，你的作业呢！';
    voice.say(line, 4);
    expect(el.textContent).toBe(line);
    expect(el.dataset.line).toBe(line);
    expect(el.style.animationDuration).toBe('3.5s');
    expect(el.classList.contains('fade')).toBe(true);
    vi.advanceTimersByTime(3_000);
    voice.say('别跑呀～', 4);
    vi.advanceTimersByTime(500);
    expect(el.textContent).toBe('别跑呀～');
    vi.advanceTimersByTime(SUBTITLE_S * 1000 - 501);
    expect(el.textContent).toBe('别跑呀～');
    vi.advanceTimersByTime(1);
    expect(el.textContent).toBe('');
    expect(el.classList.contains('fade')).toBe(false);
  });

  it('retains the existing subtitle visibility boundary and voice distance falloff', () => {
    const el = subtitle();
    const voice = newVoice(el);
    voice.say('看得见', 20);
    expect(el.textContent).toBe('看得见');
    vi.advanceTimersByTime(SUBTITLE_S * 1000);
    voice.say('听得见，看不见', 21);
    expect(el.textContent).toBe('');
    expect(voiceVolume(0)).toBe(1);
    expect(voiceVolume(4)).toBe(1);
    expect(voiceVolume(22)).toBeCloseTo(0.5);
    expect(voiceVolume(40)).toBe(0);
    expect(voiceVolume(Infinity)).toBe(0);
    expect(voiceVolume(NaN)).toBe(0);
  });

  it('never calls the operating system speech APIs, even when a Chinese voice is available', async () => {
    const voice = newVoice();
    voice.say('手势前的对白', 4);
    gesture();
    await flushAudio();
    voice.say('手势后的对白', 4);
    await flushAudio();
    expect(startedSources().length).toBeGreaterThan(0);
    expect(systemSpeech.getVoices).not.toHaveBeenCalled();
    expect(systemSpeech.speak).not.toHaveBeenCalled();
    expect(systemSpeech.cancel).not.toHaveBeenCalled();
    expect(utterance).not.toHaveBeenCalled();
  });

  it('shows subtitles before a gesture without replaying those lines when audio is unlocked', async () => {
    const el = subtitle();
    const voice = newVoice(el);
    voice.say('第一句', 4);
    voice.say('最新一句', 4);
    gesture('pointerdown', false);
    await voice.unlock();
    await flushAudio();
    expect(el.textContent).toBe('最新一句');
    expect(startedSources()).toHaveLength(0);
    gesture();
    await flushAudio();
    expect(startedSources()).toHaveLength(0);
    voice.say('解锁后的新一句', 4);
    await flushAudio();
    expect(startedSources().length).toBeGreaterThan(0);
  });

  it('also unlocks from a keyboard gesture and works without a subtitle element', async () => {
    const voice = newVoice(null);
    gesture('keydown');
    await flushAudio();
    voice.say('听我的脚步声～', 4);
    await flushAudio();
    expect(startedSources().length).toBeGreaterThan(0);
  });

  it('applies distance falloff to the audible output and starts no new source at the cutoff', async () => {
    const voice = newVoice();
    gesture();
    await flushAudio();
    voice.say('相同的对白', 4);
    await flushAudio();
    const ac = contexts[0];
    const closeLevel = outputLevel(ac);
    expect(closeLevel).toBeGreaterThan(0);
    voice.say('相同的对白', 22);
    await flushAudio();
    expect(outputLevel(ac)).toBeCloseTo(closeLevel / 2);
    const count = startedSources().length;
    voice.say('到了声音边界', 40);
    voice.say('无效距离', NaN);
    await flushAudio();
    expect(startedSources()).toHaveLength(count);
    expect(outputLevel(ac)).toBe(0);
  });

  it('does not queue several lines while resume is pending', async () => {
    const pending = deferred();
    nextResume = pending;
    const el = subtitle();
    const voice = newVoice(el);
    gesture();
    voice.say('先说的旧句', 4);
    voice.say('第二句也过时了', 4);
    voice.say('最后一句', 4);
    expect(startedSources()).toHaveLength(0);
    expect(el.textContent).toBe('最后一句');
    pending.resolve();
    await flushAudio();
    const latest = startedSources();
    expect(latest.length).toBeGreaterThan(0);
    // A single subsequent line must replace every source from the pending batch.
    voice.say('最后一句', 4);
    await flushAudio();
    expect(startedSources().length).toBe(latest.length * 2);
    expect(latest.every((source) => source.stop.mock.calls.some(([when]) => when === undefined || when <= contexts[0].currentTime + 0.05))).toBe(true);
  });

  it('drops audio if resume finishes after its useful playback window while the subtitle keeps its 3.5 seconds', async () => {
    const pending = deferred();
    nextResume = pending;
    const el = subtitle();
    const voice = newVoice(el);
    gesture();
    voice.say('没有及时解锁的对白', 4);
    vi.advanceTimersByTime(600);
    pending.resolve();
    await flushAudio();
    expect(startedSources()).toHaveLength(0);
    expect(el.textContent).toBe('没有及时解锁的对白');
    vi.advanceTimersByTime(SUBTITLE_S * 1000 - 600);
    expect(el.textContent).toBe('');
    voice.say('下一句及时说出来', 4);
    await flushAudio();
    expect(startedSources().length).toBeGreaterThan(0);
  });

  it('handles a rejected resume and allows a later gesture to retry', async () => {
    const pending = deferred();
    nextResume = pending;
    const el = subtitle();
    const voice = newVoice(el);
    gesture();
    voice.say('这句仍应显示字幕', 4);
    pending.reject(new Error('user activation was not accepted'));
    await flushAudio();
    expect(startedSources()).toHaveLength(0);
    expect(el.textContent).toBe('这句仍应显示字幕');
    gesture();
    await flushAudio();
    voice.say('下一次手势后恢复', 4);
    await flushAudio();
    expect(startedSources().length).toBeGreaterThan(0);
  });

  it('retries resume inside a new touch gesture even if an earlier resume never settles', async () => {
    const abandonedResume = deferred();
    nextResume = abandonedResume;
    const voice = newVoice();
    gesture();
    voice.say('第一次手势下未解锁的旧句', 4);
    await flushAudio();
    expect(contexts[0].resume).toHaveBeenCalledTimes(1);
    expect(startedSources()).toHaveLength(0);
    gesture('touchend');
    expect(contexts[0].resume).toHaveBeenCalledTimes(2);
    voice.say('新手势里及时说出新的一句', 4);
    await flushAudio();
    const currentCount = startedSources().length;
    expect(currentCount).toBeGreaterThan(0);
    abandonedResume.resolve();
    await flushAudio();
    expect(startedSources()).toHaveLength(currentCount);
  });

  it('stays silent when resume resolves without a running context and can recover on the next gesture', async () => {
    const pending = deferred();
    nextResume = pending;
    const voice = newVoice();
    gesture();
    contexts[0].resumeState = 'suspended';
    voice.say('恢复失败时不要发声', 4);
    pending.resolve();
    await flushAudio();
    expect(startedSources()).toHaveLength(0);
    contexts[0].resumeState = 'running';
    gesture();
    await flushAudio();
    voice.say('恢复后说新的一句', 4);
    await flushAudio();
    expect(startedSources().length).toBeGreaterThan(0);
  });

  it('discards interrupted sound without replaying it when the context returns to running', async () => {
    const voice = newVoice();
    gesture();
    await flushAudio();
    voice.say('即将进入后台的对白', 4);
    await flushAudio();
    const ac = contexts[0];
    const interrupted = startedSources();
    expect(interrupted.length).toBeGreaterThan(0);
    ac.state = 'suspended';
    ac.onstatechange?.(new Event('statechange'));
    expect(interrupted.every((source) => source.disconnect.mock.calls.length > 0)).toBe(true);
    ac.state = 'running';
    ac.onstatechange?.(new Event('statechange'));
    gesture();
    await flushAudio();
    expect(startedSources()).toHaveLength(interrupted.length);
    voice.say('回到前台的新对白', 4);
    await flushAudio();
    expect(startedSources().length).toBeGreaterThan(interrupted.length);
  });

  it('creates a fresh usable context if an old pending context is closed', async () => {
    const abandonedResume = deferred();
    nextResume = abandonedResume;
    const voice = newVoice();
    gesture();
    voice.say('已失效的旧context对白', 4);
    const abandoned = contexts[0];
    abandoned.state = 'closed';
    abandoned.onstatechange?.(new Event('statechange'));
    gesture();
    await flushAudio();
    expect(contexts).toHaveLength(2);
    expect(contexts[1].resume).toHaveBeenCalledTimes(1);
    voice.say('新context当前对白', 4);
    await flushAudio();
    const current = startedSources();
    expect(current.length).toBeGreaterThan(0);
    abandonedResume.resolve();
    await flushAudio();
    expect(abandoned.sources).toHaveLength(0);
    expect(startedSources()).toHaveLength(current.length);
  });

  it('does not move a pending line to a replacement context when closed has not emitted statechange', async () => {
    const pending = deferred();
    nextResume = pending;
    const el = subtitle();
    const voice = newVoice(el);
    gesture();
    voice.say('仍在旧context等待解锁的对白', 4);
    vi.advanceTimersByTime(100);
    const old = contexts[0];
    old.state = 'closed';
    // The state has changed, but its asynchronous event has not reached Voice.
    gesture();
    await flushAudio();
    expect(contexts.at(-1)?.state).toBe('running');
    expect(startedSources()).toHaveLength(0);
    // No new say() has invalidated the old line, and it is still less than 500 ms old.
    pending.resolve();
    await flushAudio();
    expect(startedSources()).toHaveLength(0);
    expect(el.textContent).toBe('仍在旧context等待解锁的对白');
    voice.say('新context只播放新来的对白', 4);
    await flushAudio();
    expect(startedSources().length).toBeGreaterThan(0);
  });

  it('releases both fading and current graphs before replacing a closed context without waiting for statechange', async () => {
    const voice = newVoice();
    gesture();
    await flushAudio();
    const old = contexts[0];
    voice.say('第一句仍在淡出', 4);
    await flushAudio();
    old.currentTime += 0.1;
    voice.say('第二句正在播放', 4);
    await flushAudio();
    expect(old.nodes.some((node) => node.connections.size > 0)).toBe(true);
    const releasedBeforeConstruction: boolean[] = [];
    class ReplacementContext extends AudioContextMock {
      constructor() {
        releasedBeforeConstruction.push(old.nodes.every((node) => node.disconnect.mock.calls.length > 0 && node.connections.size === 0));
        super();
      }
    }
    vi.stubGlobal('AudioContext', ReplacementContext);
    old.state = 'closed';
    // Neither statechange nor ended has fired for the abandoned graphs.
    gesture();
    expect(releasedBeforeConstruction.length).toBeGreaterThan(0);
    expect(releasedBeforeConstruction.every(Boolean)).toBe(true);
    await flushAudio();
    expect(old.nodes.every((node) => node.connections.size === 0)).toBe(true);
    voice.say('替换后仍可播放新句', 4);
    await flushAudio();
    expect(contexts.at(-1)?.sources.some((source) => source.start.mock.calls.length > 0)).toBe(true);
  });

  it('ignores a queued statechange callback from a replaced context', async () => {
    const voice = newVoice();
    gesture();
    await flushAudio();
    const old = contexts[0];
    const queuedOldCallback = old.onstatechange;
    old.state = 'closed';
    old.onstatechange?.(new Event('statechange'));
    gesture();
    await flushAudio();
    const current = contexts[1];
    expect(old.onstatechange).toBeNull();
    voice.say('正在新context里播放的对白', 4);
    await flushAudio();
    expect(current.sources.length).toBeGreaterThan(0);
    // Browsers can already have queued the old callback before it is removed.
    queuedOldCallback?.(new Event('statechange'));
    expect(current.nodes.every((node) => node.disconnect.mock.calls.length === 0)).toBe(true);
    expect(current.sources.every((source) => source.stop.mock.calls.every(([when]) => when !== undefined && when > current.currentTime + 0.05))).toBe(true);
  });

  it.each(['suspend', 'dispose'] as const)('cleans both an interrupted line and its predecessor still fading out on %s', async (action) => {
    const voice = newVoice();
    gesture();
    await flushAudio();
    const ac = contexts[0];
    voice.say('旧句开始淡出', 4);
    await flushAudio();
    const oldGraph = [...ac.nodes];
    ac.currentTime += 0.1;
    voice.say('新句刚开始', 4);
    await flushAudio();
    expect(ac.nodes.length).toBeGreaterThan(oldGraph.length);
    const owned = phraseNodes(ac);
    expect(owned.length).toBeGreaterThan(0);
    expect(oldGraph.filter((node) => owned.includes(node)).every((node) => node.connections.size > 0)).toBe(true);
    // No source has emitted ended yet, including the replaced line.
    if (action === 'suspend') {
      ac.state = 'suspended';
      ac.onstatechange?.(new Event('statechange'));
    } else {
      voice.dispose();
    }
    expect(phraseNodes(ac)).toEqual(owned);
    expect(owned.every((node) => node.disconnect.mock.calls.length > 0)).toBe(true);
    expect(owned.every((node) => node.connections.size === 0)).toBe(true);
    if (action === 'dispose') expect(ac.nodes.every((node) => node.connections.size === 0)).toBe(true);
  });

  it('a new inaudible line cancels old sound and invalidates a pending audible line', async () => {
    const voice = newVoice();
    gesture();
    await flushAudio();
    voice.say('正在说话', 4);
    await flushAudio();
    const oldSources = startedSources();
    expect(oldSources.length).toBeGreaterThan(0);
    voice.say('已经走远了', 40);
    await flushAudio();
    expect(startedSources()).toHaveLength(oldSources.length);
    expect(oldSources.every((source) => source.stop.mock.calls.some(([when]) => when === undefined || when <= contexts[0].currentTime + 0.05))).toBe(true);

    const pending = deferred();
    nextResume = pending;
    contexts[0].state = 'suspended';
    contexts[0].onstatechange?.(new Event('statechange'));
    voice.say('还没解锁的近处句', 4);
    voice.say('最新一句来自远处', Infinity);
    pending.resolve();
    await flushAudio();
    expect(startedSources()).toHaveLength(oldSources.length);
  });

  it('keeps subtitles usable when Web Audio is absent or its constructor fails', async () => {
    const el = subtitle();
    const voice = newVoice(el);
    vi.stubGlobal('AudioContext', undefined);
    (window as unknown as { AudioContext: unknown }).AudioContext = undefined;
    gesture();
    voice.say('没有音频设备也显示', 4);
    await flushAudio();
    expect(el.textContent).toBe('没有音频设备也显示');
    expect(startedSources()).toHaveLength(0);

    vi.stubGlobal('AudioContext', AudioContextMock);
    (window as unknown as { AudioContext: unknown }).AudioContext = AudioContextMock;
    failConstruction = true;
    gesture();
    expect(() => voice.say('设备初始化失败也显示', 4)).not.toThrow();
    await flushAudio();
    expect(el.textContent).toBe('设备初始化失败也显示');
    expect(startedSources()).toHaveLength(0);
    vi.advanceTimersByTime(SUBTITLE_S * 1000);
    expect(el.textContent).toBe('');
    failConstruction = false;
    gesture();
    await flushAudio();
    voice.say('设备恢复后能继续播放', 4);
    await flushAudio();
    expect(startedSources().length).toBeGreaterThan(0);
  });

  it('cleans up a partially built audio graph after a node creation error and accepts the next line', async () => {
    const el = subtitle();
    const voice = newVoice(el);
    gesture();
    await flushAudio();
    const ac = contexts[0];
    vi.spyOn(ac, 'createBiquadFilter').mockImplementationOnce(() => { throw new Error('audio graph allocation failed'); });
    voice.say('建图失败不影响字幕', 4);
    await flushAudio();
    expect(el.textContent).toBe('建图失败不影响字幕');
    expect(startedSources()).toHaveLength(0);
    expect(ac.sources).toHaveLength(1);
    expect(ac.sources[0].stop).toHaveBeenCalled();
    expect(ac.sources[0].disconnect).toHaveBeenCalled();
    voice.say('下句正常发声', 4);
    await flushAudio();
    expect(startedSources().length).toBeGreaterThan(0);
  });

  it('disconnects completed sound and disposes gesture listeners, active sound, and its audio context', async () => {
    const voice = newVoice();
    gesture();
    await flushAudio();
    voice.say('这句话播放完了', 4);
    await flushAudio();
    const completed = startedSources();
    const completedGraph = phraseNodes(contexts[0]);
    expect(completed.length).toBeGreaterThan(0);
    for (const source of completed) source.finish();
    expect(completed.every((source) => source.disconnect.mock.calls.length > 0)).toBe(true);
    expect(completedGraph.every((node) => node.disconnect.mock.calls.length > 0)).toBe(true);
    voice.say('这句话需要被中止', 4);
    await flushAudio();
    const active = startedSources().filter((source) => !completed.includes(source));
    voice.dispose();
    voice.dispose();
    await flushAudio();
    expect(active.every((source) => source.stop.mock.calls.some(([when]) => when === undefined || when <= contexts[0].currentTime + 0.05))).toBe(true);
    expect(contexts[0].close).toHaveBeenCalledTimes(1);
    expect(contexts[0].nodes.every((node) => node.disconnect.mock.calls.length > 0)).toBe(true);
    expect([...windowEvents.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    gesture();
    voice.say('离开后不再播放', 4);
    await flushAudio();
    expect(contexts).toHaveLength(1);
    expect(startedSources()).toHaveLength(completed.length + active.length);
  });
});

describe('voice preferences and lifecycle', () => {
  it.each([{ volume: 1, muted: true }, { volume: 0, muted: false }])('keeps subtitles available at $volume/$muted without creating audio, then speaks only a fresh line', async ({ volume, muted }) => {
    const el = subtitle(), voice = newVoice(el);
    voice.setPreferences(volume, muted);
    gesture();
    voice.say('我们要找到自己的节奏', 4);
    await flushAudio();
    expect(el.textContent).toBe('我们要找到自己的节奏');
    expect(contexts).toHaveLength(0);
    voice.setPreferences(0.5, false);
    await flushAudio();
    expect(contexts).toHaveLength(0);
    expect(startedSources()).toHaveLength(0);
    voice.say('粗疏', 4);
    await flushAudio();
    expect(contexts).toHaveLength(1);
    expect(startedSources()).toHaveLength(1);
    expect(outputLevel(contexts[0])).toBeCloseTo(0.42 * 0.5);
  });

  it('combines master volume and distance attenuation, and updates an audible line live', async () => {
    const voice = newVoice();
    voice.setPreferences(0.6, false);
    gesture();
    await flushAudio();
    voice.say('我们要找到自己的节奏', 22);
    await flushAudio();
    const ac = contexts[0], sources = startedSources();
    expect(outputLevel(ac)).toBeCloseTo(0.42 * 0.5 * 0.6);
    voice.setPreferences(0.2, false);
    expect(outputLevel(ac)).toBeCloseTo(0.42 * 0.5 * 0.2);
    expect(startedSources()).toHaveLength(sources.length);
    expect(sources.every((source) => source.disconnect.mock.calls.length === 0)).toBe(true);
    voice.setPreferences(8, false);
    expect(outputLevel(ac)).toBeCloseTo(0.42 * 0.5);
  });

  it.each([-1, NaN, Infinity, -Infinity])('treats invalid or negative volume %s as silent and never sends invalid gain values', async (volume) => {
    const el = subtitle(), voice = newVoice(el);
    gesture();
    await flushAudio();
    voice.say('你有担当吗', 4);
    await flushAudio();
    const ac = contexts[0], count = startedSources().length;
    voice.setPreferences(volume, false);
    expect(outputLevel(ac)).toBe(0);
    voice.say('粗疏', 4);
    await flushAudio();
    expect(startedSources()).toHaveLength(count);
    expect(el.textContent).toBe('粗疏');
    expect(ac.nodes.filter((node): node is GainMock => node instanceof GainMock)
      .every((node) => [node.gain.value, ...node.gain.values].every((value) => Number.isFinite(value) && value >= 0 && value <= 1))).toBe(true);
  });

  it.each([{ volume: 0.7, muted: true }, { volume: 0, muted: false }])('silencing with $volume/$muted releases active and fading phrases while preserving subtitles and has no backlog', async ({ volume, muted }) => {
    const el = subtitle(), voice = newVoice(el);
    gesture();
    await flushAudio();
    voice.say('我们要找到自己的节奏', 4);
    await flushAudio();
    const ac = contexts[0];
    ac.currentTime += 0.1;
    voice.say('你缺乏青春舒展的姿态', 4);
    await flushAudio();
    const owned = phraseNodes(ac), sources = startedSources();
    expect(sources).toHaveLength(2);
    voice.setPreferences(volume, muted);
    expect(outputLevel(ac)).toBe(0);
    expect(owned.every((node) => node.disconnect.mock.calls.length > 0)).toBe(true);
    expect(owned.every((node) => node.connections.size === 0)).toBe(true);
    expect(sources.every((source) => source.stop.mock.calls.some(([when]) => when === undefined || when <= ac.currentTime))).toBe(true);
    expect(el.textContent).toBe('你缺乏青春舒展的姿态');
    voice.setPreferences(0.7, false);
    await flushAudio();
    expect(startedSources()).toHaveLength(sources.length);
    voice.say('粗疏', 4);
    await flushAudio();
    expect(startedSources()).toHaveLength(sources.length + 1);
    expect(outputLevel(ac)).toBeCloseTo(0.42 * 0.7);
  });

  it.each([{ volume: 1, muted: true }, { volume: 0, muted: false }])('silencing with $volume/$muted invalidates an in-flight resume even when restored before it settles', async ({ volume, muted }) => {
    const pending = deferred(); nextResume = pending;
    const voice = newVoice();
    gesture();
    voice.say('我们要找到自己的节奏', 4);
    voice.setPreferences(volume, muted);
    voice.setPreferences(1, false);
    pending.resolve();
    await flushAudio();
    expect(startedSources()).toHaveLength(0);
    voice.say('粗疏', 4);
    await flushAudio();
    expect(startedSources()).toHaveLength(1);
  });

  it.each([{ volume: 1, muted: true }, { volume: 0, muted: false }])('a delayed line captured before $volume/$muted stays subtitle-only after audio is restored', async ({ volume, muted }) => {
    const el = subtitle(), voice = newVoice(el);
    gesture();
    await flushAudio();
    const playback = voice.capturePlayback();
    expect(playback).not.toBeNull();
    voice.setPreferences(volume, muted);
    voice.setPreferences(0.6, false);
    const line = '角色074：我们要找到自己的节奏！';
    voice.say(line, 4, playback);
    await flushAudio();
    expect(el.textContent).toBe(line);
    expect(el.dataset.line).toBe(line);
    expect(el.style.animationDuration).toBe('3.5s');
    expect(startedSources()).toHaveLength(0);
    voice.say('粗疏', 4);
    await flushAudio();
    expect(startedSources()).toHaveLength(1);
    expect(outputLevel(contexts[0])).toBeCloseTo(0.42 * 0.6);
  });

  it('a delayed pre-gesture line keeps its original subtitle without becoming audible after a gesture', async () => {
    const el = subtitle(), voice = newVoice(el);
    const playback = voice.capturePlayback();
    expect(playback).toBeNull();
    gesture();
    await flushAudio();
    voice.say('角色074：你有担当吗？', 4, playback);
    await flushAudio();
    expect(el.textContent).toBe('角色074：你有担当吗？');
    expect(startedSources()).toHaveLength(0);
    voice.say('粗疏', 4);
    await flushAudio();
    expect(startedSources()).toHaveLength(1);
  });

  it('cancel clears the subtitle and timer, releases every phrase, and keeps Voice reusable', async () => {
    const el = subtitle(), voice = newVoice(el);
    gesture();
    await flushAudio();
    voice.say('我们要找到自己的节奏', 4);
    await flushAudio();
    const ac = contexts[0]; ac.currentTime += 0.1;
    voice.say('你缺乏青春舒展的姿态', 4);
    await flushAudio();
    const owned = phraseNodes(ac), count = startedSources().length;
    voice.cancel(); voice.cancel();
    expect(el.textContent).toBe('');
    expect(el.dataset.line ?? '').toBe('');
    expect(el.classList.contains('fade')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(owned.every((node) => node.disconnect.mock.calls.length > 0)).toBe(true);
    expect(owned.every((node) => node.connections.size === 0)).toBe(true);
    expect(ac.close).not.toHaveBeenCalled();
    voice.say('粗疏', 4);
    await flushAudio();
    expect(contexts).toHaveLength(1);
    expect(startedSources()).toHaveLength(count + 1);
    vi.advanceTimersByTime(SUBTITLE_S * 1000 - 1);
    expect(el.textContent).toBe('粗疏');
    vi.advanceTimersByTime(1);
    expect(el.textContent).toBe('');
  });

  it.each([false, true])('cancel invalidates a pending line and preserves fresh dialogue queued before resume: %s', async (freshBeforeResume) => {
    const pending = deferred(); nextResume = pending;
    const el = subtitle(), voice = newVoice(el);
    gesture();
    voice.say('我们要找到自己的节奏', 4);
    voice.cancel();
    expect(el.textContent).toBe('');
    if (freshBeforeResume) voice.say('粗疏', 4);
    pending.resolve();
    await flushAudio();
    if (!freshBeforeResume) {
      expect(el.textContent).toBe('');
      expect(startedSources()).toHaveLength(0);
      voice.say('粗疏', 4);
      await flushAudio();
    }
    expect(el.textContent).toBe('粗疏');
    expect(startedSources()).toHaveLength(1);
  });

  it.each(['visibilitychange', 'pagehide'] as const)('%s cancels immediately; returning and browser activation history cannot replay or unlock it', async (event) => {
    const el = subtitle(), voice = newVoice(el);
    gesture();
    await flushAudio();
    voice.say('我们要找到自己的节奏', 4);
    await flushAudio();
    const ac = contexts[0], owned = phraseNodes(ac), count = startedSources().length;
    if (event === 'visibilitychange') visibility(true);
    else windowEvents.emit('pagehide', true);
    await flushAudio();
    expect(el.textContent).toBe('');
    expect(owned.every((node) => node.connections.size === 0)).toBe(true);
    expect(owned.every((node) => node.disconnect.mock.calls.length > 0)).toBe(true);
    expect(ac.suspend).toHaveBeenCalled();
    expect(ac.state).toBe('suspended');
    expect(vi.getTimerCount()).toBe(0);
    const resumes = ac.resume.mock.calls.length;
    vi.stubGlobal('navigator', { userActivation: { hasBeenActive: true } });
    await voice.unlock();
    gesture('touchend');
    voice.say('后台的新对白也不排队', 4);
    gesture('pointerdown', false);
    await flushAudio();
    expect(el.textContent).toBe('');
    expect(ac.resume).toHaveBeenCalledTimes(resumes);
    if (event === 'visibilitychange') visibility(false);
    else windowEvents.emit('pageshow', true);
    gesture('pointerdown', false);
    voice.say('回来但还没有新手势的旧句', 4);
    await voice.unlock();
    await flushAudio();
    expect(startedSources()).toHaveLength(count);
    expect(ac.resume).toHaveBeenCalledTimes(resumes);
    gesture('keydown');
    expect(ac.resume).toHaveBeenCalledTimes(resumes + 1);
    await flushAudio();
    expect(startedSources()).toHaveLength(count);
    voice.say('粗疏', 4);
    await flushAudio();
    expect(startedSources()).toHaveLength(count + 1);
  });

  it.each([
    { event: 'visibilitychange', afterReturn: false },
    { event: 'visibilitychange', afterReturn: true },
    { event: 'pagehide', afterReturn: false },
    { event: 'pagehide', afterReturn: true },
  ] as const)('$event wins over a late resume (after return: $afterReturn) until fresh foreground input', async ({ event, afterReturn }) => {
    const pending = deferred(); nextResume = pending;
    const voice = newVoice();
    gesture();
    voice.say('我们要找到自己的节奏', 4);
    const ac = contexts[0];
    if (event === 'visibilitychange') visibility(true);
    else windowEvents.emit('pagehide', true);
    await flushAudio();
    if (afterReturn) {
      if (event === 'visibilitychange') visibility(false);
      else windowEvents.emit('pageshow', true);
    }
    pending.resolve();
    await flushAudio();
    expect(startedSources()).toHaveLength(0);
    expect(ac.state).toBe('suspended');
    expect(ac.suspend.mock.calls.length).toBeGreaterThanOrEqual(1);
    if (!afterReturn) {
      if (event === 'visibilitychange') visibility(false);
      else windowEvents.emit('pageshow', true);
    }
    await voice.unlock();
    await flushAudio();
    expect(ac.state).toBe('suspended');
    gesture('touchend');
    await flushAudio();
    voice.say('粗疏', 4);
    await flushAudio();
    expect(startedSources()).toHaveLength(1);
  });

  it.each(['before suspension settles', 'during corrective resume', 'after repeated gestures'] as const)('a fresh foreground gesture survives an older suspended statechange %s', async (statechangeTiming) => {
    const el = subtitle(), voice = newVoice(el);
    gesture();
    await flushAudio();
    voice.say('进入后台前的旧对白', 4);
    await flushAudio();
    const ac = contexts[0], previous = startedSources();
    expect(previous.length).toBeGreaterThan(0);
    const pending = deferred(); nextSuspend = pending;
    const suspend = ac.suspend.getMockImplementation()!;
    ac.suspend.mockImplementationOnce(async () => {
      await suspend();
      if (statechangeTiming === 'before suspension settles') ac.onstatechange?.(new Event('statechange'));
    });
    visibility(true);
    expect(previous.every((source) => source.connections.size === 0)).toBe(true);
    visibility(false);
    const resumes = ac.resume.mock.calls.length;
    gesture('touchend');
    expect(ac.resume).toHaveBeenCalledTimes(resumes + 1);
    voice.say('回来后新手势里的当前对白', 4);
    await flushAudio();
    expect(startedSources()).toHaveLength(previous.length);
    const correctiveResume = deferred(); nextResume = correctiveResume;
    pending.resolve();
    await flushAudio();
    expect(ac.state).toBe('suspended');
    expect(ac.resume).toHaveBeenCalledTimes(resumes + 2);
    expect(startedSources()).toHaveLength(previous.length);
    const retries: Deferred[] = [];
    let currentLine = '回来后新手势里的当前对白';
    if (statechangeTiming === 'after repeated gestures') {
      for (const type of ['touchend', 'keydown']) {
        const retry = deferred(); nextResume = retry; retries.push(retry);
        gesture(type);
      }
      currentLine = '连续手势后最新的当前对白';
      voice.say(currentLine, 4);
      await flushAudio();
      expect(ac.state).toBe('suspended');
      expect(ac.resume).toHaveBeenCalledTimes(resumes + 4);
      expect(startedSources()).toHaveLength(previous.length);
    }
    if (statechangeTiming !== 'before suspension settles') ac.onstatechange?.(new Event('statechange'));
    (retries.at(-1) ?? correctiveResume).resolve();
    await flushAudio();
    expect(ac.state).toBe('running');
    expect(startedSources()).toHaveLength(previous.length + 1);
    expect(el.textContent).toBe(currentLine);
    correctiveResume.resolve();
    for (const retry of retries) retry.resolve();
    ac.onstatechange?.(new Event('statechange'));
    await flushAudio();
    expect(startedSources()).toHaveLength(previous.length + 1);
    expect(ac.sources.at(-1)?.connections.size).toBeGreaterThan(0);
    expect(previous.every((source) => source.connections.size === 0)).toBe(true);
  });

  it('keeps fresh dialogue when the hide suspension settles before its statechange is dispatched', async () => {
    const el = subtitle(), voice = newVoice(el);
    gesture();
    await flushAudio();
    voice.say('我们要找到自己的节奏', 4);
    await flushAudio();
    const ac = contexts[0], previous = startedSources();
    const pending = deferred(); nextSuspend = pending;
    visibility(true);
    pending.resolve();
    await flushAudio();
    expect(ac.state).toBe('suspended');
    expect(previous.every((source) => source.connections.size === 0)).toBe(true);

    visibility(false);
    const resumed = deferred(); nextResume = resumed;
    gesture('touchend');
    voice.say('粗疏', 4);
    // AudioContext promises settle in microtasks; the browser can deliver statechange later.
    ac.onstatechange?.(new Event('statechange'));
    resumed.resolve();
    await flushAudio();
    expect(ac.state).toBe('running');
    expect(el.textContent).toBe('粗疏');
    expect(startedSources()).toHaveLength(previous.length + 1);
    expect(previous.every((source) => source.connections.size === 0)).toBe(true);
  });

  it('finishes page recovery when suspension was denied so a later device interruption drops its old phrase', async () => {
    const voice = newVoice();
    gesture();
    await flushAudio();
    const ac = contexts[0];
    const denied = deferred(); nextSuspend = denied;
    visibility(true);
    denied.reject(new Error('device denied suspension'));
    await flushAudio();
    expect(ac.state).toBe('running');
    visibility(false);
    gesture('touchend');
    voice.say('粗疏', 4);
    await flushAudio();
    const source = startedSources().at(-1)!;
    expect(source.connections.size).toBeGreaterThan(0);

    const resumed = deferred(); nextResume = resumed;
    ac.state = 'suspended';
    gesture('pointerdown');
    ac.onstatechange?.(new Event('statechange'));
    expect(source.connections.size).toBe(0);
    resumed.resolve();
    await flushAudio();
    expect(startedSources()).toHaveLength(1);
  });

  it('dispose invalidates pending audio and all later public calls while closing its context once', async () => {
    const pending = deferred(); nextResume = pending;
    const el = subtitle(), voice = newVoice(el);
    gesture();
    voice.say('我们要找到自己的节奏', 4);
    const ac = contexts[0];
    voice.dispose(); voice.dispose();
    voice.setPreferences(1, false);
    await voice.unlock();
    gesture();
    voice.say('退出之后不能再次显示或播放', 4);
    pending.resolve();
    await flushAudio();
    expect(el.textContent).toBe('');
    expect(el.dataset.line ?? '').toBe('');
    expect(el.classList.contains('fade')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(contexts).toHaveLength(1);
    expect(ac.close).toHaveBeenCalledTimes(1);
    expect(ac.state).toBe('closed');
    expect(ac.nodes.every((node) => node.disconnect.mock.calls.length > 0 && node.connections.size === 0)).toBe(true);
    expect(startedSources()).toHaveLength(0);
    expect([...windowEvents.listeners.values(), ...documentEvents.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });

  it('removes visibility/page lifecycle listeners and clears captions when disposed', async () => {
    const el = subtitle(), voice = newVoice(el);
    voice.say('我们要找到自己的节奏', 4);
    voice.dispose();
    expect(el.textContent).toBe('');
    expect([...windowEvents.listeners.values(), ...documentEvents.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    visibility(true); windowEvents.emit('pagehide', true); gesture();
    await flushAudio();
    expect(contexts).toHaveLength(0);
  });
});
