/** Network hold renewal has its own clock: a slow render must not release a held interaction. */
export const REVIVE_REFRESH_MS = 100;

export interface ReviveHoldOptions {
  /** Read live input, range and player state every time; null means no valid hold. */
  target: () => number | null;
  /** false means the connection cannot send; holds must never be queued for reconnect. */
  send: (id: number) => boolean | void;
  cancel: (id: number) => void;
  now?: () => number;
  intervalMs?: number;
}

export class ReviveHold {
  private readonly options: ReviveHoldOptions;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private targetId: number | null = null;
  private started: number | null = null;
  private sentAt = -Infinity;
  private disposed = false;

  constructor(options: ReviveHoldOptions) {
    this.options = options;
    this.now = options.now ?? (() => performance.now());
    this.intervalMs = options.intervalMs ?? REVIVE_REFRESH_MS;
  }

  get id() { return this.targetId; }
  get since() { return this.started; }

  /** Input/network events call this synchronously; the interval also rechecks validity without rAF. */
  sync() {
    if (this.disposed) return;
    const id = this.options.target();
    if (id !== this.targetId) {
      this.stop();
      if (id === null) return;
      this.targetId = id;
      this.started = this.now();
      this.timer = setInterval(() => this.sync(), this.intervalMs);
    }
    if (id === null) return;
    const now = this.now();
    if (now - this.sentAt < this.intervalMs) return;
    this.sentAt = now;
    if (this.options.send(id) === false) this.stop();
  }

  stop() {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    const id = this.targetId;
    this.targetId = this.started = null;
    this.sentAt = -Infinity;
    if (id !== null) this.options.cancel(id);
  }

  dispose() { this.disposed = true; this.stop(); }
}
