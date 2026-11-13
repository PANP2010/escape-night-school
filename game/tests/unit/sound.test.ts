import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Game } from '../../client/src/game.ts';
import { doorSoundPoint, FootstepClock, heartbeatPeriod, Sound, soundSpace } from '../../client/src/sound.ts';
import type { SoundFrame } from '../../client/src/sound.ts';
import { CollisionWorld } from '../../shared/campus/collision.ts';
import { lineOfSight } from '../../shared/campus/nav.ts';
import { campusDoorSlab } from '../../shared/doors.ts';
import type { SpatialMob } from '../../client/src/spatialAudio.ts';
import { frameSlices } from '../../client/src/interp.ts';
import { generateLevel } from '../../shared/level.ts';
import { inactiveGameCollaborators } from './game_fixture.ts';

class FakeParam {
  value = 0;
  setValueAtTime = vi.fn((value: number, _time: number) => { this.value = value; });
  setTargetAtTime = vi.fn((value: number, _time: number, _constant: number) => { this.value = value; });
  exponentialRampToValueAtTime = vi.fn((value: number, _time: number) => { this.value = value; });
  linearRampToValueAtTime = vi.fn((value: number, _time: number) => { this.value = value; });
  cancelScheduledValues = vi.fn((_time: number) => {});
}

class FakeNode {
  readonly kind: string;
  readonly connections: FakeNode[] = [];
  type = '';
  readonly gain = new FakeParam();
  readonly frequency = new FakeParam();
  readonly Q = new FakeParam();
  readonly pan = new FakeParam();
  readonly delayTime = new FakeParam();
  readonly threshold = new FakeParam();
  readonly knee = new FakeParam();
  readonly ratio = new FakeParam();
  readonly attack = new FakeParam();
  readonly release = new FakeParam();
  readonly positionX = new FakeParam();
  readonly positionY = new FakeParam();
  readonly positionZ = new FakeParam();
  readonly forwardX = new FakeParam();
  readonly forwardY = new FakeParam();
  readonly forwardZ = new FakeParam();
  readonly upX = new FakeParam();
  readonly upY = new FakeParam();
  readonly upZ = new FakeParam();
  buffer: unknown = null;
  normalize = true;
  curve: Float32Array | null = null;
  oversample = '';
  panningModel = '';
  distanceModel = '';
  rolloffFactor = 1;
  refDistance = 1;
  maxDistance = 10000;
  connect = vi.fn((node: FakeNode) => { this.connections.push(node); return node; });
  disconnect = vi.fn(() => { this.connections.length = 0; });
  constructor(kind: string) { this.kind = kind; }
}

class FakeSource extends FakeNode {
  loop = false;
  readonly playbackRate = new FakeParam();
  onended: (() => void) | null = null;
  start = vi.fn((..._args: number[]) => {});
  // Scheduled stop must not fire onended early; tests explicitly finish sources.
  stop = vi.fn((..._args: number[]) => {});
  end() { this.onended?.(); }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  currentTime = 0;
  readonly sampleRate = 32;
  state = 'suspended';
  readonly destination = new FakeNode('destination');
  readonly listener = new FakeNode('listener');
  readonly nodes: FakeNode[] = [];
  readonly sources: FakeSource[] = [];
  resume = vi.fn(() => { this.state = 'running'; return Promise.resolve(); });
  suspend = vi.fn(() => { this.state = 'suspended'; return Promise.resolve(); });
  close = vi.fn(() => { this.state = 'closed'; return Promise.resolve(); });
  constructor() { FakeAudioContext.instances.push(this); }
  private node(kind: string) { const node = new FakeNode(kind); this.nodes.push(node); return node; }
  private source(kind: string) { const source = new FakeSource(kind); this.nodes.push(source); this.sources.push(source); return source; }
  createGain() { return this.node('gain'); }
  createDynamicsCompressor() { return this.node('compressor'); }
  createWaveShaper() { return this.node('waveshaper'); }
  createConvolver() { return this.node('convolver'); }
  createPanner() { return this.node('hrtf'); }
  createDelay(_maximum: number) { return this.node('delay'); }
  createBiquadFilter() { return this.node('filter'); }
  createStereoPanner() { return this.node('panner'); }
  createOscillator() { return this.source('oscillator'); }
  createBufferSource() { return this.source('buffer'); }
  createBuffer(channels: number, length: number, _rate: number) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { getChannelData: (channel: number) => data[channel] };
  }
}

/** AudioContext state changes only when its asynchronous control operation completes. */
class DeferredAudioContext extends FakeAudioContext {
  readonly pending: { kind: 'resume' | 'suspend'; resolve: () => void; reject: () => void }[] = [];
  resume = vi.fn(() => this.defer('resume', 'running'));
  suspend = vi.fn(() => this.defer('suspend', 'suspended'));
  private defer(kind: 'resume' | 'suspend', state: string) {
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ kind,
        resolve: () => { if (this.state !== 'closed') this.state = state; resolve(); },
        reject: () => reject(new Error(`${kind} denied`)),
      });
    });
  }
  finish(kind: 'resume' | 'suspend', rejected = false) {
    const operation = this.pending.shift();
    if (operation?.kind !== kind) throw new Error(`Expected pending ${kind}, got ${operation?.kind ?? 'none'}`);
    if (rejected) operation.reject(); else operation.resolve();
  }
}

const sounds: Sound[] = [];
function fixture() {
  FakeAudioContext.instances = [];
  const documentListeners = new Map<string, Set<() => void>>();
  const windowListeners = new Map<string, Set<() => void>>();
  const add = (listeners: Map<string, Set<() => void>>, type: string, listener: () => void) => {
    const set = listeners.get(type) ?? new Set<() => void>(); set.add(listener); listeners.set(type, set);
  };
  const doc = {
    hidden: false,
    getElementById: () => null,
    addEventListener: vi.fn((type: string, listener: () => void) => add(documentListeners, type, listener)),
    removeEventListener: vi.fn((type: string, listener: () => void) => { documentListeners.get(type)?.delete(listener); }),
  };
  const win = {
    AudioContext: FakeAudioContext,
    addEventListener: vi.fn((type: string, listener: () => void) => add(windowListeners, type, listener)),
    removeEventListener: vi.fn((type: string, listener: () => void) => { windowListeners.get(type)?.delete(listener); }),
  };
  const activation = { isActive: true };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  vi.stubGlobal('navigator', { userActivation: activation });
  const sound = new Sound(); sounds.push(sound);
  const frame: SoundFrame = { x: 0, y: 1.6, z: 0, yaw: 0, indoors: false, down: false, threat: 0, active: true, power: true };
  return {
    sound, frame, doc, win, activation, documentListeners, windowListeners,
    start: (ambient = true) => {
      sound.update(frame); // Frame state alone must not create an AudioContext.
      sound.unlock();
      const ac = FakeAudioContext.instances.at(-1)!;
      if (ambient) sound.update(frame);
      return ac;
    },
    visibility: (hidden: boolean) => {
      doc.hidden = hidden;
      for (const listener of documentListeners.get('visibilitychange') ?? []) listener();
    },
    pagehide: () => { for (const listener of windowListeners.get('pagehide') ?? []) listener(); },
  };
}

afterEach(() => {
  for (const sound of sounds.splice(0)) sound.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('soundSpace', () => {
  const listener = { x: 0, y: 1.6, z: 0, yaw: 0 };

  it('starts at full gain, attenuates monotonically, and is silent at 25 metres', () => {
    expect(soundSpace(listener, listener)).toEqual({ distance: 0, gain: 1, pan: 0, cutoff: 6500 });
    const near = soundSpace(listener, { x: 3, y: 1.6, z: 0 });
    const middle = soundSpace(listener, { x: 12, y: 1.6, z: 0 });
    const edge = soundSpace(listener, { x: 24.99, y: 1.6, z: 0 });
    expect(near.distance).toBe(3);
    expect(near.gain).toBeCloseTo((1 - 3 / 25) ** 2 / (1 + 3 * 0.18));
    expect(near.gain).toBeGreaterThan(middle.gain);
    expect(middle.gain).toBeGreaterThan(edge.gain);
    expect(edge.gain).toBeGreaterThan(0);
    expect(soundSpace(listener, { x: 25, y: 1.6, z: 0 }).gain).toBe(0);
    expect(soundSpace(listener, { x: 100, y: 1.6, z: 0 }).gain).toBe(0);
  });

  it('pans relative to camera yaw with bounded left and right ears', () => {
    expect(soundSpace(listener, { x: 4, y: 1.6, z: 0 }).pan).toBeCloseTo(0.85);
    expect(soundSpace(listener, { x: -4, y: 1.6, z: 0 }).pan).toBeCloseTo(-0.85);
    expect(soundSpace(listener, { x: 0, y: 1.6, z: -4 }).pan).toBeCloseTo(0);
    expect(soundSpace({ ...listener, yaw: Math.PI / 2 }, { x: 0, y: 1.6, z: -4 }).pan).toBeCloseTo(0.85);
    expect(soundSpace({ ...listener, yaw: Math.PI }, { x: 4, y: 1.6, z: 0 }).pan).toBeCloseTo(-0.85);
  });

  it('attenuates floor separation more strongly than equal horizontal distance', () => {
    const otherFloor = soundSpace(listener, { x: 0, y: 5.6, z: 0 });
    const sameFloor = soundSpace(listener, { x: 4, y: 1.6, z: 0 });
    expect(otherFloor.distance).toBeCloseTo(6);
    expect(otherFloor.gain).toBeLessThan(sameFloor.gain);
    expect(otherFloor.cutoff).toBeLessThan(sameFloor.cutoff);
    expect(otherFloor.pan).toBe(0);
  });

  it('keeps same-storey feet clear but removes more high frequencies across storeys', () => {
    const ear = { ...listener, y: 5.2 };
    const sameFloor = soundSpace(ear, { x: 4, y: 3.75, z: 0 });
    const lowerFloor = soundSpace(ear, { x: 4, y: 0.15, z: 0 });
    expect(sameFloor.cutoff).toBeCloseTo(6500 / (1 + sameFloor.distance * 0.2));
    // A footstep's own 600–950 Hz material filter must not hide the floor's extra muffling.
    expect(lowerFloor.cutoff).toBeLessThan(600);
    expect(lowerFloor.cutoff).toBeLessThan(sameFloor.cutoff / 4);
    expect(lowerFloor.gain).toBeLessThan(sameFloor.gain);
    expect(lowerFloor.pan).toBe(sameFloor.pan);
    const upperFloor = soundSpace(ear, { x: 4, y: 10.25, z: 0 });
    expect(upperFloor.cutoff).toBeCloseTo(lowerFloor.cutoff);
    const wall = soundSpace(ear, { x: 4, y: 0.15, z: 0 }, true);
    expect(wall.cutoff).toBeLessThan(lowerFloor.cutoff);
    expect(wall.gain).toBeCloseTo(lowerFloor.gain * 0.3);
  });

  it('lowers the floor cutoff continuously after the same-storey height envelope and bounds it', () => {
    const sameStorey = soundSpace(listener, { x: 4, y: listener.y - 2, z: 0 });
    expect(sameStorey.cutoff).toBeCloseTo(6500 / (1 + sameStorey.distance * 0.2));
    let previous = sameStorey.cutoff;
    for (const separation of [2.01, 2.5, 3, 4, 5, 6, 10]) {
      const cutoff = soundSpace(listener, { x: 4, y: listener.y - separation, z: 0 }).cutoff;
      expect(cutoff).toBeLessThanOrEqual(previous);
      expect(cutoff).toBeGreaterThanOrEqual(450);
      previous = cutoff;
    }
  });

  it('muffles occlusion without changing distance or pan and bounds its cutoff', () => {
    const point = { x: 3, y: 1.6, z: -4 };
    const clear = soundSpace(listener, point), wall = soundSpace(listener, point, true);
    expect(wall.distance).toBe(clear.distance);
    expect(wall.pan).toBe(clear.pan);
    expect(wall.gain).toBeCloseTo(clear.gain * 0.3);
    expect(wall.cutoff).toBe(650);
    expect(clear.cutoff).toBeCloseTo(6500 / 2);
    expect(soundSpace(listener, { x: 100, y: 1.6, z: 0 }).cutoff).toBe(900);
  });
});

describe('FootstepClock', () => {
  const countSteps = (speed: number, crouch = false) => {
    const clock = new FootstepClock(); let count = 0;
    for (let i = 0; i < 600; i++) if (clock.step(speed / 60, 1 / 60, crouch)) count++;
    return count;
  };

  it('stays silent when stationary or movement is blocked by a wall', () => {
    expect(countSteps(0)).toBe(0);
    const clock = new FootstepClock();
    expect(clock.step(0.7, 0.25)).toBe(false); // A partial real stride before hitting the wall.
    for (let i = 0; i < 180; i++) expect(clock.step(0, 1 / 60)).toBe(false);
    expect(clock.step(0.7, 0.25)).toBe(false); // A stopped partial stride cannot survive the wall.
  });

  it('uses actual walking distance and produces slower crouching and faster running cadence', () => {
    const crouch = countSteps(1.6, true), walk = countSteps(3.4), run = countSteps(6);
    expect(crouch).toBe(12);
    expect(walk).toBe(21);
    expect(run).toBe(28);
    expect(crouch).toBeLessThan(walk);
    expect(walk).toBeLessThan(run);
  });

  it('resets partial strides for teleports, airborne movement, and invalid input', () => {
    for (const invalid of [
      [50, 1 / 60, true], [0.1, 0, true], [-1, 0.1, true],
      [NaN, 0.1, true], [Infinity, 0.1, true], [0.5, 0.2, false],
    ] as const) {
      const clock = new FootstepClock();
      expect(clock.step(0.9, 0.3)).toBe(false);
      expect(clock.step(invalid[0], invalid[1], false, invalid[2])).toBe(false);
      expect(clock.step(0.7, 0.25)).toBe(false);
    }
  });

  it('emits at most one footfall for a slow frame and does not catch up while still', () => {
    const clock = new FootstepClock();
    expect(clock.step(6, 1)).toBe(true); // Covers multiple strides in one rendered slice.
    for (let i = 0; i < 60; i++) expect(clock.step(0, 1 / 60)).toBe(false);
    expect(clock.step(0.01, 1 / 60)).toBe(false);
    clock.reset(); clock.reset();
    expect(clock.step(0.7, 0.25)).toBe(false);
  });

  it('advances substeps without stacking several sounds at the same rendered timestamp', () => {
    const clock = new FootstepClock();
    for (let frame = 0; frame < 8; frame++) {
      let count = 0;
      for (let slice = 0; slice < 3; slice++) if (clock.step(2, 1 / 3, false, true, frame * 1000)) count++;
      expect(count).toBe(1);
    }
  });

  it('rejects infinite frame durations instead of accumulating a partial stride', () => {
    const clock = new FootstepClock();
    expect(clock.step(0.9, 0.3)).toBe(false);
    expect(clock.step(0.1, Infinity)).toBe(false);
    expect(clock.step(0.7, 0.25)).toBe(false);
  });
});

describe('doorSoundPoint', () => {
  it.each([true, false])('does not treat the emitting door as a wall (alongX=%s)', (alongX) => {
    const door = { id: 0, x: 0, z: 0, alongX, y0: 0, y1: 2.2,
      box: alongX ? { x0: -0.5, x1: 0.5, z0: -0.15, z1: 0.15 } : { x0: -0.15, x1: 0.15, z0: -0.5, z1: 0.5 } };
    const world = new CollisionWorld();
    world.add(campusDoorSlab(door, false));
    for (const side of [-1, 1]) {
      const ear = { x: alongX ? 0 : side * 2, y: 1.6, z: alongX ? side * 2 : 0 };
      expect(lineOfSight(world, ear, { x: 0, y: 1, z: 0 })).toBe(false);
      const face = doorSoundPoint(ear, door);
      expect(face.y).toBe(1);
      expect(lineOfSight(world, ear, face)).toBe(true);
    }
    for (const ear of [{ x: -2, y: 1.6, z: 2 }, { x: 2, y: 1.6, z: -2 }, { x: 0, y: 1.6, z: 2 }, { x: 2, y: 1.6, z: 0 }]) {
      expect(lineOfSight(world, ear, doorSoundPoint(ear, door))).toBe(true);
    }
    world.add({ minX: -3, maxX: 3, minY: 0, maxY: 3, minZ: 0.8, maxZ: 1.2 });
    const ear = { x: 0, y: 1.6, z: 2 };
    expect(lineOfSight(world, ear, doorSoundPoint(ear, door))).toBe(false);
  });
});

describe('heartbeatPeriod', () => {
  it('increases urgency monotonically within a fixed bounded range', () => {
    const values = Array.from({ length: 11 }, (_, i) => heartbeatPeriod(i / 10));
    expect(values[0]).toBe(1.25);
    expect(values.at(-1)).toBeCloseTo(0.6);
    for (let i = 0; i < values.length; i++) {
      expect(values[i]).toBeGreaterThanOrEqual(0.6);
      expect(values[i]).toBeLessThanOrEqual(1.25);
      if (i) expect(values[i]).toBeLessThan(values[i - 1]);
    }
    expect(heartbeatPeriod(-10)).toBe(1.25);
    expect(heartbeatPeriod(10)).toBeCloseTo(0.6);
    expect(heartbeatPeriod(NaN)).toBe(1.25);
    expect(heartbeatPeriod(0, true)).toBe(0.95);
    expect(heartbeatPeriod(1, true)).toBe(0.95);
  });
});

describe('Sound gesture, preference, and active-frame gates', () => {
  it('never creates a context or audio source before a real unlock', () => {
    const f = fixture();
    f.sound.update(f.frame);
    f.sound.click(); f.sound.pickup(); f.sound.humStart(1);
    expect(f.sound.door({ x: 1, y: 1.6, z: 0 }, true)).toBe(false);
    expect(f.sound.footstep()).toBe(false);
    expect(f.sound.tone('sine', 100, 0.1, 0.1)).toBe(false);
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(f.sound.diagnostics).toMatchObject({ unlocked: false, state: 'locked', activeSources: 0, ambientSources: 0 });
    f.activation.isActive = false;
    f.sound.unlock();
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(f.sound.diagnostics.unlocked).toBe(false);
    f.activation.isActive = true;
    f.visibility(true); f.sound.unlock();
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('requires both a running context and an active game frame after unlock', () => {
    const f = fixture();
    f.sound.unlock();
    const ac = FakeAudioContext.instances[0];
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(f.sound.tone('sine', 100, 0.1, 0.1)).toBe(false);
    expect(ac.sources).toHaveLength(0);
    ac.state = 'suspended';
    f.sound.update(f.frame);
    expect(f.sound.tone('sine', 100, 0.1, 0.1)).toBe(false);
    expect(ac.sources).toHaveLength(0);
    f.sound.unlock();
    expect(f.sound.tone('sine', 100, 0.1, 0.1)).toBe(true);
    expect(ac.sources).toHaveLength(1);
    f.sound.update({ ...f.frame, active: false });
    expect(f.sound.diagnostics.activeSources).toBe(0);
    expect(f.sound.tone('sine', 100, 0.1, 0.1)).toBe(false);
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it.each(['missing', 'throws'] as const)('degrades safely when AudioContext is %s', (mode) => {
    const f = fixture();
    const AudioContext = mode === 'missing' ? undefined : class {
      constructor() { throw new Error('audio unavailable'); }
    };
    vi.stubGlobal('window', { ...f.win, AudioContext });
    expect(() => {
      f.sound.update(f.frame); f.sound.unlock(); f.sound.click(); f.sound.humStart(1);
    }).not.toThrow();
    expect(f.sound.footstep()).toBe(false);
    expect(f.sound.diagnostics).toMatchObject({ state: 'locked', activeSources: 0, ambientSources: 0 });
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(() => { f.sound.reset(); f.sound.dispose(); f.sound.dispose(); }).not.toThrow();
  });

  it('catches resume rejection without unhandled errors and allows another trusted retry', async () => {
    const f = fixture(), ac = f.start(false);
    ac.state = 'suspended';
    ac.resume.mockImplementationOnce(() => Promise.reject(new Error('gesture policy')));
    f.sound.unlock();
    // Let an unhandled rejection reach Vitest rather than masking it with a test catch.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ac.resume).toHaveBeenCalledTimes(2);
    expect(ac.state).toBe('suspended');
    f.sound.update(f.frame);
    expect(f.sound.tone('sine', 100, 0.1, 0.1)).toBe(false);
    expect(ac.sources).toHaveLength(0);
    f.sound.unlock();
    expect(ac.resume).toHaveBeenCalledTimes(3);
    expect(f.sound.tone('sine', 100, 0.1, 0.1)).toBe(true);
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it.each([{ volume: 0, muted: false }, { volume: 0.6, muted: true }])(
    'does not construct audio while volume=$volume and muted=$muted', ({ volume, muted }) => {
      const f = fixture();
      f.sound.setPreferences(volume, muted);
      f.sound.update(f.frame); f.sound.unlock();
      f.sound.click(); f.sound.pickup(); f.sound.humStart(1);
      expect(f.sound.capture()).toBe(false);
      expect(f.sound.footstep()).toBe(false);
      expect(FakeAudioContext.instances).toHaveLength(0);
      expect(f.sound.diagnostics).toMatchObject({ unlocked: true, volume, muted, activeSources: 0 });
      f.sound.setPreferences(0.65, false);
      f.sound.update(f.frame);
      expect(FakeAudioContext.instances).toHaveLength(0);
      f.sound.unlock();
      expect(FakeAudioContext.instances).toHaveLength(1);
    },
  );

  it.each([{ volume: 0, muted: false }, { volume: 0.65, muted: true }])(
    'stops existing sources and creates none while volume=$volume and muted=$muted', ({ volume, muted }) => {
      const f = fixture(), ac = f.start();
      expect(f.sound.tone('sine', 100, 0.1, 0.1)).toBe(true);
      const originalSources = [...ac.sources];
      f.sound.setPreferences(volume, muted);
      expect(f.sound.diagnostics.activeSources).toBe(0);
      expect(f.sound.diagnostics.ambientSources).toBe(0);
      for (const source of originalSources) expect(source.stop).toHaveBeenLastCalledWith();
      for (let i = 0; i < 100; i++) {
        ac.currentTime += 1 / 60;
        f.sound.update({ ...f.frame, threat: 1 });
        f.sound.click(); f.sound.pickup(); f.sound.footstep(); f.sound.humStart(1); f.sound.capture();
      }
      f.sound.unlock();
      expect(ac.sources).toHaveLength(originalSources.length);
      expect(FakeAudioContext.instances).toHaveLength(1);
    },
  );
});

describe('Sound bounded graph and event cleanup', () => {
  it('plays one finite contact accent with a bounded noise and bass voice on the existing volume bus', () => {
    const f = fixture(), ac = f.start(false);
    expect(f.sound.capture()).toBe(true);
    expect(f.sound.diagnostics.played.capture).toBe(1);
    expect(ac.sources).toHaveLength(2);
    expect(ac.sources.every(source => !source.loop)).toBe(true);
    expect(ac.sources.every(source => source.stop.mock.calls[0][0] < .4)).toBe(true);
    for (const source of ac.sources) source.end();
    expect(f.sound.diagnostics.activeSources).toBe(0);
    f.sound.reset();
    expect(f.sound.capture()).toBe(false);
    expect(ac.sources).toHaveLength(2);
  });
  it('keeps exactly five ambient sources over thousands of rendered frames', () => {
    const f = fixture(), ac = f.start();
    expect(ac.sources).toHaveLength(5);
    expect(ac.sources.filter((source) => source.kind === 'buffer')).toHaveLength(1);
    expect(ac.sources.filter((source) => source.kind === 'oscillator')).toHaveLength(4);
    expect(ac.sources[0].loop).toBe(true);
    const nodeCount = ac.nodes.length;
    for (let i = 0; i < 3600; i++) {
      ac.currentTime += 1 / 60;
      f.sound.update({ ...f.frame, indoors: i % 2 === 0, power: i % 3 !== 0 });
    }
    expect(ac.sources).toHaveLength(5);
    expect(ac.nodes).toHaveLength(nodeCount);
    expect(f.sound.diagnostics).toMatchObject({ activeSources: 5, ambientSources: 5 });
    for (const source of ac.sources) {
      expect(source.start).toHaveBeenCalledExactlyOnceWith();
      expect(source.stop).not.toHaveBeenCalled();
    }
  });

  it('caps finite events at 24 concurrent sources without allocating rejected nodes', () => {
    const f = fixture(), ac = f.start(false);
    for (let i = 0; i < 24; i++) expect(f.sound.tone('sine', 100 + i, 0.1, 0.2)).toBe(true);
    const nodeCount = ac.nodes.length;
    for (let i = 0; i < 20; i++) {
      expect(f.sound.tone('sine', 200, 0.1, 0.2)).toBe(false);
      expect(f.sound.footstep()).toBe(false);
    }
    expect(f.sound.diagnostics.activeSources).toBe(24);
    expect(ac.sources).toHaveLength(24);
    expect(ac.nodes).toHaveLength(nodeCount);
    ac.sources[0].end();
    expect(f.sound.diagnostics.activeSources).toBe(23);
    expect(f.sound.tone('sine', 300, 0.1, 0.2)).toBe(true);
    expect(f.sound.diagnostics.activeSources).toBe(24);
  });

  it('counts the five ambient sources toward the same overall concurrency bound', () => {
    const f = fixture(), ac = f.start();
    for (let i = 0; i < 19; i++) expect(f.sound.tone('sine', 100, 0.1, 0.2)).toBe(true);
    expect(f.sound.tone('sine', 100, 0.1, 0.2)).toBe(false);
    expect(ac.sources).toHaveLength(24);
    expect(f.sound.diagnostics).toMatchObject({ activeSources: 24, ambientSources: 5 });
  });

  it('defers all five ambient sources until a pre-frame event burst leaves enough capacity', () => {
    const f = fixture(), ac = f.start(false);
    for (let i = 0; i < 24; i++) expect(f.sound.tone('sine', 100 + i, 0.1, 0.2)).toBe(true);
    const burstNodes = ac.nodes.length;
    f.sound.update(f.frame);
    expect(f.sound.diagnostics).toMatchObject({ activeSources: 24, ambientSources: 0 });
    expect(ac.sources).toHaveLength(24);
    expect(ac.nodes).toHaveLength(burstNodes);
    for (let i = 0; i < 4; i++) ac.sources[i].end();
    f.sound.update(f.frame);
    expect(f.sound.diagnostics).toMatchObject({ activeSources: 20, ambientSources: 0 });
    expect(ac.sources).toHaveLength(24);
    expect(ac.nodes).toHaveLength(burstNodes);
    ac.sources[4].end();
    f.sound.update(f.frame);
    expect(f.sound.diagnostics).toMatchObject({ activeSources: 24, ambientSources: 5 });
    expect(ac.sources).toHaveLength(29);
    expect(ac.sources.slice(24).map((source) => source.kind)).toEqual(['buffer', 'oscillator', 'oscillator', 'oscillator', 'oscillator']);
    f.sound.update(f.frame);
    expect(ac.sources).toHaveLength(29);
    expect(f.sound.diagnostics.activeSources).toBe(24);
  });

  it('schedules finite events and disconnects every event node onended without damaging the master graph', () => {
    const f = fixture(), ac = f.start(false);
    const graph = [...ac.nodes];
    expect(f.sound.tone('sine', 100, 0.1, 0.2)).toBe(true);
    const eventNodes = ac.nodes.slice(graph.length), source = ac.sources[0];
    expect(eventNodes).toHaveLength(5);
    expect(source.start).toHaveBeenCalledExactlyOnceWith(0);
    expect(source.stop).toHaveBeenCalledExactlyOnceWith(0.22);
    expect(f.sound.diagnostics.activeSources).toBe(1);
    source.end();
    expect(f.sound.diagnostics.activeSources).toBe(0);
    for (const node of eventNodes) expect(node.disconnect).toHaveBeenCalledTimes(1);
    for (const node of graph) expect(node.disconnect).not.toHaveBeenCalled();
    expect(f.sound.footstep()).toBe(true);
    const noise = ac.sources[1];
    expect(noise.start.mock.calls[0][2]).toBe(0.12);
    expect(noise.stop).toHaveBeenCalledExactlyOnceWith(0.15);
    noise.end();
    expect(f.sound.diagnostics.activeSources).toBe(0);
  });

  it('does not allocate a source or event graph outside the spatial hearing range', () => {
    const f = fixture(), ac = f.start(false);
    const nodes = ac.nodes.length;
    expect(f.sound.door({ x: 25, y: 1.6, z: 0 }, true)).toBe(false);
    expect(f.sound.footstep(false, true, { x: 100, y: 1.6, z: 0 })).toBe(false);
    expect(ac.nodes).toHaveLength(nodes);
    expect(ac.sources).toHaveLength(0);
    expect(f.sound.diagnostics.played).toEqual({});
  });

  it('supports the old Safari context and routes events without a StereoPanner', () => {
    const f = fixture();
    vi.stubGlobal('window', { ...f.win, AudioContext: undefined, webkitAudioContext: FakeAudioContext });
    const ac = f.start(false);
    Object.defineProperty(ac, 'createStereoPanner', { value: undefined });
    const graph = [...ac.nodes];
    expect(f.sound.tone('sine', 100, 0.1, 0.2)).toBe(true);
    expect(f.sound.door({ x: 3, y: 1.6, z: 0 }, true, true)).toBe(true);
    expect(ac.sources).toHaveLength(2);
    const eventNodes = ac.nodes.slice(graph.length);
    expect(eventNodes.some((node) => node.kind === 'panner')).toBe(false);
    const toneBusGain = ac.sources[0].connections[0].connections[0].connections[0];
    expect(toneBusGain.kind).toBe('gain');
    expect(graph).toContain(toneBusGain.connections[0]);
    // Spatial attenuation and low-pass filtering remain effective without stereo panning.
    const doorBus = ac.sources[1].connections[0].connections[0].connections[0];
    expect(doorBus.kind).toBe('filter');
    expect(doorBus.frequency.value).toBe(650);
    expect(doorBus.connections[0].gain.value).toBeCloseTo(0.18 * soundSpace(f.frame, { x: 3, y: 1.6, z: 0 }, true).gain);
    for (const source of ac.sources) source.end();
    expect(f.sound.diagnostics.activeSources).toBe(0);
    for (const node of eventNodes) expect(node.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('Sound visibility and disposal', () => {
  const deferred = () => {
    const f = fixture();
    vi.stubGlobal('window', { ...f.win, AudioContext: DeferredAudioContext });
    const ac = f.start(false) as DeferredAudioContext;
    return { ...f, ac };
  };

  it('suspends a pending resume before hidden audio can stay running', async () => {
    const f = deferred(), { ac } = f;
    expect(ac.state).toBe('suspended');
    expect(ac.resume).toHaveBeenCalledTimes(1);
    f.visibility(true);
    expect(ac.suspend).toHaveBeenCalledTimes(1);
    ac.finish('resume'); await Promise.resolve();
    ac.finish('suspend'); await Promise.resolve();
    expect(f.sound.diagnostics).toMatchObject({ state: 'suspended', unlocked: false, activeSources: 0 });
    f.visibility(false); f.sound.update(f.frame); f.sound.click();
    expect(ac.resume).toHaveBeenCalledTimes(1);
    expect(ac.sources).toHaveLength(0);
    f.sound.unlock();
    expect(ac.resume).toHaveBeenCalledTimes(2);
    ac.finish('resume'); await Promise.resolve();
    f.sound.update(f.frame);
    expect(f.sound.diagnostics).toMatchObject({ state: 'running', activeSources: 5 });
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it('resumes synchronously in a visible gesture even while suspension is pending', async () => {
    const f = deferred(), { ac } = f;
    ac.finish('resume'); await Promise.resolve();
    f.sound.update(f.frame);
    expect(f.sound.diagnostics.activeSources).toBe(5);
    f.visibility(true);
    expect(ac.state).toBe('running');
    expect(ac.suspend).toHaveBeenCalledTimes(1);
    f.visibility(false); f.sound.unlock();
    // This call must happen inside unlock, while the trusted activation still exists.
    expect(ac.resume).toHaveBeenCalledTimes(2);
    f.activation.isActive = false;
    ac.finish('suspend'); await Promise.resolve();
    f.sound.update(f.frame);
    expect(f.sound.diagnostics.activeSources).toBe(0);
    ac.finish('resume'); await Promise.resolve();
    f.sound.update(f.frame);
    expect(f.sound.diagnostics).toMatchObject({ state: 'running', unlocked: true, activeSources: 5 });
    expect(ac.resume).toHaveBeenCalledTimes(2);
    expect(ac.suspend).toHaveBeenCalledTimes(1);
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it('does not let an older suspension clear a newer pending resume', async () => {
    const f = deferred(), { ac } = f;
    ac.finish('resume'); await Promise.resolve();
    f.visibility(true); f.visibility(false); f.sound.unlock();
    expect(ac.resume).toHaveBeenCalledTimes(2);
    ac.finish('suspend'); await Promise.resolve();
    expect(ac.state).toBe('suspended');
    f.visibility(true);
    expect(ac.suspend).toHaveBeenCalledTimes(2);
    ac.finish('resume'); await Promise.resolve();
    ac.finish('suspend'); await Promise.resolve();
    expect(f.sound.diagnostics).toMatchObject({ state: 'suspended', unlocked: false, activeSources: 0 });
    expect(ac.pending).toHaveLength(0);
    expect(ac.resume).toHaveBeenCalledTimes(2);
  });

  it.each(['resume', 'suspend'] as const)('ignores a pending %s completion after disposal', async (kind) => {
    const f = deferred(), { ac } = f;
    if (kind === 'suspend') {
      ac.finish('resume'); await Promise.resolve();
      f.sound.update(f.frame); f.visibility(true);
    }
    const sources = ac.sources.length, nodes = [...ac.nodes];
    f.sound.dispose();
    ac.finish(kind); await Promise.resolve(); await Promise.resolve();
    f.visibility(false); f.sound.unlock(); f.sound.update(f.frame); f.sound.click();
    expect(ac.close).toHaveBeenCalledTimes(1);
    expect(ac.resume).toHaveBeenCalledTimes(1);
    expect(ac.suspend).toHaveBeenCalledTimes(kind === 'suspend' ? 1 : 0);
    expect(ac.pending).toHaveLength(0);
    expect(ac.sources).toHaveLength(sources);
    expect(f.sound.diagnostics).toMatchObject({ state: 'closed', activeSources: 0 });
    for (const node of nodes) expect(node.disconnect).toHaveBeenCalledTimes(1);
  });

  it('does not spin on a rejected asynchronous resume and retries only in another gesture', async () => {
    const f = deferred(), { ac } = f;
    ac.finish('resume', true); await Promise.resolve(); await Promise.resolve();
    f.sound.update(f.frame); f.sound.click();
    expect(ac.pending).toHaveLength(0);
    expect(ac.resume).toHaveBeenCalledTimes(1);
    expect(ac.sources).toHaveLength(0);
    f.sound.unlock();
    expect(ac.resume).toHaveBeenCalledTimes(2);
    ac.finish('resume'); await Promise.resolve();
    f.sound.update(f.frame);
    expect(f.sound.diagnostics.activeSources).toBe(5);
  });

  it('does not spin on a rejected asynchronous suspend or recover without a gesture', async () => {
    const f = deferred(), { ac } = f;
    ac.finish('resume'); await Promise.resolve();
    f.sound.update(f.frame); f.visibility(true);
    ac.finish('suspend', true); await Promise.resolve(); await Promise.resolve();
    f.visibility(false); f.sound.update(f.frame); f.sound.click();
    expect(ac.pending).toHaveLength(0);
    expect(ac.suspend).toHaveBeenCalledTimes(1);
    expect(ac.resume).toHaveBeenCalledTimes(1);
    expect(f.sound.diagnostics).toMatchObject({ unlocked: false, activeSources: 0 });
    f.visibility(true);
    expect(ac.suspend).toHaveBeenCalledTimes(2);
    ac.finish('suspend'); await Promise.resolve();
    f.visibility(false); f.sound.unlock();
    expect(ac.resume).toHaveBeenCalledTimes(2);
    ac.finish('resume'); await Promise.resolve();
    f.sound.update(f.frame);
    expect(f.sound.diagnostics.activeSources).toBe(5);
  });

  it.each([false, true])('restores a same-seed episode after its authoritative spawn, preserving roster updates (incarnation=%s)', (hasIncarnation) => {
    const f = fixture(), ac = f.start();
    f.sound.setPreferences(0.4, false);
    const g = Object.assign(Object.create(Game.prototype), {
      ...inactiveGameCollaborators(),
      level: generateLevel(0, 42), scene: new THREE.Scene(), sound: f.sound,
      body: { x: 1, y: 0, z: 2, vy: 0, grounded: true }, pos: { x: 1, z: 2 },
      campus: { world: {}, setLandmarks: vi.fn() }, input: { clear: vi.fn() }, moves: { clear: vi.fn() }, smooth: { reset: vi.fn() },
      steps: { reset: vi.fn() }, remoteSteps: new Map(), haptics: { cancel: vi.fn() },
      loopPlayers: new Map(), warpEpochs: new Map(), seen: new Set(), drawOn: false,
      corrC: 2, corrections: 0, spawnSynced: true, loadedIncarnation: 1,
      buildBlackout: vi.fn(), buildDoors: vi.fn(), buildBarriers: vi.fn(), loadPlan: vi.fn(), refreshObjective: vi.fn(),
      voice: { cancel: vi.fn() }, jasmine: { reset: vi.fn() },
      capture: { reset: vi.fn(), update: vi.fn() }, renderer: { domElement: { style: {} } },
    }) as Game;
    let incarnation = 1, forceReload = false;
    // main keeps a force-reload request during the fade, but a roster update
    // still carries the old incarnation and must preserve the audio handoff.
    const room = () => {
      const loaded = g.loadLevel(0, 42, forceReload, false, hasIncarnation ? incarnation : undefined);
      forceReload = false;
      return loaded;
    };
    const reset = vi.spyOn(f.sound, 'reset'), level = g.level;
    const initialSources = ac.sources.length;
    expect(room()).toBe(false); // An ordinary room roster refresh.
    expect(reset).not.toHaveBeenCalled();
    expect(ac.sources).toHaveLength(initialSources);

    g.onMsg({ t: 'fade', secs: 3, restart: true });
    forceReload = hasIncarnation;
    expect(ac.nodes[0].gain.value).toBe(0);
    expect(room()).toBe(false); // A player joins or leaves during the fade.
    expect(reset).not.toHaveBeenCalled();
    expect(g.level).toBe(level);
    expect((g as any).levelHandoff).toBe('fade');
    vi.spyOn(performance, 'now').mockReturnValue((g as any).fadeUntil + 1000);
    expect(room()).toBe(false); // Elapsed fade time still cannot identify a new episode.
    g.onMsg({ t: 'correct', p: [5, 0, 6], c: 1, forced: true }); // Stale spawn.
    g.onMsg({ t: 'correct', p: [5, 0, 6], c: 2, forced: true }); // Duplicate spawn.
    g.onMsg({ t: 'correct', p: [5, 0, 6], c: 3 }); // Prediction correction, not a level spawn.
    expect(room()).toBe(false);
    expect(reset).not.toHaveBeenCalled();
    expect(ac.nodes[0].gain.value).toBe(0);

    g.onMsg({ t: 'correct', p: [10, 0, 12], c: 4, forced: true });
    if (hasIncarnation) {
      expect(room()).toBe(false); // A stale roster cannot consume the new spawn.
      expect(reset).not.toHaveBeenCalled();
      incarnation++;
    }
    expect(room()).toBe(true); // The actual restart room follows the forced spawn.
    expect(reset).toHaveBeenCalledOnce();
    expect(g.level).not.toBe(level);
    expect(g.body).toMatchObject({ x: 10, y: 0, z: 12 });
    expect((g as any).corrC).toBe(4);
    expect((g as any).fadeUntil).toBe(0);
    expect(g.presentationReady).toBe(false);
    expect(f.sound.diagnostics).toMatchObject({ activeSources: 0, ambientSources: 0, volume: 0.4 });
    expect(ac.nodes[0].gain.value).toBe(0.4);
    f.sound.update(f.frame);
    expect(f.sound.diagnostics).toMatchObject({ activeSources: 5, ambientSources: 5 });
    const resumedSources = ac.sources.length;
    expect(room()).toBe(false);
    expect(reset).toHaveBeenCalledOnce();
    expect(ac.sources).toHaveLength(resumedSources);

    g.onMsg({ t: 'fade', secs: 3, restart: true });
    forceReload = hasIncarnation;
    g.onMsg({ t: 'correct', p: [10, 0, 12], c: 5, forced: true });
    incarnation++;
    expect(room()).toBe(true);
    f.sound.update(f.frame);
    expect(reset).toHaveBeenCalledTimes(2);
    expect(ac.nodes[0].gain.value).toBe(0.4);
    expect(f.sound.diagnostics).toMatchObject({ activeSources: 5, ambientSources: 5 });
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(ac.resume).toHaveBeenCalledTimes(1);
  });

  it('carries an existing room into a quiet handoff, rejects late effects, and resumes on the same context', () => {
    const f = fixture(), ac = f.start();
    const nodes = ac.nodes.length;
    f.sound.transition(3);
    expect(f.sound.diagnostics.activeSources).toBe(6); // Existing bed plus one finite exit breath.
    const count = ac.sources.length;
    f.sound.click(); f.sound.pickup(); f.sound.humStart(3);
    expect(ac.sources).toHaveLength(count);
    expect(ac.resume).toHaveBeenCalledTimes(1);
    f.sound.setPreferences(0.4, false);
    expect(ac.nodes[0].gain.value).toBe(0); // Changing settings cannot wake a fading chapter.
    f.sound.reset(); f.sound.update(f.frame);
    expect(f.sound.diagnostics).toMatchObject({ activeSources: 5, ambientSources: 5, volume: 0.4 });
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(ac.nodes.length).toBeGreaterThan(nodes);
    expect(ac.nodes[0].gain.value).toBe(0.4);
  });

  it('cleans hidden audio and waits for another gesture before resuming visible audio', () => {
    const f = fixture(), ac = f.start();
    f.sound.pickup();
    const sources = [...ac.sources];
    expect(f.sound.diagnostics.activeSources).toBe(6);
    f.visibility(true);
    expect(ac.suspend).toHaveBeenCalledTimes(1);
    expect(ac.state).toBe('suspended');
    expect(f.sound.diagnostics).toMatchObject({ unlocked: false, activeSources: 0, ambientSources: 0 });
    for (const source of sources) expect(source.stop).toHaveBeenLastCalledWith();
    f.sound.unlock();
    expect(ac.resume).toHaveBeenCalledTimes(1);
    f.visibility(false);
    for (let i = 0; i < 60; i++) { f.sound.update(f.frame); f.sound.click(); }
    expect(ac.sources).toHaveLength(sources.length);
    expect(ac.resume).toHaveBeenCalledTimes(1);
    ac.state = 'running'; // A platform restoring its context cannot bypass the gesture gate.
    f.sound.update(f.frame);
    expect(f.sound.tone('sine', 100, 0.1, 0.1)).toBe(false);
    expect(ac.sources).toHaveLength(sources.length);
    ac.state = 'suspended';
    f.activation.isActive = false;
    f.sound.unlock();
    expect(ac.resume).toHaveBeenCalledTimes(1);
    f.activation.isActive = true;
    f.sound.unlock();
    expect(ac.resume).toHaveBeenCalledTimes(2);
    f.sound.update(f.frame);
    expect(f.sound.diagnostics).toMatchObject({ activeSources: 5, ambientSources: 5 });
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it('also suspends on pagehide and reset never resumes the context', () => {
    const f = fixture(), ac = f.start();
    f.pagehide();
    expect(ac.suspend).toHaveBeenCalledTimes(1);
    expect(f.sound.diagnostics.activeSources).toBe(0);
    f.sound.reset(); f.sound.update(f.frame);
    expect(ac.resume).toHaveBeenCalledTimes(1);
    expect(ac.sources).toHaveLength(5);
  });

  it('resets idempotently, disconnects stopped sources, and can rebuild on the existing context', () => {
    const f = fixture(), ac = f.start(false);
    const graphNodeCount = ac.nodes.length;
    f.sound.update(f.frame);
    f.sound.humStart(2);
    const firstSources = [...ac.sources], firstNodes = ac.nodes.slice(graphNodeCount);
    f.sound.reset(); f.sound.reset();
    expect(f.sound.diagnostics).toMatchObject({ activeSources: 0, ambientSources: 0 });
    for (const source of firstSources) {
      expect(source.onended).toBeNull();
      expect(source.stop.mock.calls.filter((args) => args.length === 0)).toHaveLength(1);
    }
    for (const node of firstNodes) expect(node.disconnect).toHaveBeenCalledTimes(1);
    expect(ac.close).not.toHaveBeenCalled();
    f.sound.update(f.frame);
    expect(f.sound.diagnostics.activeSources).toBe(5);
    expect(ac.sources).toHaveLength(firstSources.length + 5);
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it('reset makes the old frame inactive so later messages cannot restart audio during a fade or completion', () => {
    const f = fixture(), ac = f.start();
    f.sound.reset();
    const count = ac.sources.length;
    f.sound.click(); f.sound.pickup(); f.sound.humStart(2);
    expect(f.sound.door({ x: 1, y: 1, z: 0 }, true)).toBe(false);
    expect(f.sound.footstep()).toBe(false);
    expect(ac.sources).toHaveLength(count);
    expect(f.sound.diagnostics).toMatchObject({ activeSources: 0, ambientSources: 0 });
    f.sound.update(f.frame);
    expect(f.sound.diagnostics).toMatchObject({ activeSources: 5, ambientSources: 5 });
  });

  it('releases a naturally ended omen only once, even if humStop follows it', () => {
    const f = fixture(), ac = f.start(false);
    const graphCount = ac.nodes.length;
    f.sound.humStart(0.5);
    const nodes = ac.nodes.slice(graphCount);
    ac.sources[0].end();
    f.sound.humStop(); f.sound.humStop();
    expect(f.sound.diagnostics.activeSources).toBe(0);
    for (const node of nodes) expect(node.disconnect).toHaveBeenCalledTimes(1);
  });

  it('disposes idempotently, closes once, removes listeners, and permanently prevents new sources', () => {
    const f = fixture(), ac = f.start();
    f.sound.pickup();
    const count = ac.sources.length, nodes = [...ac.nodes];
    f.sound.dispose(); f.sound.dispose(); f.sound.reset(); f.sound.pause();
    expect(ac.close).toHaveBeenCalledTimes(1);
    expect(ac.state).toBe('closed');
    for (const node of nodes) expect(node.disconnect).toHaveBeenCalledTimes(1);
    expect(f.documentListeners.get('visibilitychange')?.size).toBe(0);
    expect(f.windowListeners.get('pagehide')?.size).toBe(0);
    expect(f.doc.removeEventListener).toHaveBeenCalledExactlyOnceWith('visibilitychange', f.doc.addEventListener.mock.calls[0][1]);
    expect(f.win.removeEventListener).toHaveBeenCalledExactlyOnceWith('pagehide', f.win.addEventListener.mock.calls[0][1]);
    f.sound.unlock(); f.sound.update(f.frame); f.sound.click(); f.sound.humStart(1);
    expect(f.sound.footstep()).toBe(false);
    expect(ac.sources).toHaveLength(count);
    expect(f.sound.diagnostics.activeSources).toBe(0);
    expect(FakeAudioContext.instances).toHaveLength(1);
  });
});

describe('Sound material, wind and event envelopes', () => {
  it('uses the source footstep surface when a teammate and listener are on opposite sides of a doorway', () => {
    const f = fixture(), ac = f.start(false);
    expect(f.frame.indoors).toBe(false);
    expect(f.sound.footstep(false, false, { x: 1, y: 0.15, z: 0 }, false, true)).toBe(true);
    expect(ac.sources[0].connections[0].frequency.setValueAtTime).toHaveBeenCalledExactlyOnceWith(950, 0);
    expect(f.sound.footstep()).toBe(true);
    expect(ac.sources[1].connections[0].frequency.setValueAtTime).toHaveBeenCalledExactlyOnceWith(600, 0);
  });

  it('muffles indoor wind and adds bounded slow gusts without creating extra looping sources', () => {
    const f = fixture(), ac = f.start();
    const windFilter = ac.sources[0].connections[0], windGain = windFilter.connections[0];
    expect(windFilter.frequency.setTargetAtTime).toHaveBeenLastCalledWith(1100, 0, 0.6);
    const quiet = windGain.gain.value;
    ac.currentTime = 4;
    f.sound.update(f.frame);
    expect(windGain.gain.value).toBeGreaterThan(quiet);
    expect(windGain.gain.value).toBeLessThanOrEqual(0.035);
    f.sound.update({ ...f.frame, indoors: true }); // next mix remains time throttled
    ac.currentTime = 4.1; f.sound.update({ ...f.frame, indoors: true });
    expect(windFilter.frequency.setTargetAtTime).toHaveBeenLastCalledWith(380, 4.1, 0.6);
    expect(windGain.gain.value).toBeLessThan(0.009);
    expect(ac.sources).toHaveLength(5);
  });

  it('differentiates the door creak attack and close impact without adding overlapping sources', () => {
    const f = fixture(), ac = f.start(false), point = { x: 1, y: 1, z: 0 };
    f.sound.door(point, true); f.sound.door(point, false);
    expect(ac.sources).toHaveLength(2);
    const envelope = (i: number) => ac.sources[i].connections[0].connections[0];
    expect(envelope(0).gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(1, 0.025);
    expect(envelope(1).gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(1, 0.004);
  });

  it.each([NaN, Infinity, -10, 0.01, 1, 100])('bounds the finite omen and envelopes its start/end for duration %s', (seconds) => {
    const f = fixture(), ac = f.start(false);
    f.sound.humStart(seconds);
    const source = ac.sources[0], envelope = source.connections[0];
    const duration = Number.isFinite(seconds) ? Math.max(0.05, Math.min(30, seconds)) : 0.05;
    expect(envelope.kind).toBe('gain');
    expect(envelope.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(1, 0.035);
    expect(envelope.gain.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.0001, duration + 0.08);
    expect(source.stop).toHaveBeenCalledExactlyOnceWith(duration + 0.1);
  });
});

describe('Sound monster spatial integration', () => {
  const warden = (x = 2): SpatialMob => ({ id: 1, x, y: 0, z: -2, anim: 'patrol' });

  it('updates the real camera listener and gives monster footfalls HRTF inside the shared source budget', () => {
    const f = fixture(), ac = f.start();
    f.sound.update({ ...f.frame, x: 3, yaw: Math.PI / 2, pitch: Math.PI / 6, floorY: 0 });
    expect(ac.listener.positionX.value).toBe(3);
    expect(ac.listener.forwardX.value).toBeCloseTo(-Math.cos(Math.PI / 6));
    expect(ac.listener.forwardY.value).toBeCloseTo(0.5);
    expect(ac.listener.forwardZ.value).toBeCloseTo(0);
    const firstNode = ac.nodes.length;
    expect(f.sound.monsterFootstep(warden())).toBe(true);
    const panner = ac.nodes.slice(firstNode).find((n) => n.kind === 'hrtf')!;
    expect(panner.panningModel).toBe('HRTF');
    expect(panner.rolloffFactor).toBe(0); // spatialMix owns distance and floor attenuation exactly once.
    expect(panner.positionX.value).toBe(2);
    expect(panner.positionY.value).toBeCloseTo(0.12);
    for (let i = 0; i < 18; i++) expect(f.sound.monsterFootstep(warden())).toBe(true);
    const nodes = ac.nodes.length;
    expect(f.sound.monsterFootstep(warden())).toBe(false);
    expect(f.sound.diagnostics.activeSources).toBe(24);
    expect(ac.nodes).toHaveLength(nodes);
    ac.sources[5].end();
    expect(panner.disconnect).toHaveBeenCalledTimes(1);
    expect(f.sound.monsterFootstep(warden())).toBe(true);
  });

  it('drives a faster chase cadence from actual movement, with no stationary or teleport footfalls', () => {
    const count = (anim: string, speed: number) => {
      const f = fixture(), ac = f.start(), mob = { ...warden(), anim };
      const frame = { ...f.frame, floorY: 0, spatial: { mobs: [mob] } };
      f.sound.update(frame);
      expect(f.sound.diagnostics.played.monsterFootstep ?? 0).toBe(0);
      for (let i = 0; i < 180; i++) {
        ac.currentTime += 1 / 60; mob.x += speed / 60; f.sound.update(frame);
      }
      const steps = f.sound.diagnostics.played.monsterFootstep ?? 0;
      for (let i = 0; i < 60; i++) { ac.currentTime += 1 / 60; f.sound.update(frame); }
      mob.x = -10; ac.currentTime += 1 / 60; f.sound.update(frame);
      expect(f.sound.diagnostics.played.monsterFootstep ?? 0).toBe(steps);
      return steps;
    };
    const patrol = count('patrol', 1.6), chase = count('chase', 4.6);
    expect(patrol).toBeGreaterThan(0);
    expect(chase).toBeGreaterThan(patrol);
    expect(count('freeze', 4.6)).toBe(0);
  });

  it('does not accumulate movement across inactive, mute, removal or background gaps', () => {
    const f = fixture(), ac = f.start(), mob = { ...warden(), monitor: true, anim: 'run' };
    const frame = { ...f.frame, floorY: 0, spatial: { mobs: [mob] } };
    f.sound.update(frame);
    for (let i = 0; i < 10; i++) { ac.currentTime += 0.02; mob.x += 0.1; f.sound.update(frame); }
    expect(f.sound.diagnostics.played.monsterFootstep ?? 0).toBe(0);
    f.sound.update({ ...frame, active: false });
    mob.x += 0.6; ac.currentTime += 0.1; f.sound.update(frame);
    expect(f.sound.diagnostics.played.monsterFootstep ?? 0).toBe(0);
    f.sound.setPreferences(1, true); mob.x += 2; ac.currentTime += 0.5;
    f.sound.setPreferences(1, false); f.sound.update(frame);
    expect(f.sound.diagnostics.played.monsterFootstep ?? 0).toBe(0);
    ac.currentTime += 0.02; f.sound.update({ ...frame, spatial: { mobs: [] } });
    mob.x += 3; ac.currentTime += 0.02; f.sound.update(frame);
    expect(f.sound.diagnostics.played.monsterFootstep ?? 0).toBe(0);
    f.visibility(true); mob.x += 3; f.visibility(false); f.sound.unlock();
    ac.currentTime += 0.02; f.sound.update(frame);
    expect(f.sound.diagnostics.played.monsterFootstep ?? 0).toBe(0);
  });

  it('keeps legal monitor interpolation catch-up audible but silences a frozen monitor', () => {
    const f = fixture(), ac = f.start(), mob = { ...warden(), monitor: true, anim: 'run' };
    const frame = { ...f.frame, spatial: { mobs: [mob] } };
    f.sound.update(frame);
    // The rendered smoother can briefly move at 1.3 times the monitor's authoritative 7.8 m/s.
    for (let i = 0; i < 30; i++) { ac.currentTime += 1 / 60; mob.x += 7.8 * 1.3 / 60; f.sound.update(frame); }
    const steps = f.sound.diagnostics.played.monsterFootstep ?? 0;
    expect(steps).toBeGreaterThan(0);
    mob.anim = 'freeze';
    for (let i = 0; i < 30; i++) { ac.currentTime += 1 / 60; mob.x += 0.1; f.sound.update(frame); }
    expect(f.sound.diagnostics.played.monsterFootstep).toBe(steps);
  });

  it('advances every real playback slice at a fixed audio time and emits at most once per rendered frame', () => {
    const f = fixture(), ac = f.start(), mob = { ...warden(), x: -3, anim: 'chase' };
    const frame = { ...f.frame, dt: 0.1, frameId: 0, spatial: { mobs: [mob] } };
    f.sound.update(frame);
    for (let rendered = 1; rendered <= 5; rendered++) {
      const before = f.sound.diagnostics.played.monsterFootstep ?? 0;
      for (const [, rdt] of frameSlices(0.7)) {
        // Game advances all its slices synchronously; AudioContext.currentTime need not move between them.
        mob.x += 4.6 * rdt;
        f.sound.update({ ...frame, dt: rdt, frameId: rendered });
      }
      expect((f.sound.diagnostics.played.monsterFootstep ?? 0) - before).toBe(1);
    }
    expect(ac.currentTime).toBe(0);
    expect(f.sound.diagnostics.played.monsterFootstep).toBe(5);
    const before = f.sound.diagnostics.played.monsterFootstep;
    for (const [, rdt] of frameSlices(0.7)) f.sound.update({ ...frame, dt: rdt, frameId: 6 });
    expect(f.sound.diagnostics.played.monsterFootstep).toBe(before);
  });

  it('regenerates a corridor impulse only when explicit room dimensions change', () => {
    const f = fixture(), ac = f.start();
    const convolver = ac.nodes.find((n) => n.kind === 'convolver')!, initial = convolver.buffer;
    const frame = { ...f.frame, spatial: { mobs: [], room: { length: 40, width: 4, height: 3.6 } } };
    f.sound.update(frame);
    const larger = convolver.buffer;
    expect(larger).not.toBe(initial);
    f.sound.update(frame); f.sound.update({ ...frame, spatial: { ...frame.spatial, room: { ...frame.spatial.room } } });
    expect(convolver.buffer).toBe(larger);
    expect(ac.nodes.filter((n) => n.kind === 'convolver')).toHaveLength(1);
  });

  it.each(['mute', 'zero', 'inactive', 'pause', 'reset', 'transition'] as const)(
    'drops the convolution kernel on %s so a later frame starts with fresh room history', (action) => {
      const f = fixture(), ac = f.start();
      const convolver = ac.nodes.find((n) => n.kind === 'convolver')!, impulse = convolver.buffer;
      expect(impulse).not.toBeNull();
      f.sound.monsterFootstep(warden());
      if (action === 'mute') f.sound.setPreferences(0.65, true);
      if (action === 'zero') f.sound.setPreferences(0, false);
      if (action === 'inactive') f.sound.update({ ...f.frame, active: false });
      if (action === 'pause') f.sound.pause();
      if (action === 'reset') f.sound.reset();
      if (action === 'transition') f.sound.transition(1);
      expect(convolver.buffer).toBeNull();
      f.sound.setPreferences(0.65, false); f.sound.reset(); f.sound.unlock(); f.sound.update(f.frame);
      expect(convolver.buffer).toBe(impulse);
      expect(ac.nodes.filter((n) => n.kind === 'convolver')).toHaveLength(1);
    },
  );
});
