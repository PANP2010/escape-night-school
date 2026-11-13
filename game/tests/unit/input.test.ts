import { afterEach, describe, expect, it, vi } from 'vitest';
import { Input } from '../../client/src/input.ts';

afterEach(() => vi.unstubAllGlobals());

describe('Input tap latch', () => {
  it('a keydown+keyup within one frame still registers once', () => {
    const l: Record<string, (e: unknown) => void> = {};
    vi.stubGlobal('addEventListener', (n: string, f: (e: unknown) => void) => { l[n] = f; });
    vi.stubGlobal('document', new EventTarget());
    const inp = new Input({ addEventListener() {} } as any);
    l.keydown({ code: 'KeyW' }); l.keyup({ code: 'KeyW' });
    expect(inp.down('KeyW')).toBe(true);
    expect(inp.held('KeyW')).toBe(false);
    inp.endFrame();
    expect(inp.down('KeyW')).toBe(false);
  });
});


describe('settings input boundary', () => {
  it('notifies hold actions immediately on press, release, blur and disabling input', () => {
    const listeners: Record<string, (e: unknown) => void> = {};
    vi.stubGlobal('addEventListener', (name: string, fn: (e: unknown) => void) => { listeners[name] = fn; });
    vi.stubGlobal('document', new EventTarget());
    const input = new Input({ addEventListener() {} } as any), states: boolean[] = [];
    input.onChange = () => states.push(input.held('KeyE'));
    input.press('KeyE'); input.release('KeyE'); input.press('KeyE'); listeners.blur({});
    input.press('KeyE'); input.enabled = false;
    expect(states).toEqual([true, false, true, false, true, false]);
    input.enabled = true;
    expect(input.held('KeyE')).toBe(false);
    expect(input.consume('KeyE')).toBe(false);
  });
  it('a physical E tap releases the hold immediately while preserving its single-frame action edge', () => {
    const listeners: Record<string, (e: unknown) => void> = {};
    vi.stubGlobal('addEventListener', (name: string, fn: (e: unknown) => void) => { listeners[name] = fn; });
    vi.stubGlobal('document', new EventTarget());
    const input = new Input({ addEventListener() {} } as any), states: boolean[] = [];
    input.onChange = () => states.push(input.held('KeyE'));
    listeners.keydown({ code: 'KeyE' });
    listeners.keyup({ code: 'KeyE' });
    expect(states).toEqual([true, false]);
    expect(input.held('KeyE')).toBe(false);
    expect(input.down('KeyE')).toBe(true);
    expect(input.consume('KeyE')).toBe(true);
    expect(input.consume('KeyE')).toBe(false);
    input.endFrame();
    expect(input.down('KeyE')).toBe(false);
  });
  it('ignores native keydown while disabled and does not restore a hold when the panel closes', () => {
    const listeners: Record<string, (e: unknown) => void> = {};
    vi.stubGlobal('addEventListener', (name: string, fn: (e: unknown) => void) => { listeners[name] = fn; });
    vi.stubGlobal('document', new EventTarget());
    const input = new Input({ addEventListener() {} } as any);
    listeners.keydown({ code: 'KeyE' });
    input.enabled = false;
    listeners.keydown({ code: 'KeyE', repeat: true });
    listeners.keyup({ code: 'KeyE' });
    input.enabled = true;
    expect(input.held('KeyE')).toBe(false);
    expect(input.down('KeyE')).toBe(false);
    expect(input.consume('KeyE')).toBe(false);
    listeners.keydown({ code: 'KeyE' });
    expect(input.held('KeyE')).toBe(true);
    expect(input.consume('KeyE')).toBe(true);
  });
  it('keeps normal Tab native but captures spectator cycling before focus can leave the game', () => {
    const listeners: Record<string, (e: unknown) => void> = {};
    vi.stubGlobal('addEventListener', (name: string, fn: (e: unknown) => void) => { listeners[name] = fn; });
    vi.stubGlobal('document', new EventTarget());
    const input = new Input({ addEventListener() {} } as any);
    let prevented = 0;
    const tab = { code: 'Tab', preventDefault: () => prevented++ };
    listeners.keydown(tab); listeners.keyup(tab); expect(prevented).toBe(0);
    input.captureTab = true;
    listeners.keydown(tab); listeners.keyup(tab); expect(prevented).toBe(1);
    expect(input.consume('Tab')).toBe(true);
    input.captureTab = false;
    listeners.keydown(tab); expect(prevented).toBe(1);
  });
  it('clears held movement and action edges together when a native panel opens', () => {
    const listeners: Record<string, (e: unknown) => void> = {};
    vi.stubGlobal('addEventListener', (name: string, fn: (e: unknown) => void) => { listeners[name] = fn; });
    vi.stubGlobal('document', new EventTarget());
    const input = new Input({ addEventListener() {} } as any);
    input.press('KeyW'); input.press('KeyE'); input.clear();
    expect(input.down('KeyW')).toBe(false); expect(input.consume('KeyE')).toBe(false);
    input.press('KeyW'); expect(input.down('KeyW')).toBe(true);
  });
});

describe('desktop H help', () => {
  function setup() {
    const listeners: Record<string, (e: unknown) => void> = {};
    const classes = new Set(['off', 'covered']);
    const hint = { classList: { remove: (c: string) => classes.delete(c), toggle: (c: string, on: boolean) => on ? classes.add(c) : classes.delete(c) } };
    const canvas = { addEventListener() {} };
    const doc = Object.assign(new EventTarget(), { pointerLockElement: canvas, activeElement: null as unknown, body: { classList: { contains: () => false } }, getElementById: () => hint });
    (globalThis as any).addEventListener = (name: string, fn: (e: unknown) => void) => { listeners[name] = fn; };
    (globalThis as any).document = doc;
    const input = new Input(canvas as any);
    return { input, listeners, classes, doc };
  }

  it('restores help under pointer lock while preserving chat overlap arbitration', () => {
    const { input, listeners, classes } = setup();
    listeners.keydown({ code: 'KeyH' });
    expect(classes.has('off')).toBe(false);
    expect(classes.has('covered')).toBe(true);
    expect(input.consume('KeyH')).toBe(false);
  });

  it('uses non-bubbling document pointer-lock events to hide help, lets H restore it, and shows it on unlock', () => {
    const windowEvents = new EventTarget();
    const canvas = new EventTarget();
    const classes = new Set(['covered']);
    const hint = { classList: { remove: (c: string) => classes.delete(c), toggle: (c: string, on: boolean) => on ? classes.add(c) : classes.delete(c) } };
    const doc = Object.assign(new EventTarget(), { pointerLockElement: null as EventTarget | null,
      activeElement: null, body: { classList: { contains: () => false } }, getElementById: () => hint });
    (globalThis as any).addEventListener = windowEvents.addEventListener.bind(windowEvents);
    (globalThis as any).document = doc;
    new Input(canvas as any);
    doc.pointerLockElement = canvas;
    document.dispatchEvent(new Event('pointerlockchange'));
    expect(classes.has('off')).toBe(true);

    const h = new Event('keydown');
    Object.defineProperty(h, 'code', { value: 'KeyH' });
    windowEvents.dispatchEvent(h);
    expect(classes.has('off')).toBe(false);
    expect(classes.has('covered')).toBe(true);

    document.dispatchEvent(new Event('pointerlockchange'));
    expect(classes.has('off')).toBe(true);
    doc.pointerLockElement = null;
    document.dispatchEvent(new Event('pointerlockchange'));
    expect(classes.has('off')).toBe(false);
  });

  it('leaves chat, editable fields, virtual keyboard and modified shortcuts alone', () => {
    const { input, listeners, classes, doc } = setup();
    input.enabled = false; listeners.keydown({ code: 'KeyH' });
    input.enabled = true; listeners.keydown({ code: 'KeyH', target: { tagName: 'INPUT' } });
    listeners.keydown({ code: 'KeyH', target: { isContentEditable: true } });
    doc.activeElement = { tagName: 'TEXTAREA' }; listeners.keydown({ code: 'KeyH' });
    doc.activeElement = null; listeners.keydown({ code: 'KeyH', ctrlKey: true });
    input.pointerLock = false; listeners.keydown({ code: 'KeyH' });
    expect(classes.has('off')).toBe(true);
  });
});
