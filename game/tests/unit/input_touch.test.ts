import { beforeEach, describe, expect, it } from 'vitest';
import { Input } from '../../client/src/input.ts';
import { LOOK_SENS, StickKeys, stickState } from '../../client/src/touch.ts';

let l: Record<string, (e: unknown) => void>;
let el: { addEventListener: (n: string, f: (e: unknown) => void) => void; clicks: number; requestPointerLock: () => void | Promise<void> };
const mk = () => {
  l = {};
  (globalThis as any).addEventListener = (n: string, f: (e: unknown) => void) => { l[n] = f; };
  (globalThis as any).document = Object.assign(new EventTarget(), { pointerLockElement: null, getElementById: () => null });
  const h: Record<string, () => void> = {};
  el = { addEventListener: (n, f) => { h[n] = f as () => void; }, clicks: 0, requestPointerLock() { this.clicks++; } };
  const inp = new Input(el as any);
  return { inp, click: () => h.click() };
};

describe('Input synthetic keys', () => {
  beforeEach(() => { l = {}; });

  it('press/release behave like keydown/keyup (edge for consume, tap latch)', () => {
    const { inp } = mk();
    inp.press('KeyE');
    expect(inp.down('KeyE')).toBe(true);
    expect(inp.consume('KeyE')).toBe(true);
    expect(inp.consume('KeyE')).toBe(false);
    inp.press('KeyE'); // already held: no new edge
    expect(inp.consume('KeyE')).toBe(false);
    inp.release('KeyE');
    inp.endFrame();
    expect(inp.down('KeyE')).toBe(false);
    inp.press('KeyF'); inp.release('KeyF'); // a tap shorter than a frame still counts
    expect(inp.down('KeyF')).toBe(true);
  });

  it('look turns yaw right-negative and clamps pitch; mouse uses the same path', () => {
    const { inp } = mk();
    inp.look(100, 0, LOOK_SENS);
    expect(inp.yaw).toBeCloseTo(-0.4);
    inp.look(0, -1e6, LOOK_SENS);
    expect(inp.pitch).toBe(1.45);
    inp.look(0, 1e6);
    expect(inp.pitch).toBe(-1.45);
    const y = inp.yaw;
    (document as any).pointerLockElement = el;
    l.mousemove({ movementX: 10, movementY: 0 });
    expect(inp.yaw).toBeCloseTo(y - 10 * inp.sensitivity);
  });

  it('a touch device never requests pointer lock', () => {
    const a = mk();
    a.click();
    expect(el.clicks).toBe(1);
    const b = mk();
    b.inp.pointerLock = false;
    b.click();
    expect(el.clicks).toBe(0);
  });

  it('a rejected pointer lock leaves input usable and allows the next click to retry', async () => {
    const { inp, click } = mk();
    el.requestPointerLock = () => {
      el.clicks++;
      if (el.clicks === 1) return Promise.reject(new DOMException('Document is not active', 'WrongDocumentError'));
      (document as any).pointerLockElement = el;
      return Promise.resolve();
    };
    click();
    // Let an unhandled rejection reach the runner: the original fire-and-forget request fails this regression.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.pointerLockElement).toBeNull();
    l.keydown({ code: 'KeyW' });
    expect(inp.down('KeyW')).toBe(true);
    l.mousemove({ movementX: 10, movementY: 0 });
    expect(inp.yaw).toBe(0);

    click();
    await Promise.resolve();
    expect(el.clicks).toBe(2);
    expect(document.pointerLockElement).toBe(el);
    l.mousemove({ movementX: 10, movementY: 0 });
    expect(inp.yaw).toBeCloseTo(-10 * inp.sensitivity);
    click();
    expect(el.clicks).toBe(2); // already locked: do not request again
  });
});

describe('virtual stick', () => {
  it('dead zone below 0.15, 8-way keys above, run past 0.9', () => {
    expect(stickState(5, -5, 60).keys.size).toBe(0); // |v|≈0.118
    const fwd = stickState(0, -30, 60);
    expect([...fwd.keys]).toEqual(['KeyW']);
    expect(fwd.run).toBe(false);
    expect([...stickState(0, 30, 60).keys]).toEqual(['KeyS']);
    expect([...stickState(-30, 0, 60).keys]).toEqual(['KeyA']);
    expect([...stickState(30, 0, 60).keys].sort()).toEqual(['KeyD']);
    expect([...stickState(30, -30, 60).keys].sort()).toEqual(['KeyD', 'KeyW']);
    expect(stickState(0, -57, 60).run).toBe(true);
    expect(stickState(0, -200, 60).run).toBe(true); // beyond the radius clamps to 1
    expect(stickState(0, -50, 60).run).toBe(false);
  });

  it('StickKeys holds and releases WASD and Shift on the Input', () => {
    const { inp } = mk();
    const s = new StickKeys(inp);
    s.set(0, -60);
    expect(inp.keys.has('KeyW')).toBe(true);
    expect(inp.keys.has('ShiftLeft')).toBe(true);
    s.set(40, -10); // right-ish, below run
    expect(inp.keys.has('KeyW')).toBe(false);
    expect(inp.keys.has('KeyD')).toBe(true);
    expect(inp.keys.has('ShiftLeft')).toBe(false);
    s.setRunButton(true);
    expect(inp.keys.has('ShiftLeft')).toBe(true);
    s.setRunButton(false);
    s.clear();
    expect(inp.keys.size).toBe(0);
  });
});
