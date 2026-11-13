import { afterEach, describe, expect, it, vi } from 'vitest';
import { GRAIN_HZ, LOW_GRAIN_HZ, GRAIN_TILE, GRAIN_TIERS, GRAIN_VARIANTS, GrainFrames, JasmineFx, JASMINE_RANGE, grainLevel, grainMask, grainMaskInner, grainOpacity, grainTier, jasmineIntensity } from '../../client/src/fx.ts';

const seeded = () => { let seed = 1; return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe('jasmineIntensity', () => {
  it('is 0 at/after range, 1 at contact, monotone', () => {
    expect(jasmineIntensity(JASMINE_RANGE)).toBe(0);
    expect(jasmineIntensity(40)).toBe(0);
    expect(jasmineIntensity(0)).toBe(1);
    expect(jasmineIntensity(5)).toBeGreaterThan(jasmineIntensity(10));
    expect(jasmineIntensity(NaN)).toBe(0);
    expect(jasmineIntensity(-Infinity)).toBe(0);
  });
});
describe('GrainFrames', () => {
  it('encodes each (tier, variant) once, then only reuses', () => {
    const calls: number[] = [];
    const f = new GrainFrames((l) => (calls.push(l), `img${calls.length}`));
    const rnd = seeded();
    for (let k = 0; k < 2000; k++) f.next(rnd());
    expect(f.size).toBe(GRAIN_TIERS * GRAIN_VARIANTS);
    expect(calls.length).toBe(GRAIN_TIERS * GRAIN_VARIANTS);
    for (let k = 0; k < 500; k++) f.next(rnd());
    expect(calls.length).toBe(GRAIN_TIERS * GRAIN_VARIANTS);
  });
  it('never shows the same frame twice in a row at a steady strength', () => {
    const rnd = seeded(); let n = 0;
    const f = new GrainFrames((l) => `${l}:${n++}`, rnd);
    let prev = '';
    for (let k = 0; k < 300; k++) { const u = f.next(0.5); expect(u).not.toBe(prev); prev = u; }
  });
  it('renders denser grain for a closer monster', () => {
    const seen: number[] = [];
    const f = new GrainFrames((l) => (seen.push(l), String(l)));
    f.next(jasmineIntensity(12)); f.next(jasmineIntensity(2));
    expect(seen[1]).toBeGreaterThan(seen[0]);
    expect(grainTier(0.01)).toBe(1);
    expect(grainTier(1)).toBe(GRAIN_TIERS);
  });
});
describe('grain overlay curve', () => {
  it('is off beyond range and fades in, not a full-opacity jump', () => {
    expect(grainOpacity(jasmineIntensity(17))).toBe(0);
    // Old l<.01 cutoff left the entire 13.5–15 m warning band empty.
    for (const d of [13.5, 14, 14.9]) expect(grainOpacity(jasmineIntensity(d))).toBeGreaterThan(0);
    expect(grainOpacity(jasmineIntensity(14))).toBeLessThan(0.3);
    expect(grainOpacity(jasmineIntensity(6))).toBe(1);
    for (const bad of [NaN, Infinity, -1]) expect(grainOpacity(bad)).toBe(0);
    for (let d = 0; d < 15; d += 0.5) expect(grainOpacity(jasmineIntensity(d))).toBeGreaterThanOrEqual(grainOpacity(jasmineIntensity(d + 0.5)));
  });
  it('keeps the grain at the rim, creeping inward as it closes in', () => {
    expect(grainMaskInner(0)).toBeGreaterThanOrEqual(75);
    expect(grainMaskInner(1)).toBeGreaterThanOrEqual(50);
    expect(grainMaskInner(jasmineIntensity(3))).toBeLessThan(grainMaskInner(jasmineIntensity(8)));
    expect(grainMaskInner(2)).toBe(grainMaskInner(1));
    // With closest-corner each straight edge midpoint was at only 70.7% of the radius;
    // at 8 m the old 71% clear radius therefore hid the middle of all four edges.
    for (const d of [14, 8, 3]) {
      expect(grainMask(jasmineIntensity(d))).toContain('ellipse 50% 50% at center');
      expect(grainMaskInner(jasmineIntensity(d))).toBeLessThan(100);
      expect(grainMask(jasmineIntensity(d))).not.toContain('closest-corner');
    }
  });
});
describe('time-based jasmine response', () => {
  it('converges equally in one second at 60, 15 and 5 fps', () => {
    const run = (fps: number, from: number, to: number) => {
      let l = from; for (let i = 0; i < fps; i++) l = grainLevel(l, to, 1 / fps); return l;
    };
    for (const fps of [15, 5]) {
      expect(run(fps, 0, 0.64)).toBeCloseTo(run(60, 0, 0.64), 12);
      expect(run(fps, 0.64, 0.02)).toBeCloseTo(run(60, 0.64, 0.02), 12);
    }
    expect(run(5, 0, 0.64)).toBeGreaterThan(0.6);
    expect(grainLevel(0.5, 1, NaN)).toBe(0.5);
    expect(grainLevel(0.5, 1, -1)).toBe(0.5);
  });
});

function fxFixture() {
  const rectangles: number[][] = [], colors: string[] = [];
  const context = { fillStyle: '', clearRect: vi.fn(), fillRect: (x: number, y: number, w: number, h: number) => { rectangles.push([x, y, w, h]); colors.push(context.fillStyle); } };
  const element = () => ({
    id: '', hidden: false, textContent: '', dataset: {} as Record<string, string>,
    style: { cssText: '', opacity: '', backgroundImage: '', backgroundPosition: '', maskImage: '', setProperty: vi.fn() },
    setAttribute: vi.fn(), append: vi.fn(), remove: vi.fn(),
  });
  const el = element(), style = el.style;
  let swaps = 0, image = '';
  Object.defineProperty(style, 'backgroundImage', {
    get: () => image,
    set: (value: string) => { image = value; swaps++; },
  });
  let encodes = 0;
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => context), toDataURL: vi.fn(() => `frame-${++encodes}`) };
  const body = { appendChild: vi.fn() };
  vi.stubGlobal('document', { body, createElement: (tag: string) => tag === 'canvas' ? canvas : el });
  vi.spyOn(Math, 'random').mockImplementation(seeded());
  return { fx: new JasmineFx(), el, style, canvas, context, body, rectangles, colors, get swaps() { return swaps; } };
}

describe('native grain rendering and lifetime', () => {
  it('draws a repeating native-size pale-yellow tile with small pale-yellow chalk flecks', () => {
    const f = fxFixture();
    f.fx.update(3, 1);
    expect(f.canvas.width).toBe(GRAIN_TILE); expect(f.canvas.height).toBe(GRAIN_TILE);
    expect(f.canvas.getContext).toHaveBeenCalledWith('2d', { willReadFrequently: true });
    expect(f.style.cssText).toContain(`background-size:${GRAIN_TILE}px ${GRAIN_TILE}px`);
    expect(f.style.cssText).toContain('pointer-events:none');
    expect(f.style.cssText).toContain('z-index:0');
    expect(f.el.setAttribute).toHaveBeenCalledWith('aria-hidden', 'true');
    expect(f.rectangles.length).toBeGreaterThan(500);
    for (const [x, y, w, h] of f.rectangles) {
      expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(GRAIN_TILE);
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThan(GRAIN_TILE);
      expect([1, 2]).toContain(w); expect([1, 2]).toContain(h);
    }
    for (const color of f.colors) {
      const [r, g, b, alpha] = color.slice(5, -1).split(',').map(Number);
      expect(r).toBe(255); expect(g).toBeGreaterThanOrEqual(230); expect(g).toBeLessThan(250);
      expect(b).toBeGreaterThanOrEqual(150); expect(b).toBeLessThan(190);
      expect(alpha).toBeGreaterThanOrEqual(0.48); expect(alpha).toBeLessThan(0.8);
    }
  });

  it('shows the 14 m warning immediately, strengthens near, clears outside range and disposes once', () => {
    const f = fxFixture();
    f.fx.update(14, 1 / 60);
    expect(Number(f.style.opacity)).toBeGreaterThan(0);
    const far = Number(f.style.opacity);
    f.fx.update(3, 1); expect(Number(f.style.opacity)).toBeGreaterThan(far);
    f.fx.update(17, 1 / 60); expect(f.style.opacity).toBe('0');
    f.fx.update(3, 1); f.fx.update(NaN, 1 / 60); expect(f.style.opacity).toBe('0');
    f.fx.update(3, 1); f.fx.reset(); expect(f.style.opacity).toBe('0');
    f.fx.dispose(); f.fx.dispose();
    expect(f.el.remove).toHaveBeenCalledOnce(); expect(f.canvas.width).toBe(0);
    const calls = f.canvas.toDataURL.mock.calls.length;
    f.fx.update(3, 1); expect(f.canvas.toDataURL).toHaveBeenCalledTimes(calls);
  });

  it('limits the crawling texture updates by time while keeping the bounded 32-image cache', () => {
    const f = fxFixture();
    for (let i = 0; i < 600; i++) f.fx.update(3, 1 / 60);
    expect(GRAIN_HZ).toBeGreaterThanOrEqual(10); expect(GRAIN_HZ).toBeLessThanOrEqual(15);
    expect(f.canvas.toDataURL.mock.calls.length).toBeLessThanOrEqual(GRAIN_TIERS * GRAIN_VARIANTS);
  });

  it('keeps actual perfume particles in low effects, with fewer texture updates and no text overlay', () => {
    const f = fxFixture();
    f.fx.setPostprocessing(false);
    f.fx.update(14, 1 / 60);
    expect(f.el.hidden).toBe(false);
    expect(f.el.dataset.quality).toBe('low');
    expect(Number(f.style.opacity)).toBeGreaterThan(0);
    expect(f.style.backgroundImage).toContain('frame-');
    expect(f.el.textContent).toBe('');
    expect(f.body.appendChild).toHaveBeenCalledOnce();
    for (let i = 1; i < 600; i++) f.fx.update(8, 1 / 60);
    expect(f.swaps).toBeLessThanOrEqual(LOW_GRAIN_HZ * 10 + 2);
    expect(f.swaps).toBeGreaterThan(LOW_GRAIN_HZ * 9);
    expect(f.canvas.toDataURL.mock.calls.length).toBeLessThanOrEqual(GRAIN_TIERS * GRAIN_VARIANTS);
    expect(Number(f.style.opacity)).toBe(1);
  });

  it('clears perfume outside range and on stale state even in low effects', () => {
    const f = fxFixture();
    f.fx.update(3, 1);
    f.fx.setPostprocessing(false);
    expect(Number(f.style.opacity)).toBeGreaterThan(0);
    for (const distance of [15, 40, Infinity, NaN]) {
      f.fx.update(3, 1);
      f.fx.update(distance, 1);
      expect(f.style.opacity).toBe('0');
    }
    f.fx.update(3, 1);
    f.fx.reset();
    expect(f.style.opacity).toBe('0');
    f.fx.dispose(); f.fx.dispose();
    expect(f.el.remove).toHaveBeenCalledOnce();
  });
});
