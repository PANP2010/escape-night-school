// Touch controls: a virtual stick (WASD) + drag-to-look + action buttons. Everything goes through Input
// (press/release/look), so game.ts sees the same keys and yaw/pitch as with keyboard and mouse.
import type { Input } from './input.ts';
import { TouchIntent, TOUCH_DRAG_PX, TOUCH_HOLD_MS, worldTouchBlocked } from './worldTouch.ts';

export const STICK_DEADZONE = 0.15;
export const STICK_RUN = 0.9;
export const LOOK_SENS = 0.004; // rad per px
/** An axis counts as pushed when the stick direction is more than 22.5° off the other axis (8-way digital). */
const AXIS = Math.sin(Math.PI / 8);
const STICK_RADIUS = 60;

export const isTouchDevice = () =>
  (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window;

/** Stick offset (px from origin, screen y down) → the synthetic keys it holds; `run` when pushed past STICK_RUN. */
export function stickState(dx: number, dy: number, radius = STICK_RADIUS) {
  const mag = Math.min(1, Math.hypot(dx, dy) / radius);
  const keys = new Set<string>();
  if (mag < STICK_DEADZONE) return { keys, run: false, mag: 0 };
  const len = Math.hypot(dx, dy);
  const ux = dx / len, uy = dy / len;
  if (uy < -AXIS) keys.add('KeyW');
  if (uy > AXIS) keys.add('KeyS');
  if (ux < -AXIS) keys.add('KeyA');
  if (ux > AXIS) keys.add('KeyD');
  return { keys, run: mag > STICK_RUN, mag };
}

/** Holds Input keys for the stick and the run button; ShiftLeft is held while either wants to run. */
export class StickKeys {
  private held = new Set<string>();
  private stickRun = false;
  private btnRun = false;
  private input: Input;
  constructor(input: Input) { this.input = input; }

  set(dx: number, dy: number, radius = STICK_RADIUS) {
    const s = stickState(dx, dy, radius);
    for (const k of this.held) if (!s.keys.has(k)) this.input.release(k);
    for (const k of s.keys) if (!this.held.has(k)) this.input.press(k);
    this.held = s.keys;
    this.stickRun = s.run;
    this.syncRun();
  }

  clear() { this.set(0, 0); }

  reset() {
    for (const key of this.held) this.input.release(key);
    this.input.release('ShiftLeft');
    this.held.clear(); this.stickRun = false; this.btnRun = false;
  }

  setRunButton(on: boolean) { this.btnRun = on; this.syncRun(); }

  private syncRun() {
    if (this.stickRun || this.btnRun) { if (!this.input.keys.has('ShiftLeft')) this.input.press('ShiftLeft'); }
    else this.input.release('ShiftLeft');
  }
}

type Btn = { code: string; label: string; cls?: string; mode: 'tap' | 'hold' | 'toggle' | 'run' };
const BUTTONS: Btn[] = [
  { code: 'Tab', label: '队伍', mode: 'hold' },
  { code: 'KeyC', label: '蹲', mode: 'toggle' },
  { code: 'ShiftLeft', label: '跑', mode: 'run' },
  { code: 'KeyR', label: '电池', mode: 'tap' },
  { code: 'KeyF', label: '手电', mode: 'tap' },
  { code: 'KeyE', label: '互动', cls: 'main', mode: 'tap' },
];

export class TouchControls {
  readonly root = document.createElement('div');
  private stick: StickKeys;
  private base = document.createElement('div');
  private knob = document.createElement('div');
  private readonly resets: (() => void)[] = [];
  private readonly removeClear: () => void;

  private input: Input;

  constructor(input: Input, onWorldTap?: (x: number, y: number) => void) {
    this.input = input;
    this.stick = new StickKeys(input);
    this.root.id = 'touch';
    this.base.id = 'touch-base';
    this.knob.id = 'touch-knob';
    this.base.appendChild(this.knob);
    const stickZone = this.zone('touch-stick');
    const lookZone = this.zone('touch-look');
    this.root.append(stickZone, lookZone, this.base);
    this.bindStick(stickZone);
    this.bindLook(lookZone);
    if (onWorldTap) {
      this.bindTap(stickZone, onWorldTap);
      this.bindTap(lookZone, onWorldTap);
    }
    const pad = document.createElement('div');
    pad.id = 'touch-btns';
    for (const b of BUTTONS) pad.appendChild(this.button(b));
    this.root.appendChild(pad);
    const ping = document.createElement('button');
    ping.type = 'button';
    ping.id = 'touch-ping';
    ping.className = 'touch-btn';
    ping.textContent = '标记';
    ping.setAttribute('aria-label', '标记准星位置，通知队友');
    ping.title = '标记准星位置，通知队友';
    // A native button owns only its own hit area. The surrounding touch zones keep
    // handling direct taps on doors/items and drag-to-look exactly as before.
    ping.addEventListener('click', (e) => {
      e.preventDefault();
      if (!this.input.enabled) return;
      this.input.press('KeyQ');
      this.input.release('KeyQ');
    });
    this.root.appendChild(ping);
    document.body.appendChild(this.root);
    this.removeClear = input.onClear(() => this.reset());
  }

  private reset() { this.stick.reset(); for (const reset of this.resets) reset(); }

  dispose() { this.removeClear(); this.reset(); this.root.remove(); }

  private zone(id: string) {
    const z = document.createElement('div');
    z.id = id;
    z.className = 'touch-zone';
    return z;
  }

  private bindTap(zone: HTMLElement, onTap: (x: number, y: number) => void) {
    let tap: { id: number; x: number; y: number; at: number; moved: number } | null = null;
    zone.addEventListener('touchstart', (event) => {
      if (tap || event.changedTouches.length !== 1 || event.touches.length !== 1) { tap = null; return; }
      const touch = event.changedTouches[0];
      tap = { id: touch.identifier, x: touch.clientX, y: touch.clientY, at: performance.now(), moved: 0 };
    }, { passive: true });
    zone.addEventListener('touchmove', (event) => {
      if (!tap) return;
      if (event.touches.length !== 1) { tap = null; return; }
      const touch = TouchControls.find(event, tap.id);
      if (touch) tap.moved = Math.max(tap.moved, Math.hypot(touch.clientX - tap.x, touch.clientY - tap.y));
    }, { passive: true });
    zone.addEventListener('touchend', (event) => {
      if (!tap) return;
      const touch = TouchControls.find(event, tap.id);
      if (!touch) return;
      const finished = tap; tap = null;
      if (event.touches.length === 0 && finished.moved <= 12 && Math.hypot(touch.clientX - finished.x, touch.clientY - finished.y) <= 12 && performance.now() - finished.at <= 450) onTap(touch.clientX, touch.clientY);
    }, { passive: true });
    zone.addEventListener('touchcancel', () => { tap = null; }, { passive: true });
    this.resets.push(() => { tap = null; });
  }

  /** Calls f for each changed touch with the given identifier (or any, when `id` is null → first). */
  private static find(e: TouchEvent, id: number | null): Touch | null {
    for (const t of Array.from(e.changedTouches)) if (id === null || t.identifier === id) return t;
    return null;
  }

  private bindStick(z: HTMLElement) {
    let id: number | null = null;
    let ox = 0, oy = 0;
    const intent = new TouchIntent();
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    const move = (t: Touch) => {
      const dx = t.clientX - ox, dy = t.clientY - oy;
      this.stick.set(dx, dy);
      const m = Math.min(STICK_RADIUS, Math.hypot(dx, dy)), a = Math.atan2(dy, dx);
      this.knob.style.transform = `translate(${Math.cos(a) * m}px, ${Math.sin(a) * m}px)`;
    };
    const end = () => {
      clearTimeout(holdTimer);
      this.input.worldTouch?.('release', ox, oy);
      id = null;
      this.stick.clear();
      this.knob.style.transform = '';
      this.base.classList.remove('on');
      this.base.style.left = this.base.style.top = '';
    };
    z.addEventListener('touchstart', (e) => {
      if (e.cancelable) e.preventDefault();
      if (id !== null) { intent.suppress(); this.input.worldTouch?.('release', ox, oy); return; }
      const t = e.changedTouches[0];
      if (!this.input.enabled) return;
      id = t.identifier; ox = t.clientX; oy = t.clientY;
      intent.begin(ox, oy, performance.now());
      if (worldTouchBlocked(ox, oy)) intent.suppress();
      else this.input.worldTouch?.('start', ox, oy);
      holdTimer = setTimeout(() => { if (id !== null && intent.hold(performance.now())) this.input.worldTouch?.('hold', ox, oy); }, TOUCH_HOLD_MS + 1);
      this.base.classList.add('on');
      this.base.style.left = `${ox}px`; this.base.style.top = `${oy}px`; // floating origin: the base follows the first finger-down
      move(t);
    }, { passive: false });
    z.addEventListener('touchmove', (e) => { if (e.cancelable) e.preventDefault(); const t = TouchControls.find(e, id); if (t && id !== null && intent.move(t.clientX, t.clientY)) { this.input.worldTouch?.('release', ox, oy); move(t); } }, { passive: false });
    const up = (e: TouchEvent) => { if (e.cancelable) e.preventDefault(); const t = TouchControls.find(e, id); if (id !== null && t) { intent.move(t.clientX, t.clientY); if (intent.tap(performance.now())) this.input.worldTouch?.('tap', t.clientX, t.clientY); end(); } };
    z.addEventListener('touchend', up, { passive: false });
    z.addEventListener('touchcancel', end, { passive: false });
    z.addEventListener('pointercancel', end);
    addEventListener('blur', end);
    this.resets.push(end);
  }

  private bindLook(z: HTMLElement) {
    let id: number | null = null;
    let lx = 0, ly = 0;
    let ox = 0, oy = 0;
    const intent = new TouchIntent();
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    z.addEventListener('touchstart', (e) => {
      if (e.cancelable) e.preventDefault();
      if (id !== null) { intent.suppress(); this.input.worldTouch?.('release', ox, oy); return; }
      const t = e.changedTouches[0];
      if (!this.input.enabled) return;
      id = t.identifier; lx = t.clientX; ly = t.clientY;
      ox = lx; oy = ly; intent.begin(ox, oy, performance.now());
      if (worldTouchBlocked(ox, oy)) intent.suppress();
      else this.input.worldTouch?.('start', ox, oy);
      holdTimer = setTimeout(() => { if (id !== null && intent.hold(performance.now())) this.input.worldTouch?.('hold', ox, oy); }, TOUCH_HOLD_MS + 1);
    }, { passive: false });
    z.addEventListener('touchmove', (e) => {
      if (e.cancelable) e.preventDefault();
      const t = id === null ? null : TouchControls.find(e, id);
      if (!t) return;
      const wasDragging = intent.dragging;
      if (intent.move(t.clientX, t.clientY)) {
        this.input.worldTouch?.('release', ox, oy);
        // Consume only the dead zone once; a first large swipe must still turn by its remaining distance.
        const dx = t.clientX - lx, dy = t.clientY - ly;
        const scale = wasDragging ? 1 : Math.max(0, 1 - TOUCH_DRAG_PX / Math.hypot(dx, dy));
        this.input.look(dx * scale, dy * scale, LOOK_SENS);
        lx = t.clientX; ly = t.clientY;
      }
    }, { passive: false });
    const cancel = () => { clearTimeout(holdTimer); id = null; this.input.worldTouch?.('release', ox, oy); };
    const up = (e: TouchEvent) => { if (e.cancelable) e.preventDefault(); const t = TouchControls.find(e, id); if (id !== null && t) { intent.move(t.clientX, t.clientY); if (intent.tap(performance.now())) this.input.worldTouch?.('tap', t.clientX, t.clientY); cancel(); } };
    z.addEventListener('touchend', up, { passive: false });
    z.addEventListener('touchcancel', cancel, { passive: false });
    z.addEventListener('pointercancel', cancel);
    addEventListener('blur', cancel);
    this.resets.push(cancel);
  }

  private button(b: Btn) {
    const el = document.createElement('div');
    el.className = `touch-btn${b.cls ? ` ${b.cls}` : ''}`;
    el.textContent = b.label;
    const ids = new Set<number>();
    let on = false;
    const set = (v: boolean) => {
      on = v;
      el.classList.toggle('on', v);
      if (b.mode === 'run') this.stick.setRunButton(v);
      else if (v) this.input.press(b.code);
      else this.input.release(b.code);
    };
    this.resets.push(() => { ids.clear(); set(false); });
    el.addEventListener('touchstart', (e) => {
      if (e.cancelable) e.preventDefault();
      if (!this.input.enabled) return;
      for (const t of Array.from(e.changedTouches)) ids.add(t.identifier);
      if (b.mode === 'toggle') set(!on);
      else if (!on) set(true);
    }, { passive: false });
    const up = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
      for (const t of Array.from(e.changedTouches)) ids.delete(t.identifier);
      if (ids.size === 0 && b.mode !== 'toggle') set(false);
    };
    el.addEventListener('touchend', up, { passive: false });
    el.addEventListener('touchcancel', up, { passive: false });
    this.resets.push(() => { ids.clear(); set(false); });
    return el;
  }
}
