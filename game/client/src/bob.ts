/** First-person head bob driven by ground actually covered, so it stops dead when blocked and never runs ahead of the feet. */
export const bobStep = (speed: number) => 0.9 + 0.2 * speed; // m per footfall: walk 3.4 → 1.58 m (2.2 steps/s), run 6 → 2.1 m (2.9 steps/s)
export const bobAmp = (speed: number) => Math.min(0.026, 0.0036 * speed); // m: walk ≈ 1.2 cm, run ≈ 2.2 cm
const SPEED_W = 8; // /s: ground-speed smoothing; also fades the bob out ~0.3 s after stopping
const SNAP = 9; // m/s: frame moves faster than this are reconcile snaps / teleports, not steps

export class HeadBob {
  speed = 0;
  phase = 0; // footfalls (fractional); each footfall is one dip
  /** dist: ground covered this frame (m); still: crouching / hidden / down / spectating — no bob. Returns the eye y offset. */
  step(dist: number, dt: number, still = false): number {
    if (dt <= 0) return this.y();
    const v = still || dist / dt > SNAP ? 0 : dist / dt;
    this.speed += (v - this.speed) * Math.min(1, dt * SPEED_W);
    if (v > 0) this.phase += dist / bobStep(this.speed || v);
    return this.y();
  }
  /** Dips at each footfall (phase integer), peaks mid-step. */
  y() { return -bobAmp(this.speed) * 0.5 * (1 + Math.cos(this.phase * 2 * Math.PI)); }
}
