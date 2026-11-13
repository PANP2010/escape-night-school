export type HapticKind = 'toggle' | 'door' | 'pickup' | 'danger' | 'down' | 'revive' | 'success';

interface HapticNavigator {
  vibrate?: (pattern: number | number[]) => boolean;
  readonly maxTouchPoints?: number;
  readonly userAgent?: string;
  readonly userActivation?: { readonly isActive: boolean };
}

interface HapticDocument {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

interface HapticMediaQuery {
  readonly matches: boolean;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
  addListener?: (listener: () => void) => void;
  removeListener?: (listener: () => void) => void;
}

/** Optional browser seams for tests; production callers can use new Haptics(). */
export interface HapticsOptions {
  navigator?: HapticNavigator | null;
  document?: HapticDocument | null;
  matchMedia?: ((query: string) => HapticMediaQuery) | null;
  now?: () => number;
}

// All effects finish within 100 ms, including their short silent gaps.
const EFFECTS: Record<HapticKind, { pattern: number | number[]; gap: number }> = {
  toggle: { pattern: 8, gap: 350 },
  door: { pattern: 12, gap: 400 },
  pickup: { pattern: 10, gap: 350 },
  danger: { pattern: [15, 40, 15], gap: 1500 },
  down: { pattern: [25, 45, 25], gap: 1500 },
  revive: { pattern: [12, 30, 18], gap: 1000 },
  success: { pattern: [15, 35, 20], gap: 1200 },
};
const GLOBAL_GAP = 180;

/** Discrete, opt-out touch feedback. Never schedules a vibration or a timer. */
export class Haptics {
  private readonly nav: HapticNavigator | null;
  private readonly doc: HapticDocument | null;
  private readonly reduced: HapticMediaQuery | null;
  private readonly coarse: HapticMediaQuery | null;
  private readonly now: () => number;
  private removeReducedListener: (() => void) | null = null;
  private enabled = true;
  private unlocked = false;
  private disposed = false;
  private activeUntil = 0;
  private lastAttemptAt = -Infinity;
  private readonly lastKindAt = new Map<HapticKind, number>();

  constructor(options: HapticsOptions = {}) {
    this.nav = options.navigator === undefined ? (typeof navigator === 'undefined' ? null : navigator) : options.navigator;
    this.doc = options.document === undefined ? (typeof document === 'undefined' ? null : document) : options.document;
    this.now = options.now ?? (() => typeof performance === 'undefined' ? Date.now() : performance.now());
    const matchMedia = options.matchMedia === undefined
      ? (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : null)
      : options.matchMedia;
    const query = (value: string): HapticMediaQuery | null => {
      try { return matchMedia?.(value) ?? null; } catch { return null; }
    };
    this.reduced = query('(prefers-reduced-motion: reduce)');
    this.coarse = query('(pointer: coarse)');
    this.doc?.addEventListener('visibilitychange', this.onVisibilityChange);
    if (this.reduced?.addEventListener) {
      this.reduced.addEventListener('change', this.onReducedChange);
      this.removeReducedListener = () => this.reduced?.removeEventListener?.('change', this.onReducedChange);
    } else if (this.reduced?.addListener) {
      this.reduced.addListener(this.onReducedChange);
      this.removeReducedListener = () => this.reduced?.removeListener?.(this.onReducedChange);
    }
  }

  /** Call synchronously from a real user gesture; this never vibrates itself. */
  unlock(): void {
    if (this.disposed || this.doc?.hidden) return;
    // Older touch browsers have no userActivation API; their trusted handler
    // must supply this boundary. On modern browsers reject synthetic unlocks.
    if (this.nav?.userActivation && !this.nav.userActivation.isActive) return;
    this.unlocked = true;
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.enabled = enabled;
    if (!enabled) this.cancel();
  }

  /** Returns whether the browser accepted this effect, not hardware support. */
  pulse(kind: HapticKind): boolean {
    if (this.disposed || !this.enabled || !this.unlocked || this.doc?.hidden || this.reduced?.matches) return false;
    const touch = (this.nav?.maxTouchPoints ?? 0) > 0 || this.coarse?.matches
      || /Android|iPhone|iPad|iPod|Mobile/i.test(this.nav?.userAgent ?? '');
    if (!touch) return false;
    const effect = EFFECTS[kind];
    const now = this.now();
    if (now - this.lastAttemptAt < GLOBAL_GAP || now - (this.lastKindAt.get(kind) ?? -Infinity) < effect.gap) return false;
    try {
      if (typeof this.nav?.vibrate !== 'function') return false;
      // Pass a fresh array so a browser/polyfill cannot mutate our patterns.
      const pattern = Array.isArray(effect.pattern) ? [...effect.pattern] : effect.pattern;
      // A browser refusal must not turn an event burst into repeated API calls.
      // Only accepted effects consume the longer, per-kind cooldown below.
      this.lastAttemptAt = now;
      if (!this.nav.vibrate(pattern)) return false;
      this.lastKindAt.set(kind, now);
      this.activeUntil = now + (Array.isArray(pattern) ? pattern.reduce((sum, ms) => sum + ms, 0) : pattern);
      return true;
    } catch {
      return false;
    }
  }

  /** Idempotent: only interrupt an effect that can still be playing. */
  cancel(): void {
    const active = this.activeUntil > this.now();
    this.activeUntil = 0;
    if (!active) return;
    try { this.nav?.vibrate?.(0); } catch { /* Unsupported/revoked vibration is harmless. */ }
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
    this.doc?.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.removeReducedListener?.();
    this.removeReducedListener = null;
  }

  private readonly onVisibilityChange = (): void => {
    if (this.doc?.hidden) this.cancel();
  };

  private readonly onReducedChange = (): void => {
    if (this.reduced?.matches) this.cancel();
  };
}
