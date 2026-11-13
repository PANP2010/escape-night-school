// Keyboard + pointer-lock mouse look. touch.ts injects the same events through press/release/look.
import type { WorldTouchPhase } from './worldTouch.ts';
export const MOUSE_SENSITIVITY = 0.0022;

export class Input {
  readonly keys = new Set<string>();
  yaw = 0;
  pitch = 0;
  sensitivity = MOUSE_SENSITIVITY;
  /** Edge-triggered key presses since last consume(). */
  private pressed = new Set<string>();
  private active = true;
  private suspensions = 0;
  private readonly clearListeners = new Set<() => void>();
  /** Native overlays can suspend controls without overwriting chat, keypad or completion state. */
  get enabled() { return this.active && this.suspensions === 0; }
  set enabled(value: boolean) { this.active = value; if (!value) this.clear(); }
  /** Hold actions observe physical input immediately. */
  onChange?: () => void;
  /** False on touch devices (touch.ts): tapping the canvas must not request pointer lock. */
  pointerLock = true;
  /** Spectators use Tab to cycle cameras even without pointer lock. Native settings handle their own Tab. */
  captureTab = false;
  /** Gameplay input can release presentation gates before rendering has settled. */
  onInteraction?: () => void;
  worldTouch?: (phase: WorldTouchPhase, x: number, y: number) => void;
  /** Discrete interactions must not wait for a rendered frame. Holds still use down('KeyE'). */
  onInteract?: () => void;
  /** Keys pressed since the last frame, so a tap shorter than one frame still moves. */
  private tapped = new Set<string>();

  private el: HTMLElement;

  constructor(el: HTMLElement) {
    this.el = el;
    addEventListener('keydown', (e) => {
      if (!this.enabled || editing(e.target) || editing(document.activeElement)) return;
      if (e.code === 'KeyH' && this.pointerLock && !document.body?.classList.contains('touch') && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
        document.getElementById('hint')?.classList.remove('off');
        this.onInteraction?.();
        return;
      }
      // Uncaptured keyboard users must be able to reach native settings with Tab.
      if (e.code === 'Tab' && (document.pointerLockElement === el || this.captureTab)) e.preventDefault();
      this.press(e.code);
    });
    // Native panels stop bubbling keys; releases must still clear any game key held before focus moved.
    addEventListener('keyup', (e) => this.release(e.code), true);
    addEventListener('blur', () => this.clear());
    el.addEventListener('pointerdown', () => { if (this.enabled) this.onInteraction?.(); });
    el.addEventListener('click', () => this.requestPointerLock());
    // the key hint only matters before the mouse is captured; once playing it competes with subtitles
    document.addEventListener('pointerlockchange', () => document.getElementById('hint')?.classList.toggle('off', document.pointerLockElement === el));
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== el) return;
      this.look(e.movementX, e.movementY);
    });
  }

  /** Hold a key (synthetic or real); edge-triggered for consume() when it was not already held. */
  press(code: string) {
    if (!this.enabled) return;
    const fresh = !this.keys.has(code);
    if (fresh) this.pressed.add(code);
    this.onInteraction?.();
    this.keys.add(code);
    this.tapped.add(code);
    if (fresh && code === 'KeyE') this.onInteract?.();
    this.onChange?.();
  }

  release(code: string) { this.keys.delete(code); this.onChange?.(); }

  /** Turn the view by a pointer delta in px (right/down positive); `sens` rad/px defaults to the mouse sensitivity. */
  look(dx: number, dy: number, sens = MOUSE_SENSITIVITY) {
    if (!this.enabled) return;
    if (dx || dy) this.onInteraction?.();
    const scaled = sens * this.sensitivity / MOUSE_SENSITIVITY;
    this.yaw -= dx * scaled;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - dy * scaled));
    this.onChange?.();
  }

  down(code: string) { return this.enabled && (this.keys.has(code) || this.tapped.has(code)); }

  /** Continuous interactions must not turn a released, frame-latched tap into a hold. */
  held(code: string) { return this.enabled && this.keys.has(code); }

  endFrame() { this.tapped.clear(); }

  /** Opening settings must also discard action edges queued between rendered frames. */
  clear() {
    this.keys.clear(); this.pressed.clear(); this.tapped.clear();
    this.onChange?.();
    for (const listener of this.clearListeners) listener();
  }

  /** Touch controls keep their held fingers and toggle visuals in sync with modal input resets. */
  onClear(listener: () => void) { this.clearListeners.add(listener); return () => this.clearListeners.delete(listener); }
  /** The release is idempotent; changes to enabled while a panel is open are retained. */
  suspend(): () => void {
    this.suspensions++;
    this.clear();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.suspensions--;
      this.clear();
    };
  }

  /** Call from a click or another user gesture; denied browser capture can be retried. */
  requestPointerLock(): void {
    if (!this.pointerLock || !this.enabled || document.pointerLockElement === this.el) return;
    try { void this.el.requestPointerLock?.()?.catch(() => {}); }
    catch { /* An inactive document or browser Escape cooldown can refuse capture. */ }
  }

  consume(code: string) {
    const had = this.pressed.has(code);
    this.pressed.delete(code);
    return this.enabled && had;
  }
}

/** Native text entry and mobile virtual keyboards own their keystrokes. */
function editing(target: EventTarget | null | undefined): boolean {
  const el = target as HTMLElement | null | undefined;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}
