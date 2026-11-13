/** The opening waits for player input, or three seconds of frames without a loading stall. */
export const OBJECTIVE_SETTLE_MS = 3000;
export const OBJECTIVE_STABLE_FRAME_MS = 500;
export const BANNER_FADE_MS = 600;
/** A suspended tab may resume without a visibility event (for example, browser lifecycle freezing). */
export const OBJECTIVE_RESUME_GAP_MS = 1000;
export type BannerPhase = 'hidden' | 'readable' | 'fading';

export interface ObjectiveFrame {
  spawned: boolean;
  /** The HUD can actually be read: foreground, uncovered and outside a cutscene. */
  visible: boolean;
  rendered: boolean;
}

/** Only advance once, after rendering. Wall-clock timeouts can expire before the first painted frame. */
export class ObjectiveTiming {
  pending = true;
  private interacted = false;
  private stableSince?: number;
  private lastFrame?: number;
  private duration?: number;
  private visibleSince?: number;
  private lastPresentedFrame?: number;

  reset() {
    this.pending = true;
    this.interacted = false;
    this.duration = undefined;
    this.pause();
  }

  input() { this.interacted = true; }

  /** Also usable by intro/capture presenters. Resuming grants the full reading interval again. */
  pause() {
    this.stableSince = this.lastFrame = this.visibleSince = this.lastPresentedFrame = undefined;
  }

  show(duration: number) {
    this.duration = duration;
    // Count from the next presented frame, after the DOM has been made visible.
    this.visibleSince = undefined;
  }

  /** Discard a replaced presentation without rearming the level's opening gate. */
  hide() {
    this.duration = this.visibleSince = this.lastPresentedFrame = undefined;
  }

  frame(now: number, state: ObjectiveFrame): { start: boolean; phase: BannerPhase } {
    if (!state.spawned || !state.visible) {
      this.pause();
      return { start: false, phase: 'hidden' };
    }
    let start = false;
    if (this.pending) {
      if (state.rendered) {
        if (this.lastFrame === undefined || now - this.lastFrame > OBJECTIVE_STABLE_FRAME_MS) this.stableSince = now;
        this.lastFrame = now;
      } else this.stableSince = this.lastFrame = undefined;
      if (this.interacted || (this.stableSince !== undefined && now - this.stableSince >= OBJECTIVE_SETTLE_MS)) {
        this.pending = false;
        start = true;
      }
    }
    if (this.duration === undefined) return { start, phase: 'hidden' };
    if (!state.rendered) {
      this.visibleSince = this.lastPresentedFrame = undefined;
      return { start, phase: 'hidden' };
    }
    if (this.lastPresentedFrame !== undefined && now - this.lastPresentedFrame > OBJECTIVE_RESUME_GAP_MS) this.visibleSince = undefined;
    this.lastPresentedFrame = now;
    this.visibleSince ??= now;
    const elapsed = Math.max(0, now - this.visibleSince);
    if (elapsed < this.duration) return { start, phase: 'readable' };
    if (elapsed < this.duration + BANNER_FADE_MS) return { start, phase: 'fading' };
    this.duration = this.visibleSince = undefined;
    return { start, phase: 'hidden' };
  }
}
