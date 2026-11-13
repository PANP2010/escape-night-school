import * as THREE from 'three';
import type { Store } from '../core/state.ts';
import { MINUTES_PER_DAY, parseClock } from '../core/state.ts';
import { hexToSrgb, srgbToLinear, type Vec3 } from '../render/palette.ts';
import todData from '../data/time_of_day.json';
import { applyWeather, groundWeather, weatherGround, type WeatherKind } from './weather.ts';

/**
 * Time of day → sky, fog, sun/moon and street lamps (docs/05_art_audio.md 时段光照). data/time_of_day.json holds
 * keyframes (HH:MM, sRGB hex); sampleTimeOfDay() interpolates them in linear light, wrapping past midnight.
 * `sun` is whichever body lights the scene: when two neighbouring keys disagree on `body` (sunset → moon), the
 * light and the disc dip to zero at the midpoint and the direction switches there, so nothing slides across the sky.
 */
export interface TodKeyDef {
  t: string; zenith: string; horizon: string; fog: [number, number];
  sun: { az: number; el: number; color: string; intensity: number; body?: 'sun' | 'moon' };
  glow: number; disc: number;
  hemi: { sky: string; ground: string; intensity: number };
  lamps: number;
  /** share of rooms with the lights on (window glow, render/facade.ts), 0..1; default 0 */
  windows?: number;
}
export interface TodData { keys: TodKeyDef[] }
export const TOD = todData as unknown as TodData;

/** One interpolated moment, colours in linear sRGB. `sunDir` points from the ground toward the body. */
export interface TodSample {
  zenith: Vec3; horizon: Vec3; fogNear: number; fogFar: number;
  sunDir: Vec3; sunColor: Vec3; sunIntensity: number; body: 'sun' | 'moon';
  glow: number; disc: number;
  hemiSky: Vec3; hemiGround: Vec3; hemiIntensity: number;
  lamps: number;
  /** share of lit windows 0..1 */
  windows: number;
  /** star visibility 0..1 (comes out as the zenith darkens; weather can hide it) */
  stars: number;
}

interface Key { m: number; def: TodKeyDef; body: 'sun' | 'moon'; lin: Record<'zenith' | 'horizon' | 'sun' | 'sky' | 'ground', Vec3>; dir: Vec3 }

const lin = (hex: string) => hexToSrgb(hex).map(srgbToLinear) as Vec3;
const mix = (a: number, b: number, k: number) => a + (b - a) * k;
const mix3 = (a: Vec3, b: Vec3, k: number): Vec3 => [mix(a[0], b[0], k), mix(a[1], b[1], k), mix(a[2], b[2], k)];
const RAD = Math.PI / 180;
const luma = (c: Vec3) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Azimuth (0 = north/+z, 90 = east/+x) + elevation, degrees → unit vector (+y up). */
export function sunDirection(az: number, el: number): Vec3 {
  const c = Math.cos(el * RAD);
  return [Math.sin(az * RAD) * c, Math.sin(el * RAD), Math.cos(az * RAD) * c];
}

/** Problems with the keyframe table; empty = valid. */
export function validateTod(d: TodData): string[] {
  const errs: string[] = [];
  if (!Array.isArray(d.keys) || d.keys.length < 2) return ['need ≥ 2 keys'];
  let prev = -1;
  for (const k of d.keys) {
    let m: number;
    try { m = parseClock(k.t); } catch { errs.push(`bad t: ${k.t}`); continue; }
    if (m <= prev) errs.push(`keys not ascending at ${k.t}`);
    prev = m;
    for (const c of [k.zenith, k.horizon, k.sun.color, k.hemi.sky, k.hemi.ground]) {
      if (!/^#[0-9a-f]{6}$/i.test(c)) errs.push(`${k.t}: bad colour ${c}`);
    }
    if (!(k.fog[0] >= 0 && k.fog[1] > k.fog[0])) errs.push(`${k.t}: bad fog ${k.fog}`);
    if (k.lamps < 0 || k.lamps > 1) errs.push(`${k.t}: lamps must be 0..1`);
    if (k.windows !== undefined && !(k.windows >= 0 && k.windows <= 1)) errs.push(`${k.t}: windows must be 0..1`);
  }
  return errs;
}

const cache = new WeakMap<TodData, Key[]>();
function keys(d: TodData): Key[] {
  let ks = cache.get(d);
  if (!ks) {
    ks = d.keys.map(def => {
      const body = def.sun.body ?? 'sun';
      return {
        m: parseClock(def.t), def, body,
        lin: { zenith: lin(def.zenith), horizon: lin(def.horizon), sun: lin(def.sun.color), sky: lin(def.hemi.sky), ground: lin(def.hemi.ground) },
        dir: sunDirection(def.sun.az, def.sun.el),
      };
    });
    cache.set(d, ks);
  }
  return ks;
}

/** Pure: the look at `minute` (any real number; wraps around the day). */
export function sampleTimeOfDay(minute: number, d: TodData = TOD): TodSample {
  const ks = keys(d);
  const t = ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  let i = ks.length - 1;
  for (let j = 0; j < ks.length; j++) if (ks[j].m <= t) i = j;
  const a = ks[i], b = ks[(i + 1) % ks.length];
  const span = ((b.m - a.m) + MINUTES_PER_DAY) % MINUTES_PER_DAY || MINUTES_PER_DAY;
  const since = ((t - a.m) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const k = since / span;
  const A = a.def, B = b.def;
  let sunDir: Vec3, body = a.body, sunI: number, disc: number;
  if (a.body === b.body) {
    const v = mix3(a.dir, b.dir, k), n = Math.hypot(...v) || 1;
    sunDir = [v[0] / n, v[1] / n, v[2] / n];
    sunI = mix(A.sun.intensity, B.sun.intensity, k);
    disc = mix(A.disc, B.disc, k);
  } else {
    // hand-over: fade out the first body, switch at the midpoint, fade in the next
    const late = k >= 0.5, w = late ? 2 * k - 1 : 1 - 2 * k;
    sunDir = late ? b.dir : a.dir;
    body = late ? b.body : a.body;
    sunI = (late ? B.sun.intensity : A.sun.intensity) * w;
    disc = (late ? B.disc : A.disc) * w;
  }
  const out: TodSample = {
    zenith: mix3(a.lin.zenith, b.lin.zenith, k), horizon: mix3(a.lin.horizon, b.lin.horizon, k),
    fogNear: mix(A.fog[0], B.fog[0], k), fogFar: mix(A.fog[1], B.fog[1], k),
    sunDir, sunColor: mix3(a.lin.sun, b.lin.sun, k), sunIntensity: sunI, body,
    glow: mix(A.glow, B.glow, k), disc,
    hemiSky: mix3(a.lin.sky, b.lin.sky, k), hemiGround: mix3(a.lin.ground, b.lin.ground, k),
    hemiIntensity: mix(A.hemi.intensity, B.hemi.intensity, k),
    lamps: mix(A.lamps, B.lamps, k),
    windows: mix(A.windows ?? 0, B.windows ?? 0, k),
    stars: 0,
  };
  out.stars = smooth(0.05, 0.02, luma(out.zenith));
  return out;
}

/** What TimeOfDay drives; all optional pieces are skipped when absent (unit tests pass plain objects). */
export interface TodTargets {
  scene: THREE.Scene;
  hemi: THREE.HemisphereLight;
  sun: THREE.DirectionalLight;
  sky?: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  /** Street lamps (world/lamps.ts): 0 = off, 1 = full. */
  lamps?: { set(on: number): void };
  /** Ground material: its colour is tinted by the weather (wet / snowed-over); base colour captured at construction. */
  ground?: { color: THREE.Color };
  /** Vertex-coloured ground layers (world/paving.ts): their material colour is set to the ground's weather tint ratio. */
  tinted?: { color: THREE.Color }[];
  /** Weather layered on top (systems/weather.ts); read every update. */
  weather?: { kind: WeatherKind; amount: number; wet?: number };
}


/**
 * Keeps the scene lit for the current game minute. main.ts calls update() every frame with the clock's
 * fractional minute, so light moves continuously instead of stepping once a game minute; a debug jump
 * (`?t=`, panel) is simply a different minute on the next frame. `override` pins the look to a fixed minute.
 */
export class TimeOfDay {
  /** Last applied minute (fractional); NaN = never. */
  minute = NaN;
  /** Pin the look to this minute regardless of the game clock (debug/screenshots); null = follow the clock. */
  override: number | null = null;
  /** The applied look: time of day with the weather on top. */
  sample: TodSample;
  private weatherKey = '';
  private groundBase: Vec3 | null = null;

  readonly targets: TodTargets;
  readonly data: TodData;

  constructor(targets: TodTargets, data: TodData = TOD) {
    this.targets = targets; this.data = data;
    this.sample = sampleTimeOfDay(0, data);
    const g = targets.ground?.color;
    if (g) this.groundBase = [g.r, g.g, g.b];
  }

  /** Apply the look at `minute` (skipped if neither the minute nor the weather moved). */
  update(minute: number): void {
    const m = this.override ?? minute;
    const w = this.targets.weather, wk = w ? `${w.kind}@${w.amount}/${w.wet ?? ''}` : '';
    if (m === this.minute && wk === this.weatherKey) return;
    this.minute = m;
    this.weatherKey = wk;
    const s = sampleTimeOfDay(m, this.data);
    this.apply(this.sample = w ? applyWeather(s, w.kind, w.amount) : s);
    if (w && this.groundBase) {
      const b = this.groundBase, g = weatherGround(b, ...groundWeather(w));
      this.targets.ground!.color.setRGB(...g);
      for (const t of this.targets.tinted ?? []) t.color.setRGB(g[0] / b[0], g[1] / b[1], g[2] / b[2]);
    }
  }

  /** Follow the store's clock (+ the clock's pending fraction of a minute). */
  follow(store: Store, fraction = 0): void { this.update(store.state.time.minute + fraction); }

  private apply(s: TodSample): void {
    const { scene, hemi, sun, sky, lamps } = this.targets;
    // three's Color.setRGB takes working-space (linear) values: the sample is already linear
    if (scene.background instanceof THREE.Color) scene.background.setRGB(...s.horizon);
    if (scene.fog instanceof THREE.Fog) {
      scene.fog.color.setRGB(...s.horizon);
      scene.fog.near = s.fogNear; scene.fog.far = s.fogFar;
    } else if (scene.fog instanceof THREE.FogExp2) scene.fog.color.setRGB(...s.horizon);
    hemi.color.setRGB(...s.hemiSky);
    hemi.groundColor.setRGB(...s.hemiGround);
    hemi.intensity = s.hemiIntensity;
    // a body below the horizon lights nothing (and would light the ground from beneath)
    const above = smooth(0, 0.06, s.sunDir[1]);
    sun.color.setRGB(...s.sunColor);
    sun.intensity = s.sunIntensity * above;
    sun.position.set(s.sunDir[0] * 150, s.sunDir[1] * 150, s.sunDir[2] * 150);
    if (sky) {
      const u = sky.material.uniforms;
      u.zenith.value.setRGB(...s.zenith);
      u.horizon.value.setRGB(...s.horizon);
      u.sunDir.value.set(...s.sunDir);
      u.sunColor.value.setRGB(...s.sunColor);
      // disc radius: the moon is drawn a little smaller than the sun; stars come out as the zenith darkens
      u.look.value.set(s.glow, s.disc, Math.cos(s.body === 'moon' ? 0.028 : 0.04), s.stars);
    }
    lamps?.set(s.lamps);
  }
}
