/**
 * Per-act palettes (data/palettes/*.json, docs/05_art_audio.md). The post shader snaps every pixel to the
 * nearest palette colour in Oklab. Palettes go to the GPU as uniform arrays of Oklab triples (≤ 32 × vec3),
 * not a LUT texture: no extra fetch/texture memory, and a runtime swap is just a uniform upload.
 * Fading A → B is a per-pixel ordered-dither choice between the two, so output stays strictly on-palette.
 */
export interface PaletteDef { name: string; note?: string; colors: string[] }

export const MIN_COLORS = 16;
export const MAX_COLORS = 32;
export const DEFAULT_PALETTE = 'act1';

const files = import.meta.glob<PaletteDef>('../../data/palettes/*.json', { eager: true, import: 'default' });
/** id (file stem) → palette, e.g. `act3`. */
export const PALETTES: Record<string, PaletteDef> = Object.fromEntries(
  Object.entries(files).map(([path, def]) => [path.replace(/^.*\/|\.json$/g, ''), def]));

export type Vec3 = [number, number, number];

/** "#a1b2c3" → sRGB 0..1. Throws on malformed input. */
export function hexToSrgb(hex: string): Vec3 {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`bad colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Linear sRGB → Oklab (Björn Ottosson). Must match `toOklab` in post.ts. */
export function linearToOklab([r, g, b]: Vec3): Vec3 {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export const hexToOklab = (hex: string): Vec3 => linearToOklab(hexToSrgb(hex).map(srgbToLinear) as Vec3);

/** Problems with a palette definition; empty = valid. */
export function validatePalette(def: unknown): string[] {
  const p = def as Partial<PaletteDef> | null;
  if (!p || typeof p !== 'object') return ['not an object'];
  const errs: string[] = [];
  if (typeof p.name !== 'string' || !p.name) errs.push('missing name');
  if (!Array.isArray(p.colors)) return [...errs, 'colors must be an array'];
  if (p.colors.length < MIN_COLORS || p.colors.length > MAX_COLORS) {
    errs.push(`need ${MIN_COLORS}~${MAX_COLORS} colors, got ${p.colors.length}`);
  }
  const seen = new Set<string>();
  for (const c of p.colors) {
    if (typeof c !== 'string' || !/^#[0-9a-f]{6}$/i.test(c)) { errs.push(`bad colour: ${String(c)}`); continue; }
    const k = c.toLowerCase();
    if (seen.has(k)) errs.push(`duplicate colour: ${c}`);
    seen.add(k);
  }
  return errs;
}

/**
 * Flat Oklab triples, always MAX_COLORS long: short palettes repeat their last colour, which never
 * changes the nearest-colour answer, so the shader loop has a constant bound and no count uniform.
 */
export function paletteOklab(def: PaletteDef): Float32Array {
  const out = new Float32Array(MAX_COLORS * 3);
  for (let i = 0; i < MAX_COLORS; i++) {
    out.set(hexToOklab(def.colors[Math.min(i, def.colors.length - 1)]), i * 3);
  }
  return out;
}

/** CPU reference of the shader's search: index of the nearest entry (squared Oklab distance). */
export function nearestIndex(lab: Vec3, pal: Float32Array): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < pal.length / 3; i++) {
    const d = (lab[0] - pal[i * 3]) ** 2 + (lab[1] - pal[i * 3 + 1]) ** 2 + (lab[2] - pal[i * 3 + 2]) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

export interface PaletteUniforms {
  palA: { value: Float32Array };
  palB: { value: Float32Array };
  palMix: { value: number };
}

/**
 * Which palette is on screen and the dithered mix between two of them. `k` eases toward `goal` (real seconds,
 * advanced by update(dt)); apply() writes the post-shader uniforms. set() fades fully to one palette; blend()
 * holds a fixed in-between mix (act 2's gradual desaturation). A new set() mid-fade starts from whichever
 * palette dominates.
 */
export class PaletteFade {
  from: string;
  to: string;
  /** 0 = all `from`, 1 = all `to`. */
  k = 1;
  /** Where `k` is heading; 1 unless blend() asked for a fixed mix. */
  goal = 1;
  /** k units per second; Infinity = cut. */
  private rate = Infinity;
  private cache = new Map<string, Float32Array>();

  readonly defs: Record<string, PaletteDef>;

  constructor(id = DEFAULT_PALETTE, defs: Record<string, PaletteDef> = PALETTES) {
    this.defs = defs;
    this.check(id);
    this.from = this.to = id;
  }

  get current(): string { return this.to; }
  get fading(): boolean { return this.k !== this.goal; }

  /** Switch to `id`; seconds = 0 cuts immediately. Unknown ids throw (callers validate first). */
  set(id: string, seconds = 0): void {
    this.check(id);
    if (id !== this.to) {
      this.from = this.k >= 0.5 ? this.to : this.from;
      this.to = id;
      this.k = 0;
    }
    this.retarget(1, seconds);
  }

  /**
   * Hold a fixed mix `goal` (0..1) of `from` → `to`, easing there over `seconds`. Same pair (or the same pair
   * reversed) keeps the on-screen mix and eases from it; a different pair restarts at whichever end is on screen.
   */
  blend(from: string, to: string, goal: number, seconds = 0): void {
    this.check(from); this.check(to);
    goal = Math.min(1, Math.max(0, goal));
    if (from === to) { this.set(to, seconds); return; }
    if (from === this.to && to === this.from) this.k = 1 - this.k;
    else if (from !== this.from || to !== this.to) {
      const shown = this.k >= 0.5 ? this.to : this.from;
      this.k = shown === to ? 1 : 0;
    }
    this.from = from;
    this.to = to;
    this.retarget(goal, seconds);
  }

  update(dt: number): void {
    if (this.k === this.goal) return;
    const step = this.rate * dt;
    this.k = this.k < this.goal ? Math.min(this.goal, this.k + step) : Math.max(this.goal, this.k - step);
  }

  private retarget(goal: number, seconds: number): void {
    this.goal = goal;
    if (seconds > 0) this.rate = Math.abs(goal - this.k) / seconds;
    else { this.rate = Infinity; this.k = goal; }
  }

  private check(id: string): void {
    if (!(id in this.defs)) throw new Error(`unknown palette: ${id}`);
  }

  lab(id: string): Float32Array {
    let v = this.cache.get(id);
    if (!v) this.cache.set(id, v = paletteOklab(this.defs[id]));
    return v;
  }

  apply(u: PaletteUniforms): void {
    u.palA.value = this.lab(this.from);
    u.palB.value = this.lab(this.to);
    u.palMix.value = this.k;
  }
}
