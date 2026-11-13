import type { Page } from '@playwright/test';

/** Run the game's actual Web Audio graph silently, then render its wall-clock schedule to PCM. */
export async function installOfflineAudio(page: Page) {
  await page.addInitScript(() => {
    const rate = 24_000;
    let serial = 0;
    class ClockedOfflineContext {
      constructor() {
        const native = new OfflineAudioContext(2, rate * 60, rate);
        const origin = performance.now(), id = ++serial;
        let state: AudioContextState = 'running';
        const clock = () => (performance.now() - origin) / 1000;
        const facade = new Proxy(native, {
          get(target, key) {
            if (key === 'currentTime') return clock();
            if (key === 'state') return state;
            if (key === '__offline') return { native, clock, id };
            if (key === 'resume') return async () => { state = 'running'; };
            if (key === 'suspend') return async () => { state = 'suspended'; };
            if (key === 'close') return async () => { state = 'closed'; };
            const value = Reflect.get(target, key, target);
            if (typeof key === 'string' && key.startsWith('create') && typeof value === 'function') return (...args: unknown[]) => {
              const node = value.apply(target, args);
              if (node instanceof AudioNode) {
                // This is a recording of graph history. Immediate disconnects would erase the past
                // before startRendering; scheduled source.stop already silences each old voice.
                node.disconnect = () => {};
              }
              if (node instanceof OscillatorNode || node instanceof AudioBufferSourceNode) {
                // Native offline time stays at zero until rendering. Unspecified source times must
                // share the wall clock of the game's explicit automation and finite events.
                const start = node.start.bind(node) as (...args: number[]) => void;
                const stop = node.stop.bind(node);
                let stoppedAt = Infinity;
                node.start = ((when = clock(), ...rest: number[]) => start(when, ...rest)) as typeof node.start;
                // A finite real-time voice may already have ended before stopAll. Recording its
                // later cleanup must not overwrite its earlier end and extend it into the fade.
                node.stop = (when = clock()) => { stoppedAt = Math.min(stoppedAt, when); stop(stoppedAt); };
              }
              return node;
            };
            return typeof value === 'function' ? value.bind(target) : value;
          },
          set(target, key, value) { return Reflect.set(target, key, value, target); },
        });
        return facade;
      }
    }
    window.AudioContext = ClockedOfflineContext as unknown as typeof AudioContext;
  });
}

export const audioState = (page: Page) => page.evaluate(() => {
  const g = window.__escape.game()!, sound = g.sound as any;
  return {
    ...sound.diagnostics, seconds: sound.context?.currentTime ?? 0,
    contextId: sound.context?.__offline.id as number | undefined,
    transitioning: sound.transitioning as boolean,
    level: g.level.index, seed: g.level.seed, handoff: (g as any).levelHandoff,
    down: g.down, spectate: (g as any).spectate as boolean,
  };
});

export async function renderOfflineAudio(page: Page, windows: Record<string, [number, number]>) {
  return page.evaluate(async (windows) => {
    const sound = window.__escape.game()!.sound as any;
    const buffer: AudioBuffer = await sound.context.__offline.native.startRendering();
    const rate = buffer.sampleRate;
    const measurements = Object.fromEntries(Object.entries(windows).map(([name, [from, to]]) => {
      if (!(Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to > from && to <= buffer.duration))
        throw new Error(`Invalid offline audio window ${name}: ${from}–${to} / ${buffer.duration}s`);
      let sum = 0, peak = 0, n = 0;
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const channel = buffer.getChannelData(c);
        for (let i = Math.floor(from * rate); i < Math.floor(to * rate); i++) {
          const value = channel[i]; sum += value * value; peak = Math.max(peak, Math.abs(value)); n++;
        }
      }
      return [name, { rms: Math.sqrt(sum / n), peak, from, to }];
    }));
    const [from, to] = windows.resumed;
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) =>
      Array.from(buffer.getChannelData(c).subarray(Math.floor(from * rate), Math.floor(to * rate))));
    return { rate, measurements, channels };
  }, windows);
}
