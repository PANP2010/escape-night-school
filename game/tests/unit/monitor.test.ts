import { describe, expect, it } from 'vitest';
import { CollisionWorld } from '../../shared/campus/collision.ts';
import { lineOfSight, NavGraph } from '../../shared/campus/nav.ts';
import { F_CROUCH, F_HIDE, type Vec3 } from '../../shared/protocol.ts';
import {
  BLINK_EVERY_S, BLINK_S, MONITOR_CATCH_R, MONITOR_HOLD_S, MONITOR_SPEED, MONITOR_START_DELAY_S, MonitorAI, seenBy, type MonitorEnv, type MonitorViewer,
} from '../../server/ai/monitor.ts';
import { RoomManager, type Conn } from '../../server/room.ts';
import { mulberry32 } from '../../shared/rng.ts';
import type { ServerMsg } from '../../shared/protocol.ts';
import { TICK_MS } from '../../shared/constants.ts';

const DT = 0.05;
const wallBox = (x0: number, x1: number, z0: number, z1: number) => ({ minX: x0, maxX: x1, minY: 0, maxY: 3, minZ: z0, maxZ: z1 });
/** A viewer at (x, z) looking toward -z (yaw 0) unless told otherwise. */
const viewer = (x: number, z: number, o: Partial<MonitorViewer> = {}): MonitorViewer => ({ id: 1, p: [x, 0, z], yaw: 0, f: 0, ...o });
const open = () => true;
const worldLos = (w: CollisionWorld) => (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => lineOfSight(w, a, b);

describe('seenBy (view cone + walls)', () => {
  it('sees a figure straight ahead and not one behind', () => {
    expect(seenBy(viewer(0, 0), [0, 0, -8], open)).toBe(true);
    expect(seenBy(viewer(0, 0), [0, 0, 8], open)).toBe(false);
  });

  it('uses the view cone: inside the half-angle yes, to the side no', () => {
    // 40° off the look direction at 8 m: inside (≈ 55°); 70°: outside
    const at = (deg: number): Vec3 => [-Math.sin((deg * Math.PI) / 180) * 8, 0, -Math.cos((deg * Math.PI) / 180) * 8];
    expect(seenBy(viewer(0, 0), at(40), open)).toBe(true);
    expect(seenBy(viewer(0, 0), at(-40), open)).toBe(true);
    expect(seenBy(viewer(0, 0), at(70), open)).toBe(false);
    expect(seenBy(viewer(0, 0), at(-70), open)).toBe(false);
  });

  it('follows yaw: turning toward it brings it into view', () => {
    expect(seenBy(viewer(0, 0, { yaw: Math.PI / 2 }), [-8, 0, 0], open)).toBe(true); // yaw +90° looks along -x
    expect(seenBy(viewer(0, 0, { yaw: -Math.PI / 2 }), [-8, 0, 0], open)).toBe(false);
  });

  it('is blocked by a wall in between, and open past its end', () => {
    const w = new CollisionWorld([wallBox(-2, 2, -5.1, -4.9)]);
    expect(seenBy(viewer(0, 0), [0, 0, -8], worldLos(w))).toBe(false);
    expect(seenBy(viewer(0, 0), [0, 0, -3], worldLos(w))).toBe(true); // in front of the wall
    expect(seenBy(viewer(6, 0), [6, 0, -8], worldLos(w))).toBe(true); // beside the wall
  });

  it('sees a figure when only its head clears a low obstacle', () => {
    const low = new CollisionWorld([{ minX: -2, maxX: 2, minY: 0, maxY: 1.2, minZ: -5.1, maxZ: -4.9 }]);
    expect(seenBy(viewer(0, 0), [0, 0, -8], worldLos(low))).toBe(true);
  });

  it('is limited by range, and a hidden viewer sees nothing', () => {
    expect(seenBy(viewer(0, 0), [0, 0, -60], open)).toBe(false);
    expect(seenBy(viewer(0, 0, { f: F_HIDE }), [0, 0, -3], open)).toBe(false);
  });

  it('counts pitch: looking straight up misses a figure ahead; crouching lowers the eye', () => {
    expect(seenBy(viewer(0, 0, { pitch: 1.4 }), [0, 0, -8], open)).toBe(false);
    const w = new CollisionWorld([{ minX: -2, maxX: 2, minY: 0, maxY: 1.3, minZ: -2.1, maxZ: -1.9 }]);
    expect(seenBy(viewer(0, 0), [0, 0, -8], worldLos(w))).toBe(true); // standing eye (1.6 m) looks over the 1.3 m box
    expect(seenBy(viewer(0, 0, { f: F_CROUCH }), [0, 0, -8], worldLos(w))).toBe(false); // crouching (1.0 m) does not
  });
});

/** Open floor, 60 m of corridor along -z; walls only where a test adds them. */
function corridor(walls: ReturnType<typeof wallBox>[] = []) {
  const g = new NavGraph();
  g.chain([{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -30 }, { x: 0, y: 0, z: -60 }]);
  const world = new CollisionWorld(walls);
  const env: MonitorEnv = { graph: g, los: worldLos(world) };
  return { g, world, env };
}
const ready = (ai: MonitorAI, players: MonitorViewer[]) => { for (let t = 0; t < MONITOR_START_DELAY_S + DT; t += DT) ai.step(DT, players.map((p) => ({ ...p, f: F_HIDE }))); };

describe('MonitorAI', () => {
  it('freezes while any player sees it, even if the others look away', () => {
    const { env } = corridor();
    const ai = new MonitorAI(env, [0, 0, -20]);
    const looking = viewer(0, 0, { id: 1 }), away = viewer(3, 0, { id: 2, yaw: Math.PI });
    ai.forceHunt([0, 0, -20], 0);
    const p0 = [...ai.p];
    for (let i = 0; i < 40; i++) ai.step(DT, [away, looking]);
    expect(ai.state).toBe('frozen');
    expect(ai.anim).toBe('freeze');
    expect(ai.p).toEqual(p0);
  });

  it('runs at 7.8 m/s toward the nearest player when nobody sees it', () => {
    const { env } = corridor();
    const ai = new MonitorAI(env, [0, 0, -30]);
    ai.forceHunt([0, 0, -30], 0);
    const near = viewer(0, 0, { id: 1, yaw: Math.PI }), far = viewer(0, 20, { id: 2, yaw: Math.PI });
    for (let i = 0; i < 20; i++) ai.step(DT, [far, near]); // 1 s
    expect(ai.state).toBe('chase');
    expect(MONITOR_SPEED).toBe(7.8);
    expect(ai.p[2]).toBeCloseTo(-30 + 7.8, 5);
    expect(ai.anim).toBe('run');
    expect(Math.cos(ai.yaw)).toBeCloseTo(-1); // faces +z, toward them (yaw ±π)
  });

  it('is blocked by a wall: a player behind it does not freeze it', () => {
    const { env } = corridor([wallBox(-3, 3, -20.2, -19.8)]);
    const ai = new MonitorAI(env, [0, 0, -30]);
    ai.forceHunt([0, 0, -30], 0);
    ai.step(DT, [viewer(0, 0, { id: 1 })]); // looks at it, but the wall is between
    expect(ai.state).toBe('chase');
  });

  it('touching a player catches them, then it stands for the hold time', () => {
    const { env } = corridor();
    const ai = new MonitorAI(env, [0, 0, -3]);
    ai.forceHunt([0, 0, -3], 0);
    const back = viewer(0, 0, { id: 7, yaw: Math.PI });
    let hit = -1;
    for (let i = 0; i < 40 && hit < 0; i++) { ai.step(DT, [back]); if (ai.caught.length) hit = i; }
    expect(hit).toBeGreaterThan(0);
    expect(ai.caught).toEqual([7]);
    expect(Math.hypot(ai.p[0], ai.p[2])).toBeLessThanOrEqual(MONITOR_CATCH_R + 6 * DT);
    expect(ai.state).toBe('hold');
    const at = [...ai.p];
    for (let t = 0; t < MONITOR_HOLD_S - 0.2; t += DT) ai.step(DT, [back]);
    expect(ai.p).toEqual(at); // still standing there
    expect(ai.caught).toEqual([]);
    const gone = viewer(0, 30, { id: 7, yaw: Math.PI }); // the room has sent the caught player back to the spawn
    for (let t = 0; t < 0.5; t += DT) ai.step(DT, [gone]);
    expect(ai.state).toBe('chase');
  });

  it('stands still for the start delay, and does not hunt players who are hiding', () => {
    const { env } = corridor();
    const ai = new MonitorAI(env, [0, 0, -30]);
    const p = viewer(0, 0, { yaw: Math.PI });
    for (let t = 0; t < MONITOR_START_DELAY_S - 0.5; t += DT) ai.step(DT, [p]);
    expect(ai.p).toEqual([0, 0, -30]);
    ready(ai, [p]);
    expect(ai.p).toEqual([0, 0, -30]); // everyone hidden → it never moved
    ai.step(DT, [p]);
    expect(ai.p[2]).toBeGreaterThan(-30);
  });

  it('blinks for BLINK_S every BLINK_EVERY_S, and cannot be frozen during the blink', () => {
    const { env } = corridor();
    const ai = new MonitorAI(env, [0, 0, -20]);
    ai.forceHunt([0, 0, -20], 0);
    const looking = viewer(0, 0);
    const starts: number[] = [];
    let blinkingSteps = 0, frozenInBlink = 0, frozenOutside = 0;
    for (let i = 0; i < Math.round((BLINK_EVERY_S * 2 + 1) / DT); i++) {
      ai.p = [0, 0, -20]; // keep it in view
      ai.step(DT, [looking]);
      if (ai.blinked) starts.push(i * DT);
      if (ai.blinking) { blinkingSteps++; if (ai.state === 'frozen') frozenInBlink++; } else if (ai.state === 'frozen') frozenOutside++;
    }
    expect(starts).toHaveLength(2);
    expect(starts[0]).toBeCloseTo(BLINK_EVERY_S, 0);
    expect(starts[1] - starts[0]).toBeCloseTo(BLINK_EVERY_S, 0);
    expect(blinkingSteps * DT).toBeCloseTo(BLINK_S * 2, 1);
    expect(frozenInBlink).toBe(0); // nobody sees it while their eyes are shut…
    expect(frozenOutside).toBeGreaterThan(0); // …but it is frozen the rest of the time
  });

  it('goes round a wall by the nav graph when the straight line is blocked', () => {
    // A wall at x=5 (z -5..5); the graph's only way round is via (0,8) → (10,8)
    const g = new NavGraph();
    g.chain([{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 8 }, { x: 10, y: 0, z: 8 }, { x: 10, y: 0, z: 0 }]);
    const world = new CollisionWorld([wallBox(4.9, 5.1, -5, 5)]);
    const walkable = (a: Vec3, b: Vec3) => { for (let i = 1; i <= 20; i++) { const t = i / 20; if (a[0] + (b[0] - a[0]) * t > 4.9 && a[0] + (b[0] - a[0]) * t < 5.1 && Math.abs(a[2] + (b[2] - a[2]) * t) < 5) return false; } return true; };
    const ai = new MonitorAI({ graph: g, los: worldLos(world), walkable }, [0, 0, 0]);
    ai.forceHunt([0, 0, 0], 0);
    const prey = viewer(10, 0, { id: 3, yaw: -Math.PI / 2 }); // looks along +x, away from the whole route: never freezes it
    let max = 0;
    for (let i = 0; i < 20 * 8; i++) { ai.step(DT, [prey]); max = Math.max(max, ai.p[2]); if (ai.caught.length) break; }
    expect(max).toBeGreaterThan(6); // it went up to the corridor at z=8
    expect(ai.caught).toEqual([3]);
  });
});

describe('Room: 第 2 关 has a 值日生', () => {
  const tee = () => {
    const g = new NavGraph();
    g.chain([{ x: 15, y: 3.6, z: 84.2 }, { x: 20, y: 3.6, z: 84.2 }, { x: 25, y: 3.6, z: 84.2 }]);
    return g;
  };
  const join = () => {
    const room = new RoomManager(mulberry32(3), () => tee()).create();
    const got: ServerMsg[] = [];
    const c: Conn = { id: 1, name: 'p1', send: (m) => got.push(m), sendRaw: (s) => got.push(JSON.parse(s)) };
    room.add(c, 0);
    return { room, got, pl: room.players.get(1)! };
  };
  const mon = (room: unknown) => (room as { monitors: MonitorAI[] }).monitors[0];

  it('level 1 has no monitor; loading level 2 adds mob 2 to the snapshots', () => {
    const { room, got } = join();
    expect(mon(room)).toBeUndefined();
    (room as unknown as { loadLevel(i: number): void }).loadLevel(1);
    expect(mon(room)).toBeDefined();
    got.length = 0;
    room.step();
    const snap = got.find((m): m is Extract<ServerMsg, { t: 'snap' }> => m.t === 'snap')!;
    expect(snap.mobs.map((m) => m.id)).toEqual([1, 2]);
    expect(snap.mobs[1]).toMatchObject({ kind: 'monitor', anim: 'idle' });
    (room as unknown as { loadLevel(i: number): void }).loadLevel(0);
    expect(mon(room)).toBeUndefined();
  });

  it('LevelDef.monitor drives count and pinned spawns (mob id = 2 + index)', () => {
    const { room, got } = join();
    const r = room as unknown as { loadLevel(i: number): void; level: { def: { monitor?: { count: number; spawns?: { x: number; z: number; y?: number }[] } } }; monitors: MonitorAI[] };
    r.loadLevel(1);
    const def = r.level.def, orig = def.monitor;
    const nodes = (room as unknown as { nav: { nodes: { x: number; y: number; z: number }[] } }).nav.nodes;
    const pin = nodes[nodes.length >> 1];
    def.monitor = { count: 2, spawns: [pin] };
    r.loadLevel(1);
    expect(r.monitors).toHaveLength(2);
    expect(Math.hypot(r.monitors[0].p[0] - pin.x, r.monitors[0].p[2] - pin.z)).toBeLessThan(0.01); // pinned on that nav node
    got.length = 0;
    room.step();
    const snap = got.find((m): m is Extract<ServerMsg, { t: 'snap' }> => m.t === 'snap')!;
    expect(snap.mobs.map((m) => m.id)).toEqual([1, 2, 3]);
    def.monitor = orig;
  });

  it('broadcasts a blink every BLINK_EVERY_S, and a touch keeps the downed player at contact', () => {
    const { room, got, pl } = join();
    (room as unknown as { loadLevel(i: number): void }).loadLevel(1);
    const spawn = [...pl.p];
    got.length = 0;
    for (let i = 0; i < Math.ceil((BLINK_EVERY_S * 1000) / TICK_MS) + 2; i++) {
      const watch = mon(room)!;
      pl.yaw = Math.atan2(pl.p[0] - watch.p[0], pl.p[2] - watch.p[2]);
      room.step();
    }
    expect(pl.st).toBe(0); // keep watching it until the deliberate contact below
    expect(got.filter((m) => m.t === 'blink')).toEqual([{ t: 'blink', secs: BLINK_S }]);
    room.add({ id: 2, name: 'rescuer', send() {}, sendRaw() {} }, 0);
    const m = mon(room)!;
    m.forceHunt([spawn[0] + 5, spawn[1], spawn[2] + 5], 0);
    pl.p = [spawn[0] + 5, spawn[1], spawn[2] + 5.3];
    const at = [...pl.p];
    pl.yaw = Math.PI; // looking away permits the deliberate touch
    got.length = 0;
    room.step();
    expect(pl.st).toBe(1);
    expect(pl.p).toEqual(at);
    expect(got.some((x) => x.t === 'caught')).toBe(true);
  });
});
