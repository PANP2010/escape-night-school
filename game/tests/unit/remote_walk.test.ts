import { describe, expect, it } from 'vitest';
import { SPEED } from '../../shared/constants.ts';
import { InterpBuffer, PlaybackClock, StepSmoother, frameSlices } from '../../client/src/interp.ts';

const smp = (t: number, x: number, z = 0) => ({ t, x, y: 0, z, yaw: 0 });

describe('InterpBuffer.speed', () => {
  it('is 0 with fewer than 2 samples', () => {
    const b = new InterpBuffer();
    expect(b.speed()).toBe(0);
    b.push(smp(0, 0));
    expect(b.speed()).toBe(0);
  });
  it('averages path length over the newest window, so a 0 / 2-step tick pair reads as the mean speed', () => {
    const b = new InterpBuffer();
    [0, 0.13, 0.13, 0.39, 0.52, 0.52, 0.78].forEach((x, i) => b.push(smp(i * 50, x)));
    expect(b.speed(300)).toBeCloseTo(2.6);
    expect(b.speed(100)).toBeCloseTo(2.6); // last two segments: 0 + 0.26 over 100 ms
  });
  it('uses the newest segment alone when it is longer than the window', () => {
    const b = new InterpBuffer();
    b.push(smp(0, 0)); b.push(smp(500, 1));
    expect(b.speed(300)).toBeCloseTo(2);
  });
  it('paceSpeed reads the 1 s mean through a held position (bursty sender), the 300 ms speed when that is higher', () => {
    const b = new InterpBuffer();
    for (let t = 0; t <= 1000; t += 50) b.push(smp(t, t < 500 ? 0 : 2.3)); // 2.3 m leap at 500 ms, then held 500 ms
    expect(b.speed()).toBe(0);
    expect(b.paceSpeed()).toBeCloseTo(2.3);
    const w = new InterpBuffer();
    for (let t = 0; t <= 1000; t += 50) w.push(smp(t, t < 700 ? 0 : (t - 700) / 1000 * 4.6)); // stood, then runs
    expect(w.paceSpeed()).toBeCloseTo(4.6);
  });
});

describe('InterpBuffer.avgAt', () => {
  it('leaves constant-velocity motion unchanged', () => {
    const b = new InterpBuffer();
    for (let i = 0; i < 10; i++) b.push(smp(i * 50, i * 0.13));
    expect(b.avgAt(200, 100, 5)!.x).toBeCloseTo(b.at(200)!.x);
  });
  it('evens out a 0 / 2-step tick pair', () => {
    const b = new InterpBuffer();
    [0, 0.13, 0.13, 0.39, 0.39, 0.65, 0.65, 0.91].forEach((x, i) => b.push(smp(i * 50, x)));
    let prev = b.avgAt(100, 100, 5)!.x, lo = Infinity, hi = 0;
    for (let t = 110; t <= 250; t += 10) { const x = b.avgAt(t, 100, 5)!.x; lo = Math.min(lo, x - prev); hi = Math.max(hi, x - prev); prev = x; }
    // raw lerp alternates 0 and 0.052 m per 10 ms; the filtered steps stay near the mean 0.026
    expect(lo).toBeGreaterThan(0.015);
    expect(hi).toBeLessThan(0.04);
  });
  it('is null when empty', () => { expect(new InterpBuffer().avgAt(0, 100, 5)).toBeNull(); });
});

describe('PlaybackClock', () => {
  it('snaps to newest − lead on the first sample and runs at local rate when the lead holds', () => {
    const c = new PlaybackClock(100);
    expect(c.advance(16, 1000)).toBe(true);
    expect(c.t).toBe(900);
    // newest advances with local time: the clock keeps a ~100 ms lead
    let newest = 1000;
    for (let i = 0; i < 300; i++) { newest += 16; expect(c.advance(16, newest)).toBe(false); }
    expect(newest - c.t).toBeGreaterThan(80);
    expect(newest - c.t).toBeLessThan(120);
  });
  it('stays behind the newest sample when the stamps run slow (ticks running long)', () => {
    const c = new PlaybackClock(100);
    let newest = 0;
    c.advance(16, newest);
    let minLead = Infinity;
    // samples arrive in 50 ms steps but only every 52 ms of local time (stamps fall 4% behind local time)
    for (let now = 0, next = 52; now < 20_000; now += 16) {
      if (now >= next) { newest += 50; next += 52; }
      c.advance(16, newest);
      if (now > 5000) minLead = Math.min(minLead, newest - c.t);
    }
    expect(minLead).toBeGreaterThan(0); // a fixed now − 100 clock would be ~20 s × 4% = 800 ms past the newest sample
  });
  it('changes rate by at most −maxRate / +3×maxRate', () => {
    const behind = new PlaybackClock(100), ahead = new PlaybackClock(100);
    behind.advance(16, 0); ahead.advance(16, 0);
    // a sample 1 s newer (behind by 1 s): ≤ 1.3× local rate
    const b0 = behind.t; for (let i = 0; i < 10; i++) behind.advance(16, 1000);
    expect((behind.t - b0) / 160).toBeLessThanOrEqual(1.3 + 1e-9);
    expect((behind.t - b0) / 160).toBeGreaterThan(1);
    // no new samples: lead shrinks, clock slows to ≥ 0.9× local rate
    const a0 = ahead.t; for (let i = 0; i < 60; i++) ahead.advance(16, 0); // < snapMs, so no snap back
    expect((ahead.t - a0) / 960).toBeGreaterThanOrEqual(0.9 - 1e-9);
    expect((ahead.t - a0) / 960).toBeLessThan(1);
  });
  it('snaps when more than snapMs off, ignores an empty buffer', () => {
    const c = new PlaybackClock(100);
    expect(c.advance(16, -Infinity)).toBe(false);
    expect(Number.isNaN(c.t)).toBe(true);
    c.advance(16, 0);
    expect(c.advance(16, 5000)).toBe(true);
    expect(c.t).toBe(4900);
  });
});

describe('StepSmoother', () => {
  it('snaps on the first call and on far jumps', () => {
    const s = new StepSmoother();
    expect(s.step(3, 4, 0.016, 2.6)).toBe(true);
    expect([s.x, s.z]).toEqual([3, 4]);
    expect(s.step(3, 7, 0.016, 2.6)).toBe(true);
    expect(s.z).toBe(7);
  });
  it('caps each step at k × v (and at least floor) m/s', () => {
    const s = new StepSmoother(1.3, 1);
    s.step(0, 0, 0, 0);
    s.step(1, 0, 0.1, 2.6);
    expect(s.x).toBeCloseTo(0.338);
    s.step(1, 0, 0.1, 0); // v 0 → floor 1 m/s
    expect(s.x).toBeCloseTo(0.438);
    s.step(0.45, 0, 0.1, 2.6); // within the cap: lands exactly
    expect(s.x).toBe(0.45);
  });
  it('clamps the reference speed at maxV: a bunched-tick 6.2 m/s reading still steps ≤ 1.3 × run', () => {
    const s = new StepSmoother(1.3, 1, 2, 4.6);
    s.step(0, 0, 0, 0);
    s.step(1, 0, 0.033, 6.16); // #184 trace: 0.267 m in a 33 ms frame (8.1 m/s) chasing a 6.16 m/s sampled speed
    expect(s.x).toBeCloseTo(1.3 * 4.6 * 0.033);
    s.step(1, 0, 0.1, 2.6); // below maxV nothing changes
    expect(s.x).toBeCloseTo(1.3 * 4.6 * 0.033 + 0.338);
  });
  it('reset makes the next step snap', () => {
    const s = new StepSmoother();
    s.step(0, 0, 0, 0); s.reset();
    expect(s.step(1.5, 0, 0.016, 0)).toBe(true);
    expect(s.x).toBe(1.5);
  });
});

// The review's case: the sender moves per frame and sends every ≥ 50 ms; the server (ticks ~52 ms) keeps the last
// position it got, so some ticks repeat and the next one carries two steps. Rendered the way game.ts does it.
describe('remote walk pipeline', () => {
  it('renders a walk (SPEED.walk) with per-frame speed < 2× and < 10% still frames', () => {
    const WALK = SPEED.walk, buf = new InterpBuffer(), clock = new PlaybackClock(100), sm = new StepSmoother();
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    // sender: frames of 14–24 ms, sends on the first frame ≥ 50 ms after the previous send
    const sends: [number, number][] = [];
    for (let t = 0, last = -1e9; t < 6000; t += 14 + 10 * rnd()) if (t - last >= 50) { sends.push([t, (t / 1000) * WALK]); last = t; }
    // server: tick k at 52·k ms broadcasts the newest received position; stamps come out at 50 ms spacing
    const snaps: { at: number; t: number; x: number }[] = [];
    for (let k = 0, i = -1; k * 52 < 6000; k++) {
      while (i + 1 < sends.length && sends[i + 1][0] + 5 * rnd() <= k * 52) i++;
      snaps.push({ at: k * 52 + 20 + 15 * rnd(), t: k * 50, x: i < 0 ? 0 : sends[i][1] });
    }
    let si = 0, px = NaN, maxV = 0, zero = 0, n = 0;
    for (let now = 0; now < 6000; now += 1000 / 60) {
      while (si < snaps.length && snaps[si].at <= now) { buf.push(smp(snaps[si].t, snaps[si].x)); si++; }
      const dt = 1 / 60;
      const fresh = clock.advance(dt * 1000, buf.lastT());
      const rt = clock.t = Math.min(clock.t, buf.lastT() + 100);
      if (Number.isNaN(rt)) continue;
      const g = buf.avgAt(rt, 100, 5, 100, 6)!;
      if (fresh) sm.reset();
      sm.step(g.x, g.z, dt, buf.paceSpeed());
      if (now > 1500 && now < 5500) { const v = Math.abs(sm.x - px) / dt; maxV = Math.max(maxV, v); if (v < 1e-3) zero++; n++; }
      px = sm.x;
    }
    expect(maxV).toBeLessThan(2 * WALK);
    expect(zero / n).toBeLessThan(0.1);
  });
});

describe('frameSlices', () => {
  const sum = (a: [number, number][], i: 0 | 1) => a.reduce((s, x) => s + x[i], 0);
  it('passes a normal frame through as one slice with rdt = dt', () => {
    expect(frameSlices(0.016)).toEqual([[0.016, 0.016]]);
  });
  it('cuts the local sim at 0.3 s in ≤ 0.1 s slices but gives the playback the real time (≤ 1 s)', () => {
    const a = frameSlices(0.4);
    expect(a.length).toBe(3);
    expect(sum(a, 0)).toBeCloseTo(0.3, 9);
    expect(sum(a, 1)).toBeCloseTo(0.4, 9);
    for (const [dt] of a) expect(dt).toBeLessThanOrEqual(0.1 + 1e-12);
    expect(sum(frameSlices(5), 1)).toBeCloseTo(1, 9);
  });
  it('a negative or zero gap is one empty slice', () => {
    expect(frameSlices(-1)).toEqual([[0, 0]]);
    expect(frameSlices(0)).toEqual([[0, 0]]);
  });
});

describe('remote playback under sustained slow frames (#201: gate load, B at ~2 fps)', () => {
  // game.ts's remote path: run straight at SPEED.run (6 m/s), a sample every 50 ms, B draws a frame every 500 ms (the gate's top
  // rows had 300–600 ms frames for seconds). On the clamped 0.3 s the clock's ≤ +30 % catch-up still covers 400 ms
  // frames; at 500 it falls behind until it snaps 1.5 s, and sm with it
  const run = (real: boolean) => {
    const buf = new InterpBuffer(), clock = new PlaybackClock(100), sm = new StepSmoother(1.3, 1, 4, SPEED.run);
    let send = 0, x = 0, max = 0, snaps = 0;
    for (let now = 0; now < 15000; now += 500) {
      for (; send <= now; send += 50) buf.push(smp(send, (send / 1000) * SPEED.run));
      for (const [dt, rdt] of frameSlices(0.5)) {
        const step = real ? rdt : dt;
        if (clock.advance(step * 1000, buf.lastT()) && now > 0) { snaps++; sm.reset(); }
        clock.t = Math.min(clock.t, buf.lastT() + 100);
        const g = buf.avgAt(clock.t, 100, 5, 100, 6)!;
        sm.step(g.x, g.z, step, buf.paceSpeed());
      }
      if (now > 0) max = Math.max(max, Math.abs(sm.x - x));
      x = sm.x;
    }
    return { max, snaps };
  };
  it('on real time it keeps up: no snap, each frame steps ≤ 1.3 × SPEED.run × 0.5 s', () => {
    const r = run(true);
    expect(r.snaps).toBe(0);
    expect(r.max).toBeLessThanOrEqual(1.3 * SPEED.run * 0.5 + 1e-6);
  });
  it('on the clamped 0.3 s it fell behind until the clock snapped and the body leapt ≥ 4 m (the bug)', () => {
    const r = run(false);
    expect(r.snaps).toBeGreaterThan(0);
    expect(r.max).toBeGreaterThan(4);
  });
});

describe('remote snapshot stall then batch (#202: gate x-lowfps-remote, B leapt 4.99 m in one ~250 ms frame)', () => {
  it('PlaybackClock stops at maxT and its lead filter sees the clamped t, so it recovers sooner after the stall', () => {
    const run = (clampInside: boolean) => {
      const c = new PlaybackClock(100);
      c.advance(16, 0);
      for (let i = 0; i < 2; i++) { c.advance(1000, 0, clampInside ? 100 : Infinity); c.t = Math.min(c.t, 100); } // 1 s frames, no samples
      expect(c.t).toBe(100);
      const t0 = c.t;
      for (let i = 1; i <= 10; i++) { c.advance(100, 100 + i * 100, clampInside ? 200 + i * 100 : Infinity); c.t = Math.min(c.t, 200 + i * 100); }
      return c.t - t0;
    };
    // the old feed read the 1 s frame as the clock ~900 ms past the newest sample and stayed slowed longer
    expect(run(true)).toBeGreaterThan(run(false) + 5);
  });
  it('StepSmoother.catchUp slides a gap past snapDist at 1.5× the cap until caught up, then snaps far jumps again', () => {
    const s = new StepSmoother(1.3, 1, 4, 4.6);
    s.catchUp(); // nothing to catch up from before the first step
    expect(s.step(0, 0, 0, 0)).toBe(true);
    s.catchUp();
    expect(s.step(5, 0, 0.25, 2.6)).toBe(false);
    expect(s.x).toBeCloseTo(1.5 * 1.3 * 2.6 * 0.25);
    while (s.x < 5) expect(s.step(5, 0, 0.25, 2.6)).toBe(false);
    expect(s.step(10, 0, 0.25, 2.6)).toBe(true); // caught up: a 5 m jump is a teleport again
    s.catchUp();
    expect(s.step(23, 0, 0.25, 2.6)).toBe(true); // beyond catchDist (3 × snapDist) it snaps anyway
  });
  it('game.ts remote path: 2 s without snapshots, then the batch, at ~4 fps: every frame within 1.5 × SPEED.walk · dt + 0.84', () => {
    const buf = new InterpBuffer(), clock = new PlaybackClock(100), sm = new StepSmoother(1.3, 1, 4, SPEED.run);
    let send = 0, prev = NaN, maxEx = -Infinity, frames = 0;
    for (let now = 0; now < 8000; now += 250) {
      for (; send <= now; send += 50) if (now < 1500 || now >= 3500) buf.push(smp(send, Math.min(6, (send / 1000) * SPEED.walk)));
      for (const [, rdt] of frameSlices(0.25)) {
        const first = Number.isNaN(clock.t);
        const fresh = clock.advance(rdt * 1000, buf.lastT(), buf.lastT() + 100);
        if (!Number.isFinite(clock.t)) continue;
        const g = buf.avgAt(clock.t, 100, 5, 100, 6)!;
        if (fresh) { if (first) sm.reset(); else sm.catchUp(); }
        sm.step(g.x, g.z, rdt, buf.paceSpeed());
      }
      if (!Number.isNaN(prev)) { maxEx = Math.max(maxEx, Math.abs(sm.x - prev) - 1.5 * SPEED.walk * 0.25); frames++; }
      prev = sm.x;
    }
    expect(frames).toBeGreaterThan(20);
    expect(sm.x).toBeCloseTo(6);
    expect(maxEx).toBeLessThan(0.5 + SPEED.walk * 0.1);
  });
});

describe('bursty sender (#203: gate x-rubber, B saw A leap 4.02 m in one 17 ms frame)', () => {
  // A's page under gate load hitches: a fresh position only every ~500 ms (3 m at a 6 m/s run), the server ticks
  // repeat it in between. speed() over the newest 300 ms reads 0 through the last 200 ms of each hold, the cap drops to
  // the 1 m/s floor, and on average the body ran slower than A: it fell further behind every burst until the gap passed
  // snapDist and it snapped 4 m in one frame.
  const run = () => {
    const buf = new InterpBuffer(), clock = new PlaybackClock(100), sm = new StepSmoother(1.3, 1, 4, SPEED.run);
    let send = 0, prev = NaN, max = 0, snaps = 0, lag = 0;
    for (let now = 0; now < 12000; now += 1000 / 60) {
      for (; send <= now; send += 50) buf.push(smp(send, Math.floor(send / 500) * 500 / 1000 * SPEED.run));
      const fresh = clock.advance(1000 / 60, buf.lastT(), buf.lastT() + 100);
      const g = buf.avgAt(clock.t, 100, 5, 100, 6)!;
      if (fresh && !Number.isNaN(prev)) sm.catchUp();
      if (sm.step(g.x, g.z, 1 / 60, buf.paceSpeed()) && !Number.isNaN(prev)) snaps++;
      if (!Number.isNaN(prev)) max = Math.max(max, Math.abs(sm.x - prev));
      lag = Math.max(lag, Math.abs(g.x - sm.x));
      prev = sm.x;
    }
    return { max, snaps, lag, end: sm.x };
  };
  it('the body keeps up: no snap, the gap stays < 2.5 m, each 17 ms frame ≤ 1.3 × run speed', () => {
    const r = run();
    expect(r.snaps).toBe(0);
    expect(r.lag).toBeLessThan(2.5);
    expect(r.max).toBeLessThanOrEqual(1.3 * SPEED.run / 60 + 1e-6);
    expect(r.end).toBeGreaterThan(50);
  });
});
