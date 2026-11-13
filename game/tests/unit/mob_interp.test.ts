import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { EXTRAP_MAX_MS, EXTRAP_MAX_SPEED, TICK_MS } from '../../shared/constants.ts';
import { WARDEN_CHASE_SPEED, WARDEN_PATROL_SPEED } from '../../server/ai/warden.ts';
import { MONITOR_SPEED } from '../../server/ai/monitor.ts';
import { frameSlices, SnapClock } from '../../client/src/interp.ts';

// the 值日生 paints its textures on canvases: a 2D context that swallows every call is enough here
const ctx2d: any = new Proxy(function () {}, { get: (_, k) => (k === 'measureText' ? () => ({ width: 1 }) : ctx2d), apply: () => ctx2d, set: () => true });
vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) });
const { Mobs } = await import('../../client/src/mobs.ts');

// probe-mob.mjs (#181) on real ws: server ticks ~52 ms with a uniform step per tick, arrivals 0–300 ms apart.
// Stamped by SnapClock and rendered by Mobs.update the way Game.frame does it.
function run(id: number, speed: number, anim: string, onFrame?: (mobs: InstanceType<typeof Mobs>, now: number) => void) {
  const mobs = new Mobs(new THREE.Scene()), clock = new SnapClock(TICK_MS);
  let seed = 11; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const snaps: { at: number; tick: number; x: number }[] = [];
  for (let k = 0, at = 0; k * 52 < 8000; k++) {
    // in order (one ws), 20–35 ms latency, and every ~2 s a 250 ms hiccup that lands a burst of ticks at once
    at = Math.max(at, k * 52 + 20 + 15 * rnd() + (k % 40 >= 35 ? 250 - (k % 40 - 35) * 52 : 0));
    snaps.push({ at, tick: k, x: ((k * 52) / 1000) * speed });
  }
  const dt = 1 / 60, xs: [number, number][] = [];
  for (let now = 0, si = 0; now < 8000; now += 1000 * dt) {
    while (si < snaps.length && snaps[si].at <= now) {
      const s = snaps[si++];
      mobs.onSnap([{ id, anim, p: [s.x, 0, 0], yaw: Math.PI / 2 }], clock.stamp(s.tick, now));
    }
    onFrame?.(mobs, now);
    mobs.update(now, dt);
    const o = mobs.byId.get(id);
    if (o) xs.push([now, o.mesh.position.x]);
  }
  return xs;
}

/** Per-frame speeds over 1.5–7.5 s (past the first-sample snap, before the samples run out). */
const speeds = (xs: [number, number][]) => {
  const v: number[] = [];
  for (let k = 1; k < xs.length; k++) if (xs[k][0] > 1500 && xs[k][0] < 7500) v.push(Math.abs(xs[k][1] - xs[k - 1][1]) * 60);
  return v;
};

/** Replay the real onSnap → playback clock → filter → smoother path, including Game.frame's real-time slices. */
function replay(frameMs: number, durationMs: number, position: (t: number) => number, deliver = (_t: number) => true) {
  const mobs = new Mobs(new THREE.Scene());
  let send = 0, previous = 0, maxStep = 0, maxLag = 0, maxStillMs = 0, stillMs = 0, snaps = 0, tailTravel = 0;
  for (let now = 0; now <= durationMs; now += frameMs) {
    if (deliver(now)) for (; send <= now; send += TICK_MS) {
      mobs.onSnap([{ id: 1, anim: 'walk', p: [position(send), 0, 0], yaw: Math.PI / 2 }], send);
    }
    const o = mobs.byId.get(1)!;
    if (now === 0) {
      const step = o.sm.step.bind(o.sm);
      let rendered = false;
      vi.spyOn(o.sm, 'step').mockImplementation((...args) => {
        const jumped = step(...args);
        if (jumped && rendered) snaps++;
        rendered = true;
        return jumped;
      });
    }
    for (const [, rdt] of frameSlices(frameMs / 1000)) mobs.update(now, rdt);
    const x = o.mesh.position.x;
    if (now > 1500) {
      const step = Math.abs(x - previous);
      maxStep = Math.max(maxStep, step);
      stillMs = step < 1e-6 ? stillMs + frameMs : 0;
      maxStillMs = Math.max(maxStillMs, stillMs);
      if (now > durationMs - 1000) tailTravel += step;
      const target = o.buf.avgAt(o.clock.t, 2 * TICK_MS, 5, EXTRAP_MAX_MS, EXTRAP_MAX_SPEED)!;
      maxLag = Math.max(maxLag, Math.abs(target.x - x));
    }
    previous = x;
  }
  return { maxStep, maxLag, maxStillMs, snaps, end: previous, tailTravel };
}

describe('mob playback', () => {
  for (const visible of [false, true]) {
    it(`${visible ? 'slides a visible' : 'places an unseen'} 角色074 after a long snapshot backlog`, () => {
      const mobs = new Mobs(new THREE.Scene()), speed = WARDEN_PATROL_SPEED;
      let frame = 0;
      const snapshot = (tick: number) => mobs.onSnap([{ id: 1, anim: 'patrol',
        p: [tick * TICK_MS / 1000 * speed, 0, 0], yaw: Math.PI / 2 }], tick * TICK_MS);
      for (let tick = 0; tick <= 20; tick++) {
        snapshot(tick);
        for (; frame <= tick * TICK_MS; frame += 10) mobs.update(frame, .01);
      }
      const mob = mobs.byId.get(1)!, before = mob.mesh.position.x;
      // The renderer stalls for three seconds while ordered WS snapshots accumulate. On resume the playback clock
      // snaps forward; the authoritative moves themselves remain ordinary patrol steps, never a teleport.
      for (let tick = 21; tick <= 80; tick++) snapshot(tick);
      mob.mesh.visible = visible; // the previous frame's real visibility, also false while an intro covers the world
      mobs.update(4000, .05);
      const target = mob.buf.avgAt(mob.clock.t, 2 * TICK_MS, 5, EXTRAP_MAX_MS, EXTRAP_MAX_SPEED)!;
      if (visible) {
        expect(mob.mesh.position.x - before).toBeGreaterThan(0);
        expect(mob.mesh.position.x - before).toBeLessThanOrEqual(1.5 * 1.3 * speed * .05 + 1e-9);
        expect(target.x - mob.mesh.position.x).toBeGreaterThan(3);
      } else {
        expect(mob.mesh.position.x).toBeCloseTo(target.x, 9);
        // Entering the view on the following frame must not reveal or repay a position debt from the hidden frame.
        const placed = mob.mesh.position.x;
        mob.mesh.visible = true; snapshot(81); mobs.update(4050, .05);
        expect(mob.mesh.position.x - placed).toBeLessThanOrEqual(1.3 * speed * .05 + 1e-9);
        expect(mob.mesh.position.x).toBeCloseTo(mob.buf.avgAt(mob.clock.t, 2 * TICK_MS, 5,
          EXTRAP_MAX_MS, EXTRAP_MAX_SPEED)!.x, 9);
      }
    });
  }
  it('keeps up when slow frames miss each burst\'s 300 ms speed window', () => {
    // Position updates occur at :150/:650, while frames occur at :000/:500. Every frame sees 350 ms of repeated
    // positions, so the newest 300 ms read 0 despite a sustained patrol pace. Each burst stays below TELEPORT_M.
    const speed = WARDEN_PATROL_SPEED;
    const result = replay(500, 12_000, (t) => Math.floor(Math.max(0, t - 150) / 500) * 0.5 * speed);
    console.info('bursty mob playback', result);
    expect(result.maxStep).toBeLessThanOrEqual(1.3 * speed * 0.5 + 1e-6);
    expect(result.snaps).toBe(0);
    expect(result.maxLag).toBeLessThan(2);
    expect(result.maxStillMs).toBe(0);
    const destination = Math.floor((12_000 - 150) / 500) * 0.5 * speed;
    expect(result.end).toBeCloseTo(destination, 6);
  });
  it('resumes a snapshot backlog at 4 fps within the catch-up speed and reaches the stopped mob', () => {
    // The server keeps moving and its ordered ticks arrive together after a 2 s delivery gap. No individual tick
    // teleports: this is a playback-clock correction, so the existing visual position must survive it.
    const speed = 2;
    const result = replay(250, 8000, (t) => Math.min(8, t / 1000 * speed), (t) => t < 2000 || t >= 4000);
    console.info('stalled mob playback', result);
    expect(result.maxStep).toBeLessThanOrEqual(1.5 * 1.3 * speed * 0.25 + 1e-6);
    expect(result.snaps).toBe(0);
    expect(result.end).toBeCloseTo(8, 6);
  });
  it('settles onto a stopped mob as the old moving pace expires', () => {
    const result = replay(1000 / 60, 5000, (t) => Math.min(3, t / 1000 * 2));
    console.info('stopped mob playback', result);
    expect(result.snaps).toBe(0);
    expect(result.end).toBeCloseTo(3, 9);
    expect(result.maxLag).toBeLessThan(0.1);
    expect(result.tailTravel).toBe(0);
  });
  for (const [name, id, speed, anim] of [['角色074 chase', 1, WARDEN_CHASE_SPEED, 'chase'], ['值日生 run', 2, MONITOR_SPEED, 'run']] as const) {
    it(`renders a ${name} at ${speed} m/s with per-frame speed < 2× and < 5% still frames`, () => {
      const v = speeds(run(id, speed, anim));
      expect(Math.max(...v)).toBeLessThan(2 * speed);
      expect(v.filter((s) => s < 1e-3).length / v.length).toBeLessThan(0.05);
    });
  }
  it('still drops the 值日生 straight onto its newest server position during a blink', () => {
    const mobs = new Mobs(new THREE.Scene());
    let t = 0;
    for (let k = 0; k < 40; k++) {
      mobs.onSnap([{ id: 2, anim: 'run', p: [k * 0.3, 0, 0], yaw: 0 }], k * TICK_MS);
      for (; t < (k + 1) * TICK_MS; t += 16) mobs.update(t, 0.016);
    }
    const o = mobs.byId.get(2)!;
    expect(o.mesh.position.x).toBeLessThan(39 * 0.3 - 0.3); // playing back ~100 ms behind the newest
    mobs.blink(t, 0.5);
    mobs.update(t + 16, 0.016);
    expect(o.mesh.position.x).toBeCloseTo(39 * 0.3, 9); // the screen is black: no glide, straight onto the newest sample
    // the jump does not glide: a new sample during the blink is taken at once too
    mobs.onSnap([{ id: 2, anim: 'run', p: [9, 0, 0], yaw: 0 }], 40 * TICK_MS);
    mobs.update(t + 32, 0.016);
    expect(o.mesh.position.x).toBe(9);
  });
  it('pops a teleported 角色074 in one frame instead of streaking it through the box filter', () => {
    const mobs = new Mobs(new THREE.Scene());
    let t = 0;
    const tick = (k: number, x: number) => {
      mobs.onSnap([{ id: 1, anim: 'chase', p: [x, 0, 0], yaw: 0 }], k * TICK_MS);
      for (; t < (k + 1) * TICK_MS; t += 16) mobs.update(t, 0.016);
    };
    for (let k = 0; k < 30; k++) tick(k, k * 0.18);
    const xs: number[] = [];
    for (let k = 30; k < 50; k++) { tick(k, 60 + k * 0.18); xs.push(mobs.byId.get(1)!.mesh.position.x); }
    // every rendered x sits on one side of the 55 m gap or the other: nothing in between
    expect(xs.filter((x) => x > 6 && x < 60)).toEqual([]);
    expect(xs[xs.length - 1]).toBeGreaterThan(60);
  });
});
