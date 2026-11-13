/** Local preferences for environmental effects and optional touch feedback. */
export interface FeedbackPreferences {
  volume: number;
  muted: boolean;
  haptics: boolean;
}

const STORAGE_KEY = 'escape.feedback';
const DEFAULTS: FeedbackPreferences = { volume: 0.65, muted: false, haptics: true };

function preferencesFrom(value: unknown): FeedbackPreferences {
  const p = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<FeedbackPreferences> : {};
  return {
    volume: typeof p.volume === 'number' && Number.isFinite(p.volume)
      ? Math.max(0, Math.min(1, p.volume)) : DEFAULTS.volume,
    muted: typeof p.muted === 'boolean' ? p.muted : DEFAULTS.muted,
    haptics: typeof p.haptics === 'boolean' ? p.haptics : DEFAULTS.haptics,
  };
}

function readPreferences(): FeedbackPreferences {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    return preferencesFrom(raw ? JSON.parse(raw) : undefined);
  } catch {
    // Storage can be unavailable in private browsing, or contain an older/corrupt value.
    return { ...DEFAULTS };
  }
}

/** Persistent audio and haptic preferences used by the single game settings dialog. */
export class FeedbackSettings {
  private current: FeedbackPreferences;
  private readonly onChange: (p: FeedbackPreferences) => void;
  private readonly subscribers = new Set<(p: FeedbackPreferences) => void>();
  private disposed = false;

  constructor(onChange: (p: FeedbackPreferences) => void) {
    this.onChange = onChange;
    this.current = readPreferences();
    this.onChange(this.preferences);
  }

  get preferences(): FeedbackPreferences { return { ...this.current }; }

  subscribe(listener: (p: FeedbackPreferences) => void): () => void {
    if (this.disposed) return () => {};
    this.subscribers.add(listener);
    listener(this.preferences);
    return () => this.subscribers.delete(listener);
  }

  update(patch: Partial<FeedbackPreferences>): void {
    if (this.disposed) return;
    this.current = preferencesFrom({ ...this.current, ...patch });
    try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(this.current)); }
    catch { /* Live controls still work when storage is denied or full. */ }
    this.onChange(this.preferences);
    for (const listener of this.subscribers) listener(this.preferences);
  }

  dispose(): void {
    this.disposed = true;
    this.subscribers.clear();
  }
}
