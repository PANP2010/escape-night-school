// 茉莉之夜: drifting pale-yellow perfume at the screen edge, under the HUD.
// The matching 52/55 Hz hum belongs to Sound's gesture-unlocked, volume-controlled bus.
import './jasmine.css';

export const JASMINE_RANGE = 15;
export const GRAIN_TIERS = 8, GRAIN_VARIANTS = 4;
export const GRAIN_HZ = 12;
export const LOW_GRAIN_HZ = 6;
/** Grain tile edge in CSS px, drawn 1:1 and repeated: a small canvas stretched to the screen turned each dot into a 6 px block. */
export const GRAIN_TILE = 256;

/** 0..1 grain strength for a monster `d` metres away; quadratic so it swells as it closes in. */
export function jasmineIntensity(d: number): number {
  if (!Number.isFinite(d) || !(d < JASMINE_RANGE)) return 0;
  const k = 1 - Math.max(0, d) / JASMINE_RANGE;
  return k * k;
}

const strength = (l: number) => Number.isFinite(l) ? Math.max(0, Math.min(1, l)) : 0;

/** Density tier 1..GRAIN_TIERS for a 0..1 strength; zero strength hides the overlay. */
export function grainTier(l: number): number {
  return Math.max(1, Math.round(strength(l) * GRAIN_TIERS));
}

/** Opacity follows proximity once, rather than multiplying the quadratic distance falloff a second time.
 * The outer warning band stays faint but present; at and beyond 15 m it is exactly clear. */
export function grainOpacity(l: number): number {
  return Math.min(1, 3 * Math.sqrt(strength(l)));
}

/** Clear centre radius, in % of each viewport half-axis. The centre stays clear even at contact. */
export function grainMaskInner(l: number): number {
  return Math.round(82 - 24 * Math.sqrt(strength(l)));
}

/** closest-corner made a straight edge's midpoint only 70.7% of the mask radius, hiding all four edges
 * at medium range. Explicit half-axis radii put every edge midpoint at 100%, on desktop and mobile. */
export const grainMask = (l: number) => `radial-gradient(ellipse 50% 50% at center, transparent ${grainMaskInner(l)}%, #000 100%)`;

/** Time-based attack/release: a slow mobile frame must not take seconds longer to reveal the same scent. */
export function grainLevel(current: number, target: number, dt: number): number {
  const from = strength(current), to = strength(target);
  const seconds = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  return to + (from - to) * Math.exp(-seconds / (to > from ? 0.25 : 0.4));
}

/** Encoded grain images, rendered once per (tier, variant) and reused: repeated animation-frame encoding stalled the
 * main thread (a GPU-backed canvas makes toDataURL a readback — seconds under swiftshader). */
export class GrainFrames {
  private cache = new Map<number, string>();
  private last = -1;
  private render: (l: number) => string;
  private rnd: () => number;
  constructor(render: (l: number) => string, rnd = Math.random) { this.render = render; this.rnd = rnd; }
  get size() { return this.cache.size; }
  /** A frame for strength `l`, a different variant from the previous pick so the grain keeps crawling. */
  next(l: number): string {
    const t = grainTier(l);
    let v = Math.floor(this.rnd() * (GRAIN_VARIANTS - 1));
    if (this.last >= 0 && this.last % GRAIN_VARIANTS <= v) v++; // skip the variant shown last
    const key = t * GRAIN_VARIANTS + v;
    this.last = key;
    let u = this.cache.get(key);
    if (!u) this.cache.set(key, (u = this.render(t / GRAIN_TIERS)));
    return u;
  }
}

export class JasmineFx {
  private el = document.createElement('div'); // a div, not a canvas: tests/e2e locate the game by 'canvas'
  private frameIn = 0;
  private cv = document.createElement('canvas');
  // CPU-backed: toDataURL on the default (GPU) canvas is a readback, ~3 s the first time under swiftshader
  private g = this.cv.getContext('2d', { willReadFrequently: true })!;
  private frames = new GrainFrames((l) => this.draw(l));
  private lvl = 0;
  private mask = -1;
  private disposed = false;
  private hz = GRAIN_HZ;
  private drift = 0;
  constructor() {
    this.cv.width = this.cv.height = GRAIN_TILE;
    this.el.id = 'jasmine';
    // Construct after the 3D canvas: a downed canvas's CSS filter creates its own z=0 stacking context.
    // At z=0 the later scent layer stays above that canvas, under #hud (z=1) and all full-screen HUD covers.
    this.el.style.cssText = `position:fixed;inset:0;pointer-events:none;background-size:${GRAIN_TILE}px ${GRAIN_TILE}px;background-repeat:repeat;z-index:0;opacity:0`;
    this.el.setAttribute('aria-hidden', 'true');
    this.el.dataset.quality = 'full';
    document.body.appendChild(this.el);
  }
  /** Perfume is a gameplay signal. Low effects reduce its work without removing it. */
  setPostprocessing(enabled: boolean) {
    this.hz = enabled ? GRAIN_HZ : LOW_GRAIN_HZ;
    this.el.dataset.quality = enabled ? 'full' : 'low';
    this.frameIn = 0;
  }
  update(d: number, dt = 1 / 60) {
    if (this.disposed) return;
    const v = jasmineIntensity(d);
    // No stale scent beyond the specified range, on a removed mob, or after an invalid distance.
    if (v === 0) { this.reset(); return; }
    this.lvl = grainLevel(this.lvl, v, dt);
    const l = this.lvl;
    this.el.style.opacity = String(+grainOpacity(l).toFixed(4));
    const seconds = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this.frameIn -= seconds;
    this.drift = (this.drift + seconds * 7) % GRAIN_TILE;
    if (l > 0 && this.frameIn <= 0) {
      // Carry the fractional remainder, without catching up a stalled frame with a burst of encodes.
      this.frameIn = Math.max(0, this.frameIn + 1 / this.hz);
      const st = this.el.style;
      st.backgroundImage = `url(${this.frames.next(l)})`;
      // Small upward drift reads as floating perfume rather than a full-screen static jump.
      st.backgroundPosition = `${(Math.sin(this.drift / 25) * 8).toFixed(1)}px ${(-this.drift).toFixed(1)}px`;
      st.setProperty('--jasmine-strength', Math.sqrt(l).toFixed(3));
      const m = grainMaskInner(l);
      if (m !== this.mask) {
        this.mask = m;
        const mask = grainMask(l);
        st.maskImage = mask;
        st.setProperty('-webkit-mask-image', mask);
      }
    }
  }
  reset() {
    this.lvl = 0; this.frameIn = 0;
    this.el.style.opacity = '0';
    this.el.style.setProperty('--jasmine-strength', '0');
  }
  dispose() {
    if (this.disposed) return;
    this.reset(); this.disposed = true;
    this.el.remove(); this.cv.width = this.cv.height = 0;
  }
  private draw(l: number): string {
    const { g } = this, s = GRAIN_TILE;
    g.clearRect(0, 0, s, s);
    // uniform over the tile: the edge falloff is the CSS mask, so tiling stays seamless
    // A close source needs a stronger density rise after edge opacity has reached one.
    // The quadratic term keeps the outer approach faint while making contact clearly denser.
    const n = Math.floor(260 + 2200 * Math.sqrt(l) + 3200 * l * l);
    for (let i = 0; i < n; i++) {
      // Pale, individually readable flecks. Distance controls count, opacity and rim width; multiplying
      // dot alpha by distance as well compounded the faint outer-range warning.
      g.fillStyle = `rgba(255,${236 + (Math.random() * 12) | 0},${160 + (Math.random() * 20) | 0},${0.48 + Math.random() * 0.3})`;
      g.fillRect((Math.random() * s) | 0, (Math.random() * s) | 0, 1 + (Math.random() < 0.45 ? 1 : 0), 1 + (Math.random() < 0.16 ? 1 : 0));
    }
    return this.cv.toDataURL();
  }
}
