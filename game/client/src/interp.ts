// Snapshot interpolation buffer (pure; unit-tested). Remote entities render INTERP_DELAY_MS in the past.
export interface Sample { t: number; x: number; y: number; z: number; yaw: number; pitch?: number }

export class InterpBuffer {
  private s: Sample[] = [];

  push(sample: Sample) {
    this.s.push(sample);
    if (this.s.length > 30) this.s.shift();
  }

  /** Drop everything but the newest sample: the entity jumps to it instead of sliding there. */
  collapse() { if (this.s.length > 1) this.s.splice(0, this.s.length - 1); }

  /** Timestamp of the newest sample (-Infinity when empty). */
  lastT(): number { return this.s.length ? this.s[this.s.length - 1].t : -Infinity; }

  /** Recent sampled ground speed, m/s: path length over the newest `windowMs` of samples (0 with < 2 samples). */
  speed(windowMs = 300): number {
    const s = this.s, n = s.length;
    if (n < 2) return 0;
    let d = 0, k = n - 1;
    while (k > 0 && s[n - 1].t - s[k - 1].t <= windowMs) { d += Math.hypot(s[k].x - s[k - 1].x, s[k].z - s[k - 1].z); k--; }
    if (k === n - 1) { d = Math.hypot(s[k].x - s[k - 1].x, s[k].z - s[k - 1].z); k--; } // one segment longer than the window
    const span = s[n - 1].t - s[k].t;
    return span > 0 ? d / (span / 1000) : 0;
  }

  /** Reference speed for StepSmoother: the faster of the newest 300 ms and 1 s. A sender that hitches (fresh positions
   *  only every ~500 ms, the ticks repeat them in between) reads 0 over 300 ms through each hold; with that alone the cap
   *  fell to the floor, the body dropped further behind every burst and finally snapped (#203). */
  paceSpeed(): number { return Math.max(this.speed(), this.speed(1000)); }

  /** Ground position box-filtered over render times t ± w/2 (`n` evenly spaced taps of `at`): a sender that moves per
   *  frame lands 0 / 2 steps in alternate ticks when its sends straddle the server tick, and this spreads that back into
   *  an even walk. Constant-velocity motion comes out unchanged. */
  avgAt(t: number, w: number, n: number, maxExtrap = 0, maxSpeed = Infinity): { x: number; z: number } | null {
    if (!this.s.length) return null;
    let x = 0, z = 0;
    for (let i = 0; i < n; i++) {
      const q = this.at(t + (n > 1 ? (i / (n - 1) - 0.5) * w : 0), maxExtrap, maxSpeed)!;
      x += q.x; z += q.z;
    }
    return { x: x / n, z: z / n };
  }

  /** State at render time t: lerp between bracketing samples, clamp to the oldest; past the newest, extrapolate the
   *  last segment's velocity (capped at `maxSpeed` m/s) for at most `maxExtrap` ms (then hold), so a late snapshot
   *  doesn't freeze the entity. */
  at(t: number, maxExtrap = 0, maxSpeed = Infinity): Sample | null {
    const s = this.s;
    if (!s.length) return null;
    if (t <= s[0].t) return s[0];
    const last = s[s.length - 1];
    if (t > last.t) {
      const prev = s[s.length - 2];
      const e = Math.min(t - last.t, maxExtrap);
      if (!prev || e <= 0 || last.t <= prev.t || last.t - prev.t > 250) return last; // no velocity (or a stale one across a gap)
      const dx = last.x - prev.x, dz = last.z - prev.z;
      const v = Math.hypot(dx, dz) / ((last.t - prev.t) / 1000);
      const k = (e / (last.t - prev.t)) * (v > maxSpeed ? maxSpeed / v : 1);
      return { t, x: last.x + dx * k, y: last.y, z: last.z + dz * k, yaw: last.yaw, pitch: last.pitch };
    }
    for (let k = s.length - 1; k > 0; k--) {
      const a = s[k - 1], b = s[k];
      if (t >= a.t && t <= b.t) {
        const u = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
        let dy = b.yaw - a.yaw;
        dy = Math.atan2(Math.sin(dy), Math.cos(dy)); // shortest-arc yaw
        return { t, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u, yaw: a.yaw + dy * u, pitch: a.pitch !== undefined && b.pitch !== undefined ? a.pitch + (b.pitch - a.pitch) * u : b.pitch };
      }
    }
    return s[s.length - 1];
  }
}

/** Maps server ticks to the local clock so batched/late snapshots keep their true spacing (not receive time). The
 *  offset follows the least-delayed of the last WINDOW arrivals (~2 s; counted, not timed, so a stall can't empty it),
 *  so it tracks a server whose ticks run long (setInterval drift: ~50.7 ms per 50 ms tick), and it only slews at a rate
 *  tied to local elapsed time: a batch landing at one instant keeps exact tick spacing. */
export class SnapClock {
  static readonly WINDOW = 40;
  /** Max offset change per ms of local time, moving down (arrivals got faster) / up (server ticks run slow). */
  static readonly SLEW_DOWN = 0.1;
  static readonly SLEW_UP = 0.05;
  /** Positive offset errors beyond this snap (reconnect, long tab freeze); negative errors enter fast settling. */
  static readonly SNAP_MS = 1000;
  /** After a snap the offset slides down at SETTLE_DOWN (< 1, so stamps stay monotone), remaining in settling until
   *  the debt clears, then for SETTLE_MS. A snap lands
   *  inside a backlog burst (the snapshots queued while the level loaded arrive at one instant, each 50 ms less
   *  delayed than the last), so it left each client 0.5–0.7 s above the true delay, and at SLEW_DOWN that took 5–8 s
   *  to bleed off: three clients rendered the same 角色074 at different server times, 0.3 m apart (#208). */
  static readonly SETTLE_MS = 1500;
  static readonly SETTLE_DOWN = 0.9;
  private off = NaN;
  private lastNow = 0;
  private lastT = 0;
  private snapAt = -Infinity;
  private settling = false;
  /** Monotone deque of (arrival #, delay) whose head is the window minimum. */
  private win: { n: number; d: number }[] = [];
  private n = 0;
  private tickMs: number;
  constructor(tickMs: number) { this.tickMs = tickMs; }

  /** Local-time stamp for a snapshot of `tick` received at `now`. */
  stamp(tick: number, now: number): number {
    const t = tick * this.tickMs, d = now - t, w = this.win;
    while (w.length && w[w.length - 1].d >= d) w.pop();
    w.push({ n: ++this.n, d });
    while (w[0].n <= this.n - SnapClock.WINDOW) w.shift();
    const target = w[0].d;
    if (Number.isNaN(this.off) || target - this.off > SnapClock.SNAP_MS) { this.off = target; this.snapAt = now; this.settling = false; }
    else {
      // A downward snap can reverse stamps inside a backlog batch. Enter fast settling for a large debt and keep
      // an existing settle active until paid; ordinary later latency drops retain SLEW_DOWN. Each reduction also
      // consumes server progress: a long arrival gap may contain only one new server tick.
      if (this.off - target > SnapClock.SNAP_MS || (target < this.off && now - this.snapAt < SnapClock.SETTLE_MS)) this.settling = true;
      const dt = Math.max(0, now - this.lastNow), down = this.settling || now - this.snapAt < SnapClock.SETTLE_MS ? SnapClock.SETTLE_DOWN : SnapClock.SLEW_DOWN;
      this.off += Math.max(-Math.min(dt, Math.max(0, t - this.lastT)) * down, Math.min(dt * SnapClock.SLEW_UP, target - this.off));
      if (this.settling && this.off <= target) { this.settling = false; this.snapAt = now; }
    }
    this.lastNow = now;
    this.lastT = t;
    return t + this.off;
  }
}

/** Split a frame of `elapsedS` real seconds into update slices `[dt, rdt]`. `dt` is the local sim step: the frame is
 *  clamped to `maxFrame` (a long stall must not teleport the player through walls) and cut into ≤ `slice` steps.
 *  `rdt` is the same slice scaled to the real elapsed time (clamped only at `maxReal`), for the remote playback that
 *  follows the server's clock: on clamped dt a 400 ms frame advanced it 300 ms and let the step cap fall 25 % behind the
 *  entity, so under sustained ~3 fps the lag grew past the snap distance and the teammate leapt 4 m in one frame (#201). */
export function frameSlices(elapsedS: number, maxFrame = 0.3, slice = 0.1, maxReal = 1): [number, number][] {
  const real = Math.max(0, elapsedS);
  let rem = Math.min(maxFrame, real);
  const k = rem > 0 ? Math.min(maxReal, real) / rem : 1;
  const out: [number, number][] = [];
  do { const dt = Math.min(slice, rem); rem -= dt; out.push([dt, dt * k]); } while (rem > 1e-4);
  return out;
}

/** Per-entity render clock keyed to the entity's own samples instead of `now − delay`: it runs at local rate, sped up
 *  or slowed by ≤ `maxRate` so the newest sample stays `leadMs` ahead on average (the lead saws by a tick between
 *  arrivals, so it is EMA-smoothed over `tau` ms). When SnapClock's stamps lag (server ticks running long) a fixed
 *  `now − delay` overtakes the newest sample and the entity is mostly extrapolated, lurching each tick; this keeps it
 *  interpolating. Errors past `snapMs` (first sample, long stall) snap. */
export class PlaybackClock {
  t = NaN;
  private lead = NaN;
  private leadMs: number;
  private tau: number;
  private maxRate: number;
  private snapMs: number;
  constructor(leadMs: number, tau = 500, maxRate = 0.1, snapMs = 1500) { this.leadMs = leadMs; this.tau = tau; this.maxRate = maxRate; this.snapMs = snapMs; }

  /** Advance by `dtMs` of local time given the newest sample's stamp, never past `maxT` (the extrapolation limit);
   *  returns true when it snapped. The lead filter sees the clamped t: fed the unclamped one, a long frame read as
   *  the clock far ahead of the newest sample and slowed playback by maxRate for seconds after (#202). */
  advance(dtMs: number, newest: number, maxT = Infinity): boolean {
    if (!Number.isFinite(newest)) return false;
    if (Number.isNaN(this.t) || Math.abs(newest - this.leadMs - this.t) > this.snapMs) {
      this.t = newest - this.leadMs; this.lead = this.leadMs;
      return true;
    }
    // behind (lead too big) → run fast, up to 3× maxRate so a backlog drains in a few s; ahead → slow by ≤ maxRate
    const r = Math.max(-this.maxRate, Math.min(3 * this.maxRate, (this.lead - this.leadMs) / 1000));
    this.t = Math.min(this.t + dtMs * (1 + r), maxT);
    this.lead += (newest - this.t - this.lead) * (1 - Math.exp(-dtMs / this.tau));
    return false;
  }
}

/** Visual offset that hides a server correction: the body jumps to the server's position at once (prediction continues
 *  from there) while the camera starts at the old spot and slides over with time constant `tau` s. Big jumps snap. */
export class CorrectionSmoother {
  x = 0; y = 0; z = 0;
  private tau: number;
  private readonly tau0: number;
  private snapDist: number;
  constructor(tau = 0.1, snapDist = 2) { this.tau = this.tau0 = tau; this.snapDist = snapDist; }

  /** The body moved from `from` to `to` by a correction; returns false (and clears the offset) when it should snap.
   *  `tau` overrides the slide's time constant until the next kick. */
  kick(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, tau = this.tau0): boolean {
    const x = this.x + from.x - to.x, y = this.y + from.y - to.y, z = this.z + from.z - to.z;
    if (Math.hypot(x, y, z) > this.snapDist) { this.reset(); return false; }
    this.x = x; this.y = y; this.z = z;
    this.tau = tau;
    return true;
  }

  reset() { this.x = this.y = this.z = 0; }

  /** Decay the offset by dt seconds (frame-rate independent); tiny remainders are dropped. */
  step(dt: number) {
    const k = Math.exp(-dt / this.tau);
    this.x *= k; this.y *= k; this.z *= k;
    if (Math.hypot(this.x, this.y, this.z) < 1e-3) this.reset();
  }
}

/** Rendered ground position that follows the interpolated one with each frame's step capped at `k`× the entity's
 *  recent sampled speed (at least `floor` m/s, the speed itself at most `maxV`): uneven per-tick displacements (the
 *  sender moves per frame) and the catch-up after an extrapolation hold spread over a few frames instead of one-frame
 *  leaps. `maxV` keeps a sampled speed inflated by bunched ticks (7–8 m/s read off a 6 m/s run) from letting the
 *  catch-up outrun anything the entity can really do. Far jumps snap. */
export class StepSmoother {
  x = 0; z = 0;
  private on = false;
  private k: number;
  private floor: number;
  private snapDist: number;
  private maxV: number;
  private catchDist: number;
  private catching = false;
  constructor(k = 1.3, floor = 1, snapDist = 2, maxV = Infinity, catchDist = 3 * snapDist) { this.k = k; this.floor = floor; this.snapDist = snapDist; this.maxV = maxV; this.catchDist = catchDist; }

  /** Move toward (tx,tz) over dt s with the reference speed `v` m/s; returns true when it snapped (first call, far jump). */
  step(tx: number, tz: number, dt: number, v: number): boolean {
    const dx = tx - this.x, dz = tz - this.z, d = Math.hypot(dx, dz);
    if (!this.on || d > (this.catching ? this.catchDist : this.snapDist)) { this.on = true; this.catching = false; this.x = tx; this.z = tz; return true; }
    const cap = Math.max(this.floor, this.k * Math.min(v, this.maxV)) * (this.catching ? 1.5 : 1) * dt;
    if (d <= cap) { this.x = tx; this.z = tz; this.catching = false; } else { this.x += (dx / d) * cap; this.z += (dz / d) * cap; }
    return false;
  }

  /** The target is about to jump ahead (the playback clock snapped forward after a snapshot stall): slide there at 1.5×
   *  the cap instead of snapping, for gaps up to `catchDist`, until caught up. A reset there teleported the body ~5 m in
   *  one frame (#202). */
  catchUp() { if (this.on) this.catching = true; }

  reset() { this.on = false; }
}

/** Turn `cur` toward `target` along the shortest arc: exponential approach (rate /s) capped at `maxRate` rad/s,
 *  so a teammate's snap turn (or the step left when extrapolation ends) reads as a quick turn instead of a pop. */
export function approachYaw(cur: number, target: number, dt: number, rate = 14, maxRate = 9): number {
  const d = Math.atan2(Math.sin(target - cur), Math.cos(target - cur));
  let step = d * (1 - Math.exp(-dt * rate));
  const cap = maxRate * dt;
  if (Math.abs(step) > cap) step = Math.sign(step) * cap;
  if (Math.abs(d - step) < 1e-4) return target;
  return cur + step;
}
