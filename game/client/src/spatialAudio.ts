// Procedural, finite corridor acoustics. Sources remain owned and bounded by Sound.
import type { CollisionWorld } from '../../shared/campus/collision.ts';
import { lineOfSight } from '../../shared/campus/nav.ts';

export interface SpatialPoint { x: number; y: number; z: number; floorY?: number }
export interface SpatialListener extends SpatialPoint { yaw: number; pitch?: number }
/** Monster coordinates are at its feet, as in the rendered/server mob table. */
export interface SpatialMob extends SpatialPoint { id: number; anim: string; monitor?: boolean }
export interface CorridorSize { length: number; width: number; height: number }
export interface SpatialEvent { input: AudioNode; nodes: AudioNode[]; release: () => void }
const bound = (n: number, lo: number, hi: number, fallback = lo) => Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
const valid = (p: SpatialPoint) => [p.x, p.y, p.z].every(Number.isFinite);
const corridorSize = (size: Partial<CorridorSize>): CorridorSize => ({
  length: bound(size.length ?? 24, 4, 60, 24), width: bound(size.width ?? 3.6, 2, 12, 3.6),
  height: bound(size.height ?? 3.3, 2, 8, 3.3),
});
const sizeKey = (size: CorridorSize) => `${size.length}/${size.width}/${size.height}`;

/** Distance, intervening storeys and solid walls each remove energy and high frequencies. */
export function spatialMix(listener: SpatialListener, source: SpatialPoint, occluded = false) {
  if (!valid(listener) || !valid(source)) return { distance: Infinity, gain: 0, cutoff: 650, floors: 0 };
  const distance = Math.hypot(source.x - listener.x, (source.y - listener.y) * 1.5, source.z - listener.z);
  // Explicit floor heights avoid treating a standing ear and a footfall on the same floor as separate storeys.
  const vertical = Number.isFinite(listener.floorY) && Number.isFinite(source.floorY)
    ? Math.abs(source.floorY! - listener.floorY!) : Math.max(0, Math.abs(source.y - listener.y) - 1.8);
  // Ordinary steps stay on the same acoustic floor; stair climbing changes the mix continuously.
  const floors = Math.min(4, Math.max(0, vertical - 0.6) / 3);
  const falloff = distance >= 25 ? 0 : (1 - distance / 25) ** 2 / (1 + distance * 0.18);
  return {
    distance, floors,
    gain: falloff * 0.32 ** floors * (occluded ? 0.3 : 1),
    cutoff: Math.max(250, Math.min(occluded ? 650 : 6500, 6500 / (1 + distance * 0.2)) * 0.44 ** floors),
  };
}

/** A deterministic stereo IR with geometric early echoes and a damped, bounded diffuse tail. */
export function corridorImpulse(ac: BaseAudioContext, size: Partial<CorridorSize> = {}): AudioBuffer {
  const { length, width, height } = corridorSize(size);
  const seconds = bound(0.25 + length * 0.018 + width * height * 0.008, 0.4, 1.8);
  const count = Math.ceil(ac.sampleRate * seconds), ir = ac.createBuffer(2, count, ac.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = ir.getChannelData(channel);
    let seed = (0x81f43a7 ^ (channel * 0x537d) ^ Math.round(length * 100 + width * 1000 + height * 10000)) >>> 0;
    let smooth = 0;
    for (let i = 0; i < count; i++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      smooth = smooth * 0.72 + ((seed >>> 0) / 0xffffffff * 2 - 1) * 0.28;
      const t = i / ac.sampleRate;
      // No direct impulse: localization stays in the dry HRTF path.
      data[i] = t < 0.012 ? 0 : smooth * Math.exp(-7 * t / seconds) * (0.014 * 1000 / ac.sampleRate);
    }
    const taps = [width * 2, height * 2, length, length * 2, length * 3];
    taps.forEach((metres, i) => {
      const at = Math.round((metres / 343 + channel * (i % 2 ? 0.0013 : 0.0007)) * ac.sampleRate);
      if (at < count) data[at] += (i % 2 ? -1 : 1) * 0.32 * Math.exp(-i * 0.6);
    });
    // With normalize=false this explicit L1 bound limits reverb gain at every sample rate and room size.
    let sum = 0;
    for (const sample of data) sum += Math.abs(sample);
    const scale = sum > 0 ? 0.75 / sum : 0;
    for (let i = 0; i < data.length; i++) data[i] *= scale;
  }
  return ir;
}

/** Every non-dialogue path enters this compressor and smooth, strictly bounded output stage. */
export function createAudioOutput(ac: BaseAudioContext, destination: AudioNode) {
  const input = ac.createGain(), compressor = ac.createDynamicsCompressor(), ceiling = ac.createWaveShaper();
  compressor.threshold.value = -12; compressor.knee.value = 12; compressor.ratio.value = 12;
  compressor.attack.value = 0.003; compressor.release.value = 0.18;
  const curve = new Float32Array(4097);
  for (let i = 0; i < curve.length; i++) {
    const x = i * 2 / (curve.length - 1) - 1, magnitude = Math.abs(x);
    // Unity gain below -6 dBFS; the soft knee reaches a zero slope before WaveShaper's endpoints.
    // Even input beyond +/-1 therefore joins the ceiling smoothly instead of chopping a waveform.
    curve[i] = Math.sign(x) * (magnitude <= 0.5 ? magnitude : 0.5 + Math.sin(Math.PI * (magnitude - 0.5)) / Math.PI);
  }
  ceiling.curve = curve;
  // No oversampling reconstruction can overshoot the bounded curve at the final output.
  ceiling.oversample = 'none';
  input.connect(compressor).connect(ceiling).connect(destination);
  return { input, nodes: [input, compressor, ceiling] as AudioNode[] };
}

interface EventState {
  point: SpatialPoint; level: number; occluded: boolean; gain: GainNode; filter: BiquadFilterNode;
}
interface Stride { point: SpatialPoint; phase: number; elapsed: number; lastFrame?: number }

export class SpatialAudio {
  private ac: BaseAudioContext;
  private effects: AudioNode;
  private impulse: AudioBuffer;
  private roomKey: string;
  private convolver: ConvolverNode;
  private wet: GainNode;
  private listener: SpatialListener = { x: 0, y: 1.6, z: 0, yaw: 0 };
  private collision?: CollisionWorld;
  private events = new Set<EventState>();
  private strides = new Map<number, Stride>();
  private disposed = false;
  private cleared = false;

  constructor(ac: BaseAudioContext, effects: AudioNode, master: AudioNode, size: Partial<CorridorSize> = {}) {
    this.ac = ac; this.effects = effects; this.impulse = corridorImpulse(ac, size); this.roomKey = sizeKey(corridorSize(size));
    this.convolver = ac.createConvolver(); this.convolver.normalize = false; this.convolver.buffer = this.impulse;
    this.wet = ac.createGain(); this.wet.gain.value = 0;
    effects.connect(this.convolver).connect(this.wet).connect(master);
  }

  update(listener: SpatialListener, indoors: boolean, collision?: CollisionWorld, room?: Partial<CorridorSize>) {
    if (this.disposed || !valid(listener)) return;
    this.listener = { ...listener }; this.collision = collision;
    if (room) {
      const size = corridorSize(room), key = sizeKey(size);
      if (key !== this.roomKey) {
        this.impulse = corridorImpulse(this.ac, size); this.roomKey = key;
        if (!this.cleared) this.convolver.buffer = this.impulse;
      }
    }
    const ear = this.ac.listener, t = this.ac.currentTime;
    const yaw = Number.isFinite(listener.yaw) ? listener.yaw : 0, pitch = bound(listener.pitch ?? 0, -Math.PI / 2, Math.PI / 2);
    const c = Math.cos(pitch), s = Math.sin(pitch), sy = Math.sin(yaw), cy = Math.cos(yaw);
    // three.js uses a -Z camera, Euler YXZ, and no roll.
    const forward = [-sy * c, s, -cy * c], up = [sy * s, c, cy * s];
    if (ear.positionX && ear.forwardX) {
      [ear.positionX, ear.positionY, ear.positionZ].forEach((p, i) => p.setValueAtTime([listener.x, listener.y, listener.z][i], t));
      [ear.forwardX, ear.forwardY, ear.forwardZ].forEach((p, i) => p.setValueAtTime(forward[i], t));
      [ear.upX, ear.upY, ear.upZ].forEach((p, i) => p.setValueAtTime(up[i], t));
    } else {
      ear.setPosition(listener.x, listener.y, listener.z);
      ear.setOrientation(forward[0], forward[1], forward[2], up[0], up[1], up[2]);
    }
    this.restore();
    this.wet.gain.setTargetAtTime(indoors ? 0.2 : 0.025, t, 0.15);
    for (const event of this.events) this.mix(event);
  }

  private restore() {
    if (this.cleared) { this.convolver.buffer = this.impulse; this.cleared = false; }
  }

  private mix(event: EventState) {
    const occluded = this.collision ? !lineOfSight(this.collision, this.listener, event.point) : event.occluded;
    const mix = spatialMix(this.listener, event.point, occluded), t = this.ac.currentTime;
    event.gain.gain.setTargetAtTime(event.level * mix.gain, t, 0.015);
    event.filter.frequency.setTargetAtTime(mix.cutoff, t, 0.025);
  }

  event(gain: number, point: SpatialPoint, occluded = false): SpatialEvent | undefined {
    if (this.disposed || !valid(point)) return;
    if (this.collision) occluded = !lineOfSight(this.collision, this.listener, point);
    const mix = spatialMix(this.listener, point, occluded); if (mix.gain <= 0) return;
    this.restore();
    const filter = this.ac.createBiquadFilter(), level = this.ac.createGain(), pan = this.ac.createPanner();
    filter.type = 'lowpass'; filter.frequency.value = mix.cutoff;
    const volume = bound(gain, 0, 0.5); level.gain.value = volume * mix.gain;
    pan.panningModel = 'HRTF'; pan.distanceModel = 'inverse'; pan.rolloffFactor = 0;
    pan.refDistance = 1; pan.maxDistance = 25;
    if (pan.positionX) {
      [pan.positionX, pan.positionY, pan.positionZ].forEach((p, i) => p.setValueAtTime([point.x, point.y, point.z][i], this.ac.currentTime));
    } else pan.setPosition(point.x, point.y, point.z);
    filter.connect(level).connect(pan).connect(this.effects);
    const state: EventState = { point: { ...point }, level: volume, occluded, gain: level, filter };
    this.events.add(state);
    return { input: filter, nodes: [filter, level, pan], release: () => { this.events.delete(state); } };
  }

  /** Actual interpolated movement drives gait; no source for idle/freeze, teleport or the first sample. */
  stepMobs(mobs: Iterable<SpatialMob>, dt: number, emit: (mob: SpatialMob, occluded: boolean) => void, frameId?: number) {
    if (this.disposed) return;
    const seen = new Set<number>();
    for (const mob of mobs) {
      seen.add(mob.id);
      const last = this.strides.get(mob.id), point = { x: mob.x, y: mob.y, z: mob.z };
      const distance = last ? Math.hypot(mob.x - last.point.x, mob.z - last.point.z) : 0;
      const moving = mob.monitor ? mob.anim === 'run' : ['patrol', 'investigate', 'chase'].includes(mob.anim);
      if (!last || !valid(mob) || !valid(last.point) || !(dt > 0 && dt <= 0.25) || distance > Math.min(1.8, dt * 12)
        || Math.abs(mob.y - last.point.y) > 0.6 || !moving) {
        this.strides.set(mob.id, { point, phase: 0, elapsed: 0, lastFrame: last?.lastFrame }); continue;
      }
      last.point = point; last.elapsed += dt;
      if (distance < 0.0001) { if (last.elapsed > 0.3) last.phase = 0; continue; }
      const chase = mob.anim === 'chase' || mob.anim === 'run';
      last.phase += distance / (chase ? 1.3 : 1.55);
      if (last.phase < 1 || last.elapsed < (chase ? 0.24 : 0.42)) continue;
      last.phase %= 1; last.elapsed = 0;
      if (frameId !== undefined && frameId === last.lastFrame) continue;
      last.lastFrame = frameId;
      const source = { ...point, y: point.y + 0.12, floorY: point.y };
      emit(mob, !!this.collision && !lineOfSight(this.collision, this.listener, source));
    }
    for (const id of this.strides.keys()) if (!seen.has(id)) this.strides.delete(id);
  }

  clear() {
    if (this.disposed) return;
    // Replacing the buffer with null destroys the convolution kernel and all of its history, even while suspended.
    if (!this.cleared) {
      this.convolver.buffer = null;
      this.wet.gain.cancelScheduledValues(this.ac.currentTime); this.wet.gain.value = 0;
      this.cleared = true;
    }
    this.strides.clear(); this.events.clear();
  }

  dispose() {
    if (this.disposed) return;
    this.clear(); this.disposed = true;
    this.convolver.disconnect(); this.wet.disconnect();
  }
}
