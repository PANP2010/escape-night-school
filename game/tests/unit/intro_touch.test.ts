import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { IntroEvent } from '../../shared/intro.ts';
import { Input } from '../../client/src/input.ts';
import { LevelIntro } from '../../client/src/intro.ts';
import { LOOK_SENS, TouchControls } from '../../client/src/touch.ts';
import { TOUCH_DRAG_PX } from '../../client/src/worldTouch.ts';

type Listener = (event: any) => void;
class Classes {
  private readonly values = new Set<string>();
  add(...values: string[]) { values.forEach((v) => this.values.add(v)); }
  remove(...values: string[]) { values.forEach((v) => this.values.delete(v)); }
  contains(value: string) { return this.values.has(value); }
  toggle(value: string, force = !this.contains(value)) {
    if (force) this.add(value); else this.remove(value);
    return force;
  }
}
class Element {
  id = '';
  hidden = false;
  disabled = false;
  textContent = '';
  className = '';
  classList = new Classes();
  style: Record<string, string> = {};
  parent?: Element;
  children: Element[] = [];
  listeners = new Map<string, Listener[]>();
  addEventListener(type: string, listener: Listener) { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]); }
  setAttribute() {}
  append(...elements: Element[]) { elements.forEach((element) => this.appendChild(element)); }
  appendChild(element: Element) { element.parent = this; this.children.push(element); return element; }
  contains(element: unknown): boolean { return element === this || this.children.some((child) => child.contains(element)); }
  closest(selector: string): Element | undefined { return selector === `#${this.id}` ? this : this.parent?.closest(selector); }
  focus() { doc.activeElement = this; }
  blur() { if (doc.activeElement === this) doc.activeElement = null; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((element) => element !== this); }
}

let doc: EventTarget & { body: Element; activeElement: Element | null; pointerLockElement: null; createElement: () => Element; querySelectorAll: () => Element[] };
let windowListeners: Map<string, Listener[]>;
let input: Input;
let controls: TouchControls;
let intro: LevelIntro;
let sendSkip: ReturnType<typeof vi.fn<(id: number) => void>>;
const find = (id: string, root = doc.body): Element => {
  if (root.id === id) return root;
  for (const child of root.children) {
    const result = findMaybe(id, child);
    if (result) return result;
  }
  throw new Error(`Missing element ${id}`);
};
const findMaybe = (id: string, root: Element): Element | undefined => root.id === id ? root : root.children.map((child) => findMaybe(id, child)).find(Boolean);
const finger = (identifier: number, clientX = 0, clientY = 0) => ({ identifier, clientX, clientY });
function touch(type: string, target: Element, ...changedTouches: ReturnType<typeof finger>[]) {
  return nativeTouch(type, target, true, ...changedTouches);
}
function nativeTouch(type: string, target: Element, cancelable: boolean, ...changedTouches: ReturnType<typeof finger>[]) {
  const event = {
    type, target, changedTouches, cancelable, defaultPrevented: false, stopped: false, preventCalls: 0,
    preventDefault() { this.preventCalls++; if (this.cancelable) this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
  };
  // Window capture precedes the control target, just as it does for a native touch event.
  for (const listener of windowListeners.get(type) ?? []) listener(event);
  if (!event.stopped) for (const listener of target.listeners.get(type) ?? []) listener(event);
  return event;
}
function receive(ended = false) {
  const event: IntroEvent = { t: 'event', kind: 'intro', id: 1, level: 0, startedAt: 1000, endsAt: 9000,
    now: ended ? 9000 : 1000, skipped: [], ended, route: [[0, 0, 0]] };
  intro.receive(event, '一楼', '寻找钥匙', 1);
}

beforeEach(() => {
  windowListeners = new Map();
  doc = Object.assign(new EventTarget(), { body: new Element(), activeElement: null, pointerLockElement: null, createElement: () => new Element(), querySelectorAll: () => [] });
  vi.stubGlobal('document', doc);
  vi.stubGlobal('Node', Element); vi.stubGlobal('Element', Element);
  vi.stubGlobal('addEventListener', (type: string, listener: Listener) => windowListeners.set(type, [...windowListeners.get(type) ?? [], listener]));
  vi.stubGlobal('removeEventListener', (type: string, listener: Listener) => windowListeners.set(type, (windowListeners.get(type) ?? []).filter((value) => value !== listener)));
  input = new Input(new Element() as unknown as HTMLElement);
  controls = new TouchControls(input);
  sendSkip = vi.fn();
  intro = new LevelIntro(new THREE.Scene(), new THREE.PerspectiveCamera(), sendSkip,
    () => { input.clear(); input.enabled = false; },
    () => { input.clear(); input.enabled = true; }, () => {});
});
afterEach(() => { intro.dispose(); controls.dispose(); vi.unstubAllGlobals(); });

describe('intro touch lifecycle', () => {
  it('forgets control fingers released under the intro, so fresh stick, look, hold and toggle gestures work', () => {
    const stick = find('touch-stick'), look = find('touch-look'), pad = find('touch-btns');
    const crouch = pad.children.find((element) => element.textContent === '蹲')!;
    const run = pad.children.find((element) => element.textContent === '跑')!;
    touch('touchstart', stick, finger(1)); touch('touchmove', stick, finger(1, 0, -40));
    touch('touchstart', look, finger(2)); touch('touchmove', look, finger(2, 10));
    touch('touchstart', run, finger(3)); touch('touchstart', crouch, finger(4));
    touch('touchend', crouch, finger(4));
    expect(input.down('KeyW')).toBe(true); expect(input.down('ShiftLeft')).toBe(true); expect(input.down('KeyC')).toBe(true);
    receive();
    expect(input.keys.size).toBe(0); expect(find('touch-base').classList.contains('on')).toBe(false);
    expect(run.classList.contains('on')).toBe(false); expect(crouch.classList.contains('on')).toBe(false);
    for (const [target, id] of [[stick, 1], [look, 2], [run, 3]] as const) {
      expect(touch('touchend', target, finger(id)).stopped).toBe(true);
    }
    receive(true);
    touch('touchstart', stick, finger(5)); touch('touchmove', stick, finger(5, 0, -40));
    expect(input.down('KeyW')).toBe(true);
    const yaw = input.yaw;
    touch('touchstart', look, finger(6)); touch('touchmove', look, finger(6, 20));
    expect(input.yaw).toBeLessThan(yaw);
    touch('touchstart', run, finger(7)); expect(input.down('ShiftLeft')).toBe(true);
    touch('touchstart', crouch, finger(8)); expect(input.down('KeyC')).toBe(true);
    touch('touchend', stick, finger(5)); touch('touchend', run, finger(7)); input.endFrame();
    expect(input.down('KeyW')).toBe(false); expect(input.down('ShiftLeft')).toBe(false);
  });

  it('consumes old fingers after all-skip, while new and mixed gestures can move and end immediately', () => {
    const stick = find('touch-stick'), look = find('touch-look'), skip = find('intro-skip');
    touch('touchstart', stick, finger(10)); touch('touchmove', stick, finger(10, 0, -40));
    receive();
    touch('touchstart', skip, finger(11)); touch('touchstart', look, finger(12));
    touch('touchend', skip, finger(11));
    expect(sendSkip).toHaveBeenCalledExactlyOnceWith(1); expect(intro.skipped).toBe(true); expect(intro.active).toBe(true);
    receive(true);
    const yaw = input.yaw;
    expect(touch('touchmove', stick, finger(10, 0, -50)).stopped).toBe(true);
    expect(touch('touchmove', look, finger(12, 50)).stopped).toBe(true);
    expect(input.keys.size).toBe(0); expect(input.yaw).toBe(yaw);
    expect(touch('touchstart', stick, finger(13)).stopped).toBe(false);
    touch('touchmove', stick, finger(13, 0, -40)); expect(input.down('KeyW')).toBe(true);
    expect(touch('touchmove', stick, finger(10, 0, -60), finger(13, 40, 0)).stopped).toBe(false);
    input.endFrame(); expect(input.down('KeyW')).toBe(false); expect(input.down('KeyD')).toBe(true);
    expect(touch('touchend', stick, finger(10)).stopped).toBe(true);
    expect(input.down('KeyD')).toBe(true);
    touch('touchend', stick, finger(13)); input.endFrame(); expect(input.keys.size).toBe(0);
    touch('touchstart', look, finger(14)); touch('touchmove', look, finger(14, 20));
    expect(input.yaw).toBeLessThan(yaw);
    // An old and a new finger can lift in the same native event; the new control must release.
    expect(touch('touchend', look, finger(12), finger(14)).stopped).toBe(false);
    const turned = input.yaw;
    touch('touchstart', look, finger(15)); touch('touchmove', look, finger(15, 20));
    expect(input.yaw).toBeLessThan(turned);
  });

  it('consumes fingers held across the deadline and preserves the update notice gesture', () => {
    const stick = find('touch-stick');
    receive(); touch('touchstart', stick, finger(20));
    const notice = new Element(); notice.id = 'update-available'; const button = notice.appendChild(new Element()); doc.body.append(notice);
    expect(touch('touchstart', button, finger(21)).stopped).toBe(false);
    receive(true);
    expect(touch('touchend', stick, finger(20)).stopped).toBe(true);
    expect(touch('touchend', button, finger(21)).stopped).toBe(false);
    expect(touch('touchstart', stick, finger(22)).stopped).toBe(false);
    touch('touchmove', stick, finger(22, 0, -40)); expect(input.down('KeyW')).toBe(true);
  });

  it('still quarantines and skips on a noncancelable touch, without attempting cancellation', () => {
    const stick = find('touch-stick'), skip = find('intro-skip');
    touch('touchstart', stick, finger(30)); receive();
    const move = nativeTouch('touchmove', stick, false, finger(30, 0, -40));
    expect(move.stopped).toBe(true); expect(move.preventCalls).toBe(0); expect(input.keys.size).toBe(0);
    touch('touchstart', skip, finger(31));
    const skipped = nativeTouch('touchend', skip, false, finger(31));
    expect(skipped.stopped).toBe(true); expect(skipped.preventCalls).toBe(0);
    expect(sendSkip).toHaveBeenCalledExactlyOnceWith(1); expect(intro.active).toBe(true);
    receive(true);
    const ended = nativeTouch('touchend', stick, false, finger(30));
    expect(ended.stopped).toBe(true); expect(ended.preventCalls).toBe(0);
    // The old identifier was released even though the browser disallowed cancellation.
    expect(touch('touchstart', stick, finger(30)).stopped).toBe(false);
    touch('touchmove', stick, finger(30, 0, -40)); expect(input.down('KeyW')).toBe(true);
  });

  it('releases stick, look and hold controls on noncancelable end/cancel events', () => {
    const stick = find('touch-stick'), look = find('touch-look');
    const run = find('touch-btns').children.find((element) => element.textContent === '跑')!;
    const uncancelable = (type: string, target: Element, point: ReturnType<typeof finger>) => {
      const event = nativeTouch(type, target, false, point);
      expect(event.preventCalls).toBe(0); return event;
    };
    uncancelable('touchstart', stick, finger(40)); uncancelable('touchmove', stick, finger(40, 0, -40));
    uncancelable('touchstart', look, finger(41)); uncancelable('touchmove', look, finger(41, 20));
    uncancelable('touchstart', run, finger(42));
    expect(input.down('KeyW')).toBe(true); expect(input.down('ShiftLeft')).toBe(true);
    uncancelable('touchend', stick, finger(40)); uncancelable('touchcancel', run, finger(42)); input.endFrame();
    expect(input.keys.size).toBe(0); expect(find('touch-base').classList.contains('on')).toBe(false);
    expect(run.classList.contains('on')).toBe(false);
    uncancelable('touchend', look, finger(41));
    const yaw = input.yaw;
    uncancelable('touchstart', look, finger(43)); uncancelable('touchmove', look, finger(43, 20));
    expect(input.yaw).toBeCloseTo(yaw - (20 - TOUCH_DRAG_PX) * LOOK_SENS, 6);
  });

  it('unsubscribes the control reset when touch controls are disposed', () => {
    const reset = vi.spyOn(controls as any, 'reset');
    input.clear(); expect(reset).toHaveBeenCalledOnce();
    controls.dispose(); const calls = reset.mock.calls.length;
    input.clear(); expect(reset).toHaveBeenCalledTimes(calls);
  });
});
