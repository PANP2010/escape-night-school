import type { Store } from '../core/state.ts';
import type { TodSample } from './timeofday.ts';
import { hexToSrgb, srgbToLinear, type Vec3 } from '../render/palette.ts';
import weatherData from '../data/weather.json';

/**
 * Weather (docs/05_art_audio.md 天气): the story sets the string flag `weather` (clear | rain | snow; anything else =
 * clear), debug `?weather=` does the same. It is a layer on top of the time of day, never a change to
 * data/time_of_day.json: applyWeather() dims the sun, greys and darkens the sky, pulls the fog in and hides the
 * stars, by `amount` 0..1. Changing kind fades the old one out before the new one fades in (rain never turns into
 * snow mid-air); loading a save cuts. Precipitation itself is drawn elsewhere: rain = strokes in the post pass,
 * snow = world/snow.ts particles, both fed from `rain` / `snow` here.
 */
export type WeatherKind = 'clear' | 'rain' | 'snow';
export const WEATHER_KINDS: WeatherKind[] = ['clear', 'rain', 'snow'];
export const WEATHER_FLAG = 'weather';

export interface WeatherDef {
  /** multipliers at full strength */
  sun: number; glow: number; disc: number; hemi: number; fog: number;
  /** sky: share turned to grey (0..1), then brightness multiplier */
  grey: number; sky: number;
  /** ground tint (sRGB hex) and how far the ground colour moves toward it */
  ground: string; groundMix: number;
  stars: number;
}
/** Seconds of full rain / snow to soak / cover the ground (…In), and to dry / melt it off again (…Out). */
export interface CoverDef { wetIn: number; wetOut: number; snowIn: number; snowOut: number; /** lying snow (sRGB hex) */ snow: string }
export interface WeatherData { fadeSeconds: number; cover: CoverDef; kinds: Record<'rain' | 'snow', WeatherDef> }
export const WEATHER = weatherData as WeatherData;

export function weatherKind(v: unknown): WeatherKind {
  return v === 'rain' || v === 'snow' ? v : 'clear';
}

const mix = (a: number, b: number, k: number) => a + (b - a) * k;
const luma = (c: Vec3) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
/** Toward grey by `g`, then × `s` (linear colour). */
function overcast(c: Vec3, g: number, s: number): Vec3 {
  const y = luma(c);
  return [mix(c[0], y, g) * s, mix(c[1], y, g) * s, mix(c[2], y, g) * s];
}

/** Pure: the time-of-day sample under `kind` at strength `amount` (0 = untouched). */
export function applyWeather(s: TodSample, kind: WeatherKind, amount: number, d: WeatherData = WEATHER): TodSample {
  if (kind === 'clear' || amount <= 0) return s;
  const w = d.kinds[kind], a = Math.min(1, amount);
  const m = (f: number) => mix(1, f, a);
  const g = w.grey * a, sky = m(w.sky);
  return {
    ...s,
    zenith: overcast(s.zenith, g, sky), horizon: overcast(s.horizon, g, sky),
    fogNear: s.fogNear * m(w.fog), fogFar: s.fogFar * m(w.fog),
    sunColor: overcast(s.sunColor, g, 1), sunIntensity: s.sunIntensity * m(w.sun),
    glow: s.glow * m(w.glow), disc: s.disc * m(w.disc),
    hemiSky: overcast(s.hemiSky, g, 1), hemiIntensity: s.hemiIntensity * m(w.hemi),
    stars: s.stars * m(w.stars),
  };
}

/** Pure: ground colour (linear) under the weather. */
export function weatherGround(base: Vec3, kind: WeatherKind, amount: number, d: WeatherData = WEATHER): Vec3 {
  if (kind === 'clear' || amount <= 0) return base;
  const w = d.kinds[kind], t = hexToSrgb(w.ground).map(srgbToLinear) as Vec3, k = w.groundMix * Math.min(1, amount);
  return [mix(base[0], t[0], k), mix(base[1], t[1], k), mix(base[2], t[2], k)];
}

/**
 * What the ground shows: soaked ground stays dark after the rain stops (it follows `wet`, not the sky), snow
 * weather greys it (the white itself is render/snowcover.ts on up-facing faces). Pure.
 */
export function groundWeather(w: { kind: WeatherKind; amount: number; wet?: number }): [WeatherKind, number] {
  if (w.kind === 'snow') return ['snow', w.amount];
  const wet = w.wet ?? (w.kind === 'rain' ? w.amount : 0);
  return wet > 0 ? ['rain', wet] : ['clear', 0];
}

/**
 * The fading state: `kind` is what is on screen at `amount`; `target` is where it is heading. Pure logic (no
 * three), so the fade is unit-testable; main.ts reads kind/amount each frame.
 */
export class WeatherFade {
  kind: WeatherKind = 'clear';
  amount = 0;
  target: WeatherKind = 'clear';
  /** How soaked the ground is 0..1 (puddles, lamp reflections): follows rain slowly, dries slower still. */
  wet = 0;
  /** Lying snow 0..1 on up-facing surfaces: builds up while it snows, melts slowly after. */
  snowCover = 0;
  fadeSeconds: number;
  cover: CoverDef;

  constructor(fadeSeconds = WEATHER.fadeSeconds, cover: CoverDef = WEATHER.cover) {
    this.fadeSeconds = fadeSeconds; this.cover = cover;
  }

  /** `cut` (boot / loaded save) jumps to the settled look: a rainy save is already soaked, a snowy one white. */
  set(kind: WeatherKind, cut = false): void {
    this.target = kind;
    if (cut) {
      this.kind = kind; this.amount = kind === 'clear' ? 0 : 1;
      this.wet = kind === 'rain' ? 1 : 0; this.snowCover = kind === 'snow' ? 1 : 0;
    }
  }

  /** True while something is still moving (callers re-apply the look only then). */
  get moving(): boolean {
    return this.kind !== this.target || (this.target === 'clear' ? this.amount > 0 : this.amount < 1);
  }

  update(dt: number): void {
    this.fadeStep(dt);
    this.accumulate(dt);
  }

  private fadeStep(dt: number): void {
    const step = this.fadeSeconds > 0 ? dt / this.fadeSeconds : 1;
    if (this.amount === 0) this.kind = this.target; // nothing showing: switch at once, the whole step fades in
    if (this.kind === this.target && this.target !== 'clear') { this.amount = Math.min(1, this.amount + step); return; }
    this.amount = Math.max(0, this.amount - step);
    if (this.amount === 0) this.kind = this.target;
  }

  /** Ground state lags the sky: soaking/covering scales with how hard it falls; drying/melting runs at a flat rate. */
  private accumulate(dt: number): void {
    if (!(dt > 0)) return;
    const c = this.cover, rate = (s: number) => (s > 0 ? dt / s : 1);
    const r = this.rain, n = this.snow;
    this.wet = r > 0 ? Math.min(1, this.wet + rate(c.wetIn) * r) : Math.max(0, this.wet - rate(c.wetOut));
    // anything but snow (rain included) melts lying snow at the flat rate
    this.snowCover = n > 0 ? Math.min(1, this.snowCover + rate(c.snowIn) * n) : Math.max(0, this.snowCover - rate(c.snowOut));
  }

  /** Strength of rain / snow right now (0 when the other kind is showing). */
  get rain(): number { return this.kind === 'rain' ? this.amount : 0; }
  get snow(): number { return this.kind === 'snow' ? this.amount : 0; }
}

/** Keeps a WeatherFade on the `weather` flag: story changes fade, a loaded save cuts. */
export class WeatherBinding {
  private offs: (() => void)[] = [];
  readonly store: Store;
  readonly fade: WeatherFade;

  constructor(store: Store, fade: WeatherFade) {
    this.store = store; this.fade = fade;
    this.offs.push(
      store.bus.on('flag:changed', e => { if (e.key === WEATHER_FLAG) fade.set(weatherKind(e.value)); }),
      store.bus.on('state:loaded', () => this.sync(true)),
    );
    this.sync(true);
  }
  sync(cut = false): void { this.fade.set(weatherKind(this.store.getFlag(WEATHER_FLAG)), cut); }
  dispose(): void { for (const off of this.offs) off(); this.offs = []; }
}
