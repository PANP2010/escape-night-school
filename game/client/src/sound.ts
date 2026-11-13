// Non-dialogue audio. One gesture-unlocked context, one volume bus, bounded voices and no timers.
import { bobStep } from './bob.ts';
import type { DoorSpot } from '../../shared/doors.ts';
import type { GymSound } from '../../shared/gym.ts';
import type { CollisionWorld } from '../../shared/campus/collision.ts';
import { createAudioOutput, SpatialAudio, type CorridorSize, type SpatialMob } from './spatialAudio.ts';

export interface SoundPoint { x: number; y: number; z: number }
export interface SoundFrame extends SoundPoint {
  yaw: number; indoors: boolean; down: boolean; threat: number; active: boolean; power: boolean;
  pitch?: number; floorY?: number;
  /** Real playback time per simulation slice, plus its shared rendered-frame timestamp. */
  dt?: number; frameId?: number;
  spatial?: { mobs: Iterable<SpatialMob>; collision?: CollisionWorld; room?: Partial<CorridorSize> };
}
const clamp = (n: number, hi = 1) => Number.isFinite(n) ? Math.max(0, Math.min(hi, n)) : 0;

/** Camera yaw 0 looks toward -Z; +X is the right ear. Floors and walls also muffle the sound. */
export function soundSpace(listener: SoundPoint & { yaw: number }, source: SoundPoint, occluded = false) {
  const dx = source.x - listener.x, dz = source.z - listener.z;
  const distance = Math.hypot(dx, (source.y - listener.y) * 1.5, dz);
  const gain = distance >= 25 ? 0 : Math.pow(1 - distance / 25, 2) / (1 + distance * 0.18);
  // Keep same-storey ear-to-foot height clear; greater separation progressively removes floor-transmitted highs.
  const floorDepth = Math.max(0, Math.abs(source.y - listener.y) - 2);
  const floorCutoff = Math.max(450, 6500 / (1 + floorDepth * 4));
  // Height separation may travel through an opening; an actual blocked ray adds its own muffling.
  const cutoff = occluded ? Math.min(650, floorCutoff * 0.35) : Math.min(floorCutoff, Math.max(900, 6500 / (1 + distance * 0.2)));
  return {
    distance, gain: gain * (occluded ? 0.3 : 1),
    pan: clamp((dx * Math.cos(listener.yaw) - dz * Math.sin(listener.yaw)) / Math.max(1, Math.hypot(dx, dz)) + 1, 2) * 0.85 - 0.85,
    cutoff,
  };
}

/** The audible leaf face is outside its own collision slab; other walls still occlude it. */
export function doorSoundPoint(listener: SoundPoint, door: DoorSpot): SoundPoint {
  const { box } = door;
  let dx = listener.x - door.x, dz = listener.z - door.z;
  if (Math.hypot(dx, dz) < 0.001) { dx = door.alongX ? 0 : 1; dz = door.alongX ? 1 : 0; }
  const length = Math.hypot(dx, dz);
  const face = Math.min((box.x1 - box.x0) / (2 * Math.abs(dx)), (box.z1 - box.z0) / (2 * Math.abs(dz)));
  const scale = face + 0.03 / length;
  return {
    x: door.x + dx * scale,
    y: (door.y0 ?? 0) + 1,
    z: door.z + dz * scale,
  };
}

/** Shared with the visual head bob; actual distance only, never held movement keys or teleport jumps. */
export class FootstepClock {
  private phase = 0;
  private elapsed = 0;
  private lastFrame?: number;
  reset() { this.phase = 0; this.elapsed = 0; this.lastFrame = undefined; }
  step(distance: number, dt: number, crouch = false, grounded = true, frame?: number): boolean {
    if (!(dt > 0) || !Number.isFinite(dt) || !Number.isFinite(distance) || distance < 0 || distance / dt > 9 || !grounded) { this.reset(); return false; }
    this.elapsed += dt;
    if (distance < 0.0001) { if (this.elapsed > 0.3) this.phase = 0; return false; }
    this.phase += distance / (crouch ? 1.25 : bobStep(distance / dt));
    if (this.phase < 1 || this.elapsed < 0.18) return false;
    this.phase %= 1; this.elapsed = 0;
    if (frame !== undefined && frame === this.lastFrame) return false;
    this.lastFrame = frame;
    return true; // at most one footfall per rendered frame when a timestamp is supplied; never catch up with a burst
  }
}

export const heartbeatPeriod = (threat: number, down = false) => down ? 0.95 : 1.25 - 0.65 * clamp(threat);
type Source = OscillatorNode | AudioBufferSourceNode;
interface Voice { source: Source; nodes: AudioNode[]; release?: () => void }
interface Layer { gain: GainNode; filter?: BiquadFilterNode }

export class Sound {
  private context?: AudioContext;
  private master?: GainNode;
  private effects?: GainNode;
  private spatial?: SpatialAudio;
  private lastSpatialTime?: number;
  private graph: AudioNode[] = [];
  private noise?: AudioBuffer;
  private voices = new Set<Voice>();
  private beds?: { wind: Layer; hum: Layer; harmonic: Layer; near: Layer; beat: Layer };
  private omen?: Voice;
  private unlocked = false;
  private disposed = false;
  private pendingState?: 'running' | 'suspended';
  private stateRequest = 0;
  private transitioning = false;
  private volume = 0.65;
  private muted = false;
  private nextBeat = 0;
  private nextMix = 0;
  private frame: SoundFrame = { x: 0, y: 1.6, z: 0, yaw: 0, indoors: false, down: false, threat: 0, active: false, power: true };
  private played: Record<string, number> = {};
  private visibility = () => { if (document.hidden) this.pause(); };
  private hide = () => this.pause();

  constructor() {
    document.addEventListener('visibilitychange', this.visibility);
    window.addEventListener('pagehide', this.hide);
  }

  /** Call synchronously inside a trusted pointer/touch/key handler. Never called by a server event. */
  unlock() {
    if (this.disposed || document.hidden || (navigator.userActivation && !navigator.userActivation.isActive)) return;
    this.unlocked = true;
    if (this.muted || this.volume === 0) return;
    try {
      if (!this.context) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        const ac = this.context = new AC();
        const output = createAudioOutput(ac, ac.destination);
        this.master = output.input; this.master.gain.value = this.volume;
        this.graph = output.nodes;
        this.effects = ac.createGain(); this.effects.gain.value = 0.8; this.effects.connect(this.master);
        this.graph.push(this.effects);
        this.spatial = new SpatialAudio(ac, this.effects, this.master, this.frame.spatial?.room);
        this.spatial.update(this.frame, this.frame.indoors, this.frame.spatial?.collision, this.frame.spatial?.room);
      }
      if (this.context.state !== 'closed' && (this.context.state !== 'running' || this.pendingState === 'suspended')) this.requestState(this.context, 'running');
    } catch {
      // A partial/denied graph must not be used by a later animation frame.
      const ac = this.context;
      this.spatial?.dispose(); this.spatial = undefined;
      this.context = undefined; this.master = undefined; this.effects = undefined;
      this.stateRequest++; this.pendingState = undefined;
      for (const n of this.graph) n.disconnect(); this.graph = [];
      if (ac && ac.state !== 'closed') void ac.close().catch(() => {});
    }
  }

  /** State can lag queued control messages; resume must still be sent inside the gesture. */
  private requestState(ac: AudioContext, state: 'running' | 'suspended') {
    const request = ++this.stateRequest;
    this.pendingState = state;
    const settled = () => {
      if (this.disposed || this.context !== ac || request !== this.stateRequest) return;
      this.pendingState = undefined;
    };
    try { void (state === 'running' ? ac.resume() : ac.suspend()).then(settled, settled); }
    catch { settled(); } // Denial waits for the next explicit gesture/pause, never a recursive retry.
  }

  setPreferences(volume: number, muted: boolean) {
    this.volume = clamp(volume); this.muted = muted;
    if (this.master && this.context) this.master.gain.setTargetAtTime(muted || this.transitioning ? 0 : this.volume, this.context.currentTime, 0.025);
    if (muted || this.volume === 0) this.stopAll();
    // This setter never creates or resumes a context; suspended contexts need another trusted gesture.
  }

  private ready(): AudioContext | undefined {
    const ac = this.context;
    return !this.disposed && this.unlocked && !document.hidden && !this.muted && this.volume > 0 && this.frame.active && ac?.state === 'running' ? ac : undefined;
  }

  private track(source: Source, nodes: AudioNode[], release?: () => void): Voice {
    const voice = { source, nodes, release };
    source.onended = () => this.release(voice);
    this.voices.add(voice);
    return voice;
  }
  private release(v: Voice) {
    if (!this.voices.delete(v)) return;
    v.release?.();
    for (const n of v.nodes) n.disconnect();
    if (this.omen === v) this.omen = undefined;
  }
  private stop(v: Voice) { v.source.onended = null; try { v.source.stop(); } catch { /* already ended */ } this.release(v); }
  private stopAll() {
    for (const v of [...this.voices]) this.stop(v);
    this.spatial?.clear(); this.lastSpatialTime = undefined;
    this.beds = undefined; this.omen = undefined; this.nextBeat = 0; this.nextMix = 0;
  }
  pause() {
    this.unlocked = false; this.stopAll();
    const ac = this.context;
    if (!this.disposed && ac && ac.state !== 'closed' && (ac.state === 'running' || this.pendingState === 'running')) this.requestState(ac, 'suspended');
  }
  /** Fade the current room within the server's existing handoff; no new timers or input locks. */
  transition(seconds: number, restart = false) {
    const ac = this.ready();
    if (ac) {
      // A soft descending breath, below the dialogue register; it never unlocks a context.
      if (!restart) this.tone('sine', 126, 0.035, Math.min(0.8, Math.max(0.05, seconds * 0.4)), 84);
      this.master!.gain.setTargetAtTime(0, ac.currentTime, Math.min(0.18, Math.max(0.01, seconds / 5)));
    }
    this.humStop(); this.spatial?.clear(); this.lastSpatialTime = undefined; this.transitioning = true;
    this.frame = { ...this.frame, active: false };
  }
  reset() {
    this.frame = { ...this.frame, active: false }; this.stopAll(); this.transitioning = false;
    if (this.master && this.context) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.context.currentTime, 0.12);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.stateRequest++; this.pendingState = undefined; this.stopAll();
    document.removeEventListener('visibilitychange', this.visibility); window.removeEventListener('pagehide', this.hide);
    this.spatial?.dispose(); this.spatial = undefined;
    for (const n of this.graph) n.disconnect();
    if (this.context && this.context.state !== 'closed') void this.context.close().catch(() => {});
  }

  private buffer(ac: AudioContext) {
    if (!this.noise) {
      this.noise = ac.createBuffer(2, ac.sampleRate * 2, ac.sampleRate);
      for (let channel = 0; channel < 2; channel++) {
        const a = this.noise.getChannelData(channel);
        for (let i = 0; i < a.length; i++) a[i] = Math.random() * 2 - 1;
      }
    }
    return this.noise;
  }

  private bed(ac: AudioContext, hz: number): Layer {
    const gain = ac.createGain(); gain.gain.value = 0; gain.connect(this.master!);
    let filter: BiquadFilterNode | undefined;
    if (hz) {
      const o = ac.createOscillator(); o.frequency.value = hz; o.connect(gain);
      this.track(o, [o, gain]); o.start();
    } else {
      const source = ac.createBufferSource(); filter = ac.createBiquadFilter();
      source.buffer = this.buffer(ac); source.loop = true;
      filter.type = 'lowpass'; filter.frequency.value = 700;
      source.connect(filter).connect(gain); this.track(source, [source, filter, gain]); source.start();
    }
    return { gain, filter };
  }

  update(frame: SoundFrame) {
    this.frame = frame;
    if (!frame.active) { this.stopAll(); return; }
    const ac = this.ready(); if (!ac) return;
    this.spatial?.update(frame, frame.indoors, frame.spatial?.collision, frame.spatial?.room);
    const spatialDt = frame.dt ?? (this.lastSpatialTime === undefined ? 0 : ac.currentTime - this.lastSpatialTime);
    this.lastSpatialTime = ac.currentTime;
    this.spatial?.stepMobs(frame.spatial?.mobs ?? [], spatialDt, (mob, occluded) => this.monsterFootstep(mob, occluded), frame.frameId);
    if (!this.beds) {
      if (this.voices.size > 19) return; // A burst before the first frame must also respect the 24-source limit.
      this.beds = { wind: this.bed(ac, 0), hum: this.bed(ac, 100), harmonic: this.bed(ac, 200), near: this.bed(ac, 52), beat: this.bed(ac, 55) };
    }
    const t = ac.currentTime, threat = clamp(frame.threat);
    if (t >= this.nextMix) {
      const duck = frame.down ? 0.45 : 1 - threat * 0.4;
      const target = (l: Layer, v: number) => l.gain.gain.setTargetAtTime(v * duck, t, 0.35);
      // Slow, bounded gusts keep the bed alive without adding sources or scheduling repeating timers.
      const gust = 0.86 + Math.sin(t * 0.31) * 0.09 + Math.sin(t * 0.13) * 0.05;
      target(this.beds.wind, (frame.indoors ? 0.009 : 0.035) * gust);
      this.beds.wind.filter!.frequency.setTargetAtTime(frame.indoors ? 380 : 1100, t, 0.6);
      target(this.beds.hum, frame.indoors && frame.power ? 0.015 : 0.002);
      target(this.beds.harmonic, frame.indoors && frame.power ? 0.003 : 0);
      target(this.beds.near, threat * 0.025); target(this.beds.beat, threat * 0.018);
      this.nextMix = t + 0.05;
    }
    if (frame.down || threat > 0.22) {
      if (t >= this.nextBeat) { this.heartbeat(frame.down ? 0.19 : 0.06 + threat * 0.1); this.nextBeat = t + heartbeatPeriod(threat, frame.down); }
    } else this.nextBeat = t + 0.3;
  }

  /** Destination for one finite event. Pan is optional on old Safari; attenuation/filtering still work. */
  private event(ac: AudioContext, gain: number, point?: SoundPoint, occluded = false, spatial = false): { input: AudioNode; nodes: AudioNode[]; release?: () => void } | undefined {
    if (this.voices.size >= 24) return;
    if (spatial && point) return this.spatial?.event(gain, point, occluded);
    const space = point ? soundSpace(this.frame, point, occluded) : { gain: 1, pan: 0, cutoff: 6500 };
    if (space.gain <= 0) return;
    const g = ac.createGain(), filter = ac.createBiquadFilter();
    g.gain.value = gain * space.gain; filter.type = 'lowpass'; filter.frequency.value = space.cutoff;
    const nodes: AudioNode[] = [filter, g]; filter.connect(g);
    if (typeof ac.createStereoPanner === 'function') {
      const pan = ac.createStereoPanner(); pan.pan.value = space.pan; g.connect(pan).connect(this.effects!); nodes.push(pan);
    } else g.connect(this.effects!);
    return { input: filter, nodes };
  }

  tone(type: OscillatorType, hz: number, gain: number, duration: number, to?: number, delay = 0) {
    const ac = this.ready(); if (!ac) return false;
    const bus = this.event(ac, Math.min(0.3, gain)); if (!bus) return false;
    const o = ac.createOscillator(), envelope = ac.createGain(), t = ac.currentTime + delay;
    o.type = type; o.frequency.setValueAtTime(hz, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + duration);
    envelope.gain.setValueAtTime(0.0001, t); envelope.gain.exponentialRampToValueAtTime(1, t + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    o.connect(envelope).connect(bus.input); this.track(o, [o, envelope, ...bus.nodes], bus.release);
    o.start(t); o.stop(t + duration + 0.02); return true;
  }

  private noiseEvent(kind: string, duration: number, gain: number, hz: number, point?: SoundPoint, occluded = false, to?: number, attack = 0.012, spatial = false) {
    const ac = this.ready(); if (!ac) return false;
    const bus = this.event(ac, gain, point, occluded, spatial); if (!bus) return false;
    const source = ac.createBufferSource(), filter = ac.createBiquadFilter(), envelope = ac.createGain(), t = ac.currentTime;
    source.buffer = this.buffer(ac); source.playbackRate.value = 0.95 + Math.random() * 0.1;
    filter.type = to ? 'bandpass' : 'lowpass'; filter.Q.value = to ? 5 : 0.7;
    filter.frequency.setValueAtTime(hz, t); if (to) filter.frequency.linearRampToValueAtTime(to, t + duration);
    envelope.gain.setValueAtTime(0.0001, t); envelope.gain.exponentialRampToValueAtTime(1, t + attack);
    envelope.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    source.connect(filter).connect(envelope).connect(bus.input);
    this.track(source, [source, filter, envelope, ...bus.nodes], bus.release); source.start(t, Math.random(), duration); source.stop(t + duration + 0.03);
    this.played[kind] = (this.played[kind] ?? 0) + 1; return true;
  }
  door(point: SoundPoint, open: boolean, occluded = false) {
    return this.noiseEvent('door', open ? 0.55 : 0.22, open ? 0.18 : 0.5, open ? 230 : 210, point, occluded, open ? 510 : undefined, open ? 0.025 : 0.004);
  }
  footstep(crouch = false, run = false, point?: SoundPoint, occluded = false, indoors = this.frame.indoors) {
    // A teammate's surface belongs to the source, even when the listener is across a doorway.
    return this.noiseEvent('footstep', run ? 0.16 : 0.12, crouch ? 0.045 : run ? 0.24 : 0.13, indoors ? 950 : 600, point, occluded, undefined, crouch ? 0.012 : 0.004);
  }
  monsterFootstep(mob: SpatialMob, occluded = false) {
    const chase = mob.anim === 'chase' || mob.anim === 'run';
    const point = { x: mob.x, y: mob.y + 0.12, z: mob.z, floorY: mob.y };
    return this.noiseEvent('monsterFootstep', chase ? 0.2 : 0.17, chase ? 0.36 : 0.24,
      mob.monitor ? 750 : 520, point, occluded, undefined, chase ? 0.004 : 0.008, true);
  }
  click() { if (this.tone('triangle', 720, 0.085, 0.055, 340)) this.played.click = (this.played.click ?? 0) + 1; }
  /** One server-confirmed contact accent, through the same unlocked, muted and volume-limited effects bus. */
  capture() {
    if (!this.noiseEvent('capture', .32, .18, 820, undefined, false, 260, .006)) return false;
    this.tone('sine', 180, .1, .3, 46);
    return true;
  }
  /** Server-confirmed basketball and scoreboard feedback uses the existing gesture-unlocked, limited volume bus. */
  gym(kind: GymSound['kind'], point: SoundPoint, occluded = false) {
    if (kind === 'open') {
      if (!this.tone('sine', 660, 0.1, 0.24, 990)) return false;
      this.tone('sine', 880, 0.07, 0.22, 1100, 0.12);
      this.played['gym-open'] = (this.played['gym-open'] ?? 0) + 1;
      return true;
    }
    const trip = kind === 'trip', press = kind === 'switch';
    return this.noiseEvent(`gym-${kind}`, trip ? 0.28 : press ? 0.08 : 0.17, trip ? 0.28 : press ? 0.16 : 0.3,
      trip ? 380 : press ? 720 : kind === 'bounce' ? 220 : 140, point, occluded, undefined, trip ? 0.005 : 0.008);
  }
  pickup() { if (this.tone('sine', 620, 0.08, 0.14, 940)) this.played.pickup = (this.played.pickup ?? 0) + 1; }
  private heartbeat(gain: number) {
    if (this.tone('sine', 58, gain, 0.16, 44)) { this.tone('sine', 51, gain * 0.65, 0.15, 38, 0.16); this.played.heartbeat = (this.played.heartbeat ?? 0) + 1; }
  }
  humStart(seconds: number) {
    this.humStop(); const ac = this.ready(); if (!ac) return;
    const bus = this.event(ac, 0.045); if (!bus) return;
    const o = ac.createOscillator(), envelope = ac.createGain(), t = ac.currentTime;
    const duration = Number.isFinite(seconds) ? Math.max(0.05, Math.min(30, seconds)) : 0.05;
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(100, t); o.frequency.exponentialRampToValueAtTime(190, t + duration);
    envelope.gain.setValueAtTime(0.0001, t); envelope.gain.exponentialRampToValueAtTime(1, t + 0.035);
    envelope.gain.setValueAtTime(1, t + duration); envelope.gain.exponentialRampToValueAtTime(0.0001, t + duration + 0.08);
    o.connect(envelope).connect(bus.input); this.omen = this.track(o, [o, envelope, ...bus.nodes], bus.release); o.start(); o.stop(t + duration + 0.1);
  }
  humStop() { if (this.omen) this.stop(this.omen); this.omen = undefined; }
  get diagnostics() {
    return { unlocked: this.unlocked, state: this.context?.state ?? 'locked', activeSources: this.voices.size, ambientSources: this.beds ? 5 : 0, volume: this.volume, muted: this.muted, played: { ...this.played } };
  }
}
