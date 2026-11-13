import { describe, expect, it } from 'vitest';
import { InterpBuffer, SnapClock } from '../../client/src/interp.ts';

describe('SnapClock', () => {
  it('keeps tick spacing for snapshots received in one batch', () => {
    const c = new SnapClock(50);
    const a = c.stamp(1, 1000), b = c.stamp(2, 1000), d = c.stamp(3, 1000);
    expect(b - a).toBe(50);
    expect(d - b).toBe(50);
  });
  it('interpolates smoothly across a stalled-then-batched arrival', () => {
    const c = new SnapClock(50), buf = new InterpBuffer();
    for (const [tick, now] of [[0, 0], [1, 50], [2, 400], [3, 400]]) buf.push({ t: c.stamp(tick, now), x: tick, y: 0, z: 0, yaw: 0 });
    expect(buf.at(75)!.x).toBeCloseTo(1.5);
  });
  // Measured on the real server: setInterval(50) steps every ~50.66 ms, so arrivals drift 1.3% later than tick*50.
  // The old min-only offset never rose, and the newest stamp fell ~24 ms/s behind arrival (1.5 s after a minute).
  it('follows a server whose ticks run long instead of falling further behind every second', () => {
    const c = new SnapClock(50);
    let lag = 0, spacingMin = Infinity, spacingMax = 0, prev = NaN;
    for (let tick = 0; tick <= 20 * 120; tick++) {
      const now = 1000 + tick * 50.66 + 30 + ((tick * 7919) % 23); // 30 ms latency + 0..22 ms jitter
      const t = c.stamp(tick, now);
      lag = now - t;
      if (tick > 100) { spacingMin = Math.min(spacingMin, t - prev); spacingMax = Math.max(spacingMax, t - prev); }
      prev = t;
    }
    expect(lag).toBeLessThan(60);
    expect(lag).toBeGreaterThan(-5);
    expect(spacingMin).toBeGreaterThan(45);
    expect(spacingMax).toBeLessThan(56);
  });
  it('keeps the batch spacing after a stall longer than the window spans in time', () => {
    const c = new SnapClock(50);
    for (let tick = 0; tick < 40; tick++) c.stamp(tick, tick * 50 + 20);
    const ts = [];
    for (let tick = 40; tick < 70; tick++) ts.push(c.stamp(tick, 69 * 50 + 20)); // 1.5 s silence, then all at once
    for (let i = 1; i < ts.length; i++) expect(ts[i] - ts[i - 1]).toBe(50);
    expect(ts[ts.length - 1]).toBeCloseTo(69 * 50 + 20, 0);
  });
  it('slides down when arrivals get faster (latency drop) without collapsing spacing', () => {
    const c = new SnapClock(50);
    for (let tick = 0; tick < 40; tick++) c.stamp(tick, tick * 50 + 200);
    let t = 0, prev = c.stamp(40, 40 * 50 + 200);
    for (let tick = 41; tick < 80; tick++) {
      t = c.stamp(tick, tick * 50 + 20);
      expect(t - prev).toBeGreaterThanOrEqual(44);
      prev = t;
    }
    expect(79 * 50 + 20 - t).toBeCloseTo(0, 0);
  });
  // #208 measured: snapshots queued while the level loaded arrive in one burst, the clock snaps on the first of them
  // (delay ~1.4 s too high), then each later one is 50 ms less delayed; the offset was left 0.5–0.7 s high and took
  // 5–8 s to settle, so three clients drew the same 角色074 at different server times (0.3 m apart).
  it('settles within ~1.6 s after a load backlog burst, keeping every stamp monotone', () => {
    const c = new SnapClock(50);
    let prev = -Infinity;
    const at = (tick: number, now: number) => { const t = c.stamp(tick, now); expect(t).toBeGreaterThan(prev); prev = t; return now - t; };
    for (let tick = 0; tick < 28; tick++) at(tick, 1400 + Math.floor(tick / 14) * 2); // backlog: 1.4 s of ticks at once
    // Exact batch spacing leaves the last stamp near 2750 ms; it cannot also be below live now=2380 after 1 s.
    // The original 1 s check passed only because a negative hard snap made the timestamps inside the burst regress.
    let lag = 0;
    for (let tick = 28; tick < 28 + 32; tick++) lag = at(tick, tick * 50 + 30); // live: 30 ms latency, 1.6 s
    expect(lag).toBeLessThan(60);
    expect(lag).toBeGreaterThan(-5);
  });
  it('keeps stamps increasing when a long arrival gap advances only one server tick', () => {
    const c = new SnapClock(50);
    let prev = -Infinity;
    for (let tick = 0; tick <= 20; tick++) {
      const t = c.stamp(tick, 2000);
      expect(t).toBeGreaterThan(prev);
      prev = t;
    }
    const t = c.stamp(21, 2500);
    expect(t - prev).toBeGreaterThanOrEqual(5);
  });
  it('keeps fast settling available through a long backlog and repeated packet loss', () => {
    const c = new SnapClock(50);
    let prev = c.stamp(0, 10000);
    for (let tick = 1; tick < 200; tick++) {
      const t = c.stamp(tick, 10000);
      expect(t - prev).toBe(50);
      prev = t;
    }
    let lag = -Infinity;
    // Only one of every four live snapshots arrives. Tick progress, rather than snapshot count, pays down the offset.
    for (let tick = 200; tick <= 424; tick += 4) {
      const now = tick * 50 + 30, t = c.stamp(tick, now);
      expect(t - prev).toBeGreaterThanOrEqual(5);
      lag = now - t;
      prev = t;
    }
    expect(lag).toBeLessThan(60);
    expect(lag).toBeGreaterThan(-5);
  });
  it('retains unfinished settling across packet loss longer than the settling grace period', () => {
    const c = new SnapClock(50);
    let prev = -Infinity;
    for (let tick = 0; tick < 28; tick++) prev = c.stamp(tick, 1400);
    // The first 600 ms reduces the remaining debt below SNAP_MS, then 40 ticks are lost for another 2 s.
    for (let tick = 28; tick < 40; tick++) prev = c.stamp(tick, tick * 50 + 30);
    const now = 80 * 50 + 30, t = c.stamp(80, now);
    expect(t).toBeGreaterThan(prev);
    expect(now - t).toBeLessThan(60);
    expect(now - t).toBeGreaterThan(-5);
  });
  it('finishes settling under continuous six-to-nine-tick batches without changing spacing inside them', () => {
    const c = new SnapClock(50);
    let prev = c.stamp(0, 2000);
    for (let tick = 1; tick <= 21; tick++) prev = c.stamp(tick, 2000);
    let tick = 22, batch = 0, lag = -Infinity;
    // Only each batch's first arrival can reduce the offset while preserving its remaining exact tick spacing.
    // At most 9 ticks/batch gives 45 ms debt repayment per 450 ms, so 1050 ms clears within ceil(1050/45)*450 ms.
    while (tick < 22 + 20 * 11) {
      const count = 6 + batch++ % 4, now = 2000 + (tick + count - 1 - 21) * 50;
      for (let i = 0; i < count; i++, tick++) {
        const t = c.stamp(tick, now);
        expect(t - prev).toBeGreaterThanOrEqual(5);
        if (i > 0) expect(t - prev).toBe(50);
        prev = t;
      }
      lag = now - prev;
    }
    expect(lag).toBeLessThan(60);
    expect(lag).toBeGreaterThan(-5);
  });
  it('snaps on a huge offset change (reconnect / frozen tab) instead of slewing for seconds', () => {
    const c = new SnapClock(50);
    for (let tick = 0; tick < 40; tick++) c.stamp(tick, tick * 50 + 20);
    for (let tick = 40; tick < 80; tick++) c.stamp(tick, tick * 50 + 5000);
    expect(c.stamp(80, 80 * 50 + 5000)).toBeCloseTo(80 * 50 + 5000, 0);
  });
});

describe('InterpBuffer.lastT', () => {
  it('reports the newest sample time so the render clock can avoid running past it', () => {
    const buf = new InterpBuffer();
    expect(buf.lastT()).toBe(-Infinity);
    buf.push({ t: 10, x: 0, y: 0, z: 0, yaw: 0 });
    buf.push({ t: 60, x: 1, y: 0, z: 0, yaw: 0 });
    expect(buf.lastT()).toBe(60);
  });
});
