import { describe, expect, it } from 'vitest';
import { InterpBuffer, PlaybackClock, SnapClock, StepSmoother, frameSlices } from '../../client/src/interp.ts';
import { EXTRAP_MAX_MS, EXTRAP_MAX_SPEED, INTERP_DELAY_MS, SPEED, TICK_MS } from '../../shared/constants.ts';
import metalCapture from '../fixtures/metal-lowfps-authority.json';
import backlogCapture from '../fixtures/metal-backlog-arrivals.json';
import playbackCapture from '../fixtures/metal-backlog-playback.json';

describe('SnapClock backlog replay', () => {
  it('keeps all 22 initial queued ticks in order and at their original spacing', () => {
    // Audit reproduction: the legacy clock snapped its offset down by 1050 ms
    // on the last tick of this batch, putting it 1000 ms before its predecessor.
    const clock = new SnapClock(50);
    const stamps = Array.from({ length: 22 }, (_, tick) => clock.stamp(tick, 2000));
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i] - stamps[i - 1], `queued tick ${i}`).toBe(50);
    }
  });

  it('starts a fresh clock on a recorded 29-snapshot backlog, preserving order and retiring offset debt', () => {
    // A fresh clock models join/load delivery. The captured observer already
    // had a warm clock, which stayed monotone during this actual browser run.
    const clock = new SnapClock(TICK_MS), firstTick = backlogCapture.arrivals[0][1];
    const delays: number[] = [];
    let previous = -Infinity, offsetDebt = Infinity, recoveredAt = Infinity;
    let clearSince = NaN, longestClearMs = 0;
    expect(backlogCapture.burstCount).toBeGreaterThanOrEqual(22);
    const burst = backlogCapture.arrivals.slice(0, backlogCapture.burstCount);
    expect(burst.at(-1)![1] - firstTick).toBe(backlogCapture.burstCount - 1);
    expect(burst.at(-1)![0] - burst[0][0]).toBeLessThan(50);
    for (const [now, sourceTick] of backlogCapture.arrivals) {
      const tick = sourceTick - firstTick, stamp = clock.stamp(tick, now);
      expect(stamp, `recorded tick ${sourceTick} at ${now}`).toBeGreaterThan(previous);
      previous = stamp;
      delays.push(now - tick * TICK_MS);
      if (delays.length > SnapClock.WINDOW) delays.shift();
      // Startup debt is excess offset above the least-delayed arrival. A later
      // increase in transport delay is tracked separately by normal upward slew.
      offsetDebt = Math.max(0, stamp - tick * TICK_MS - Math.min(...delays));
      if (sourceTick >= firstTick + backlogCapture.burstCount - 1 && offsetDebt < 60 && recoveredAt === Infinity) recoveredAt = now;
      if (sourceTick >= firstTick + backlogCapture.burstCount - 1 && offsetDebt < 1e-6) {
        if (Number.isNaN(clearSince)) clearSince = now;
        longestClearMs = Math.max(longestClearMs, now - clearSince);
      } else clearSince = NaN;
    }
    // The initial backlog must retire within this recorded 6 s tail. All rows
    // remain in the monotonicity check, including its final same-time delivery
    // of three ticks: that new burst creates fresh debt with no later arrival
    // available to measure recovery, so it cannot establish a steady end lag.
    expect(recoveredAt - backlogCapture.arrivals[0][0]).toBeLessThan(6000);
    expect(longestClearMs).toBeGreaterThanOrEqual(500);
  });

  it('replays measured Metal motion at its original slow frame cadence with ordered stamps and bounded recovery', () => {
    const stamps = new SnapClock(TICK_MS), buf = new InterpBuffer();
    const playback = new PlaybackClock(INTERP_DELAY_MS), sm = new StepSmoother(1.3, 1, 4, SPEED.run);
    let at = 0, previousStamp = -Infinity, previousNow = 0, previousX = NaN;
    let maxExcess = -Infinity, movingFrames = 0, totalDistance = 0, recoveryAt = Infinity;
    const recentDelays: number[] = [];
    let offsetDebt = Infinity;
    // Positions and frame boundaries came from the Metal capture. Delivery at the
    // next frame is deliberately synthetic: the original audit omitted arrivals.
    for (const [now, newestTick] of metalCapture.frames) {
      let previousInBatch = NaN;
      while (at < metalCapture.positions.length && metalCapture.positions[at][0] <= newestTick) {
        const [tick, x, y, z] = metalCapture.positions[at++];
        const t = stamps.stamp(tick, now);
        recentDelays.push(now - tick * TICK_MS);
        if (recentDelays.length > SnapClock.WINDOW) recentDelays.shift();
        expect(t, `tick ${tick} at ${now}`).toBeGreaterThan(previousStamp);
        if (Number.isFinite(previousInBatch)) expect(t - previousInBatch).toBeCloseTo(TICK_MS, 8);
        previousStamp = previousInBatch = t;
        buf.push({ t, x, y, z, yaw: 0 });
      }
      const elapsedS = (now - previousNow) / 1000;
      for (const [, rdt] of frameSlices(elapsedS)) {
        const first = Number.isNaN(playback.t);
        const fresh = playback.advance(rdt * 1000, buf.lastT(), buf.lastT() + EXTRAP_MAX_MS);
        const goal = buf.avgAt(playback.t, 2 * TICK_MS, 5, EXTRAP_MAX_MS, EXTRAP_MAX_SPEED)!;
        if (fresh) { if (first) sm.reset(); else sm.catchUp(); }
        sm.step(goal.x, goal.z, rdt, buf.paceSpeed());
      }
      if (Number.isFinite(previousX)) {
        const step = Math.abs(sm.x - previousX);
        // Apply the physical catch-up budget to every captured frame. No fixed
        // distance allowance and no frame exclusions can hide a clock jump.
        maxExcess = Math.max(maxExcess, step - 1.5 * SPEED.walk * elapsedS);
        totalDistance += step;
        if (step > .005) movingFrames++;
      }
      // The clock follows the least-delayed arrival, so current receive time can
      // legitimately be later than its stamp. Measure outstanding offset debt
      // against that observable target, rather than conflating it with jitter.
      offsetDebt = Math.abs(buf.lastT() - newestTick * TICK_MS - Math.min(...recentDelays));
      if (recoveryAt === Infinity && offsetDebt <= 60) recoveryAt = now;
      previousNow = now; previousX = sm.x;
    }
    expect(at).toBe(metalCapture.positions.length);
    expect(movingFrames).toBeGreaterThan(25);
    expect(totalDistance).toBeGreaterThan(30);
    expect(maxExcess).toBeLessThanOrEqual(1e-6);
    // With exact 50 ms spacing within each batch, only the first tick of each
    // 300–430 ms frame can retire offset debt. This measured cadence needs a
    // longer, explicit recovery bound than normally delivered 20 Hz snapshots.
    expect(recoveryAt).toBeLessThanOrEqual(12_000);
    expect(offsetDebt).toBeLessThan(60);
    expect(Math.abs(sm.x - metalCapture.positions.at(-1)![1])).toBeLessThan(1.5);
  });

  it('replays exact recorded arrivals through the full playback chain in their callback order', () => {
    const stamps = new SnapClock(TICK_MS), buf = new InterpBuffer();
    const playback = new PlaybackClock(INTERP_DELAY_MS), sm = new StepSmoother(1.3, 1, 4, SPEED.run);
    let at = 0, previousStamp = -Infinity, previousFrame = playbackCapture.frames[0][0];
    let previousPosition: { x: number; z: number } | null = null;
    let totalDistance = 0, movingFrames = 0, maxExcess = -Infinity, initialized = false;
    const receiveThrough = (count: number) => {
      expect(count).toBeGreaterThanOrEqual(at);
      expect(count).toBeLessThanOrEqual(playbackCapture.arrivals.length);
      while (at < count) {
        const [now, tick, x, y, z] = playbackCapture.arrivals[at++];
        const t = stamps.stamp(tick, now);
        expect(t, `recorded arrival ${at}, tick ${tick}`).toBeGreaterThan(previousStamp);
        previousStamp = t;
        buf.push({ t, x, y, z, yaw: 0 });
      }
    };
    expect(playbackCapture.burstCount).toBeGreaterThanOrEqual(22);
    for (const [frameT, arrivalCount] of playbackCapture.frames) {
      // rAF's timestamp can predate messages handled before its callback.
      // The recorded count identifies the exact prefix the actual frame saw.
      receiveThrough(arrivalCount);
      const elapsedS = (frameT - previousFrame) / 1000;
      expect(elapsedS).toBeGreaterThanOrEqual(0);
      for (const [, rdt] of frameSlices(elapsedS)) {
        const first = Number.isNaN(playback.t);
        const fresh = playback.advance(rdt * 1000, buf.lastT(), buf.lastT() + EXTRAP_MAX_MS);
        const goal = buf.avgAt(playback.t, 2 * TICK_MS, 5, EXTRAP_MAX_MS, EXTRAP_MAX_SPEED)!;
        if (fresh) { if (first) sm.reset(); else sm.catchUp(); }
        const snapped = sm.step(goal.x, goal.z, rdt, buf.paceSpeed());
        if (initialized) expect(snapped, `frame ${frameT}: unexpected position snap`).toBe(false);
        initialized = true;
      }
      if (previousPosition) {
        const distance = Math.hypot(sm.x - previousPosition.x, sm.z - previousPosition.z);
        maxExcess = Math.max(maxExcess, distance - 1.5 * SPEED.walk * elapsedS);
        totalDistance += distance;
        if (distance > .005) movingFrames++;
      }
      previousPosition = { x: sm.x, z: sm.z };
      previousFrame = frameT;
    }
    // Keep any messages after the last captured frame in the ordering check;
    // inventing a recovery/render frame would overstate the evidence.
    receiveThrough(playbackCapture.arrivals.length);
    expect(movingFrames).toBeGreaterThan(12);
    expect(totalDistance).toBeGreaterThan(10);
    expect(maxExcess).toBeLessThan(.84); // original safety threshold, every captured frame included
    const last = playbackCapture.arrivals.at(-1)!;
    expect(Math.hypot(sm.x - last[2], sm.z - last[4])).toBeLessThan(1.5);
  });
});
