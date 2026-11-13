import { describe, expect, it } from 'vitest';
import { CollisionWorld } from '../../shared/campus/collision.ts';
import { lineOfSight, NavGraph } from '../../shared/campus/nav.ts';
import { mulberry32 } from '../../shared/rng.ts';
import { F_CROUCH, F_HIDE, F_LIGHT, F_RUN } from '../../shared/protocol.ts';
import type { NoiseEvent } from '../../shared/noise.ts';
import {
  litBy, WardenAI, WARDEN_CATCH_HOLD_S, WARDEN_CATCH_R, WARDEN_CHASE_SPEED, WARDEN_INVESTIGATE_SPEED, WARDEN_LOSE_SIGHT_S, WARDEN_PATROL_SPEED, type WardenEnv, type WardenTarget,
} from '../../server/ai/warden.ts';

const DT = 0.05;
const wallBox = (x0: number, x1: number, z0: number, z1: number) => ({ minX: x0, maxX: x1, minY: 0, maxY: 3, minZ: z0, maxZ: z1 });

/**
 * A 10 m wide U: a wall at x=5 (z -5..5) splits two rooms; the only way round is the corridor
 * A(0,0) → C(0,8) → D(10,8) → B(10,0). Straight A–B is 10 m through the wall; by the graph it is 26 m.
 */
function uMap() {
  const g = new NavGraph();
  const [a, c, d, b] = g.chain([{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 8 }, { x: 10, y: 0, z: 8 }, { x: 10, y: 0, z: 0 }]);
  const world = new CollisionWorld([wallBox(4.9, 5.1, -5, 5)]);
  const env: WardenEnv = { graph: g, rng: mulberry32(3), los: (p, q) => lineOfSight(world, p, q) };
  return { g, world, env, a, b, c, d };
}
const player = (x: number, z: number, o: Partial<WardenTarget> = {}): WardenTarget => ({ id: 1, p: [x, 0, z], yaw: 0, f: 0, ...o });
const noise = (x: number, z: number, r: number): NoiseEvent => ({ kind: 'run', x, y: 0, z, r });
const run = (w: WardenAI, s: number, players: WardenTarget[] = []) => { for (let i = 0; i < s / DT; i++) w.step(DT, players); };
const dist = (w: WardenAI, x: number, z: number) => Math.hypot(w.p[0] - x, w.p[2] - z);

describe('A* around walls', () => {
  it('routes the long way round the wall, not through it', () => {
    const { g, a, b } = uMap();
    const path = g.astar(a, b)!;
    expect(path).toHaveLength(4);
    let len = 0;
    for (let i = 1; i < path.length; i++) len += g.dist(path[i - 1], path[i]);
    expect(len).toBeCloseTo(26);
  });
});

describe('line of sight', () => {
  it('is blocked by the wall and open past it', () => {
    const { world } = uMap();
    expect(lineOfSight(world, { x: 0, y: 1.6, z: 0 }, { x: 10, y: 1.6, z: 0 })).toBe(false);
    expect(lineOfSight(world, { x: 0, y: 1.6, z: 7 }, { x: 10, y: 1.6, z: 7 })).toBe(true);
  });
});

describe('WardenAI', () => {
  it('slows only night patrol movement while investigation, pursuit and catch use real time', () => {
    const { env, a } = uMap();
    env.patrolMultiplier = () => .75;
    const patrol = new WardenAI(env, a);
    run(patrol, 1);
    expect(dist(patrol, 0, 0)).toBeCloseTo(WARDEN_PATROL_SPEED * .75, 6);
    expect(patrol.speed).toBeCloseTo(WARDEN_PATROL_SPEED * .75, 6);
    const investigating = new WardenAI(env, a);
    investigating.hear(noise(0, 8, 12));
    run(investigating, 1);
    expect(dist(investigating, 0, 0)).toBeCloseTo(WARDEN_INVESTIGATE_SPEED, 6);
    const chasing = new WardenAI(env, a), target = player(0, 6);
    chasing.forceChase([0, 0, 0], Math.PI, 1, target.p);
    chasing.step(DT, [target]);
    expect(dist(chasing, 0, 0)).toBeCloseTo(WARDEN_CHASE_SPEED * DT, 6);
    const catching = new WardenAI(env, a), nearby = player(0, .5);
    catching.forceChase([0, 0, 0], Math.PI, 1, nearby.p);
    catching.step(DT, [nearby]);
    run(catching, WARDEN_CATCH_HOLD_S - DT);
    expect(catching.state).toBe('catch');
    catching.step(DT + 1e-8, []);
    expect(catching.state).toBe('patrol');
  });

  it('patrols at WARDEN_PATROL_SPEED along graph edges', () => {
    const { env, a } = uMap();
    const w = new WardenAI(env, a);
    run(w, 1);
    expect(w.state).toBe('patrol');
    expect(dist(w, 0, 0)).toBeCloseTo(WARDEN_PATROL_SPEED, 1);
    for (let i = 0; i < 2000; i++) {
      w.step(DT, []);
      const onEdge = (Math.abs(w.p[0]) < 1e-6 && w.p[2] >= -1e-6 && w.p[2] <= 8 + 1e-6)
        || (Math.abs(w.p[2] - 8) < 1e-6) || (Math.abs(w.p[0] - 10) < 1e-6 && w.p[2] >= -1e-6 && w.p[2] <= 8 + 1e-6);
      expect(onEdge).toBe(true);
    }
  });

  it('a noise in range sends him to investigate it by the graph, then back to patrol', () => {
    const { env, a } = uMap();
    const w = new WardenAI(env, a);
    w.hear(noise(3, 0, 12)); // run noise 3 m away
    expect(w.state).toBe('investigate');
    w.hear(noise(50, 50, 12)); // out of range: ignored
    expect(w.goal).toEqual([3, 0, 0]);
    run(w, 30);
    expect(w.state).toBe('patrol');
  });

  it('ignores noise out of range, and a muffled one through the wall', () => {
    const { env, a } = uMap();
    const w = new WardenAI(env, a);
    w.hear(noise(0, 7, 4));
    expect(w.state).toBe('patrol');
    const blocked = () => true;
    w.hear(noise(0, 5, 8), blocked); // 5 m > 8 × 0.5
    expect(w.state).toBe('patrol');
    w.hear(noise(0, 3, 8), blocked);
    expect(w.state).toBe('investigate');
  });

  it('investigates when a flashlight beam hits him', () => {
    const { env, a, world } = uMap();
    const w = new WardenAI(env, a);
    // player at (0,6) looks toward -z (yaw 0) with the light on, pitched down slightly to his chest
    const p = player(0, 6, { f: F_LIGHT, pitch: -0.1 });
    expect(litBy(p, w.p, env.los)).toBe(true);
    expect(litBy({ ...p, f: 0 }, w.p, env.los)).toBe(false);
    expect(litBy({ ...p, yaw: Math.PI }, w.p, env.los)).toBe(false); // looking away
    // the wall hides the beam
    const across = player(10, 0, { f: F_LIGHT, yaw: Math.PI / 2 });
    expect(lineOfSight(world, { x: 10, y: 1.6, z: 0 }, { x: 0, y: 1, z: 0 })).toBe(false);
    expect(litBy(across, w.p, env.los)).toBe(false);
    w.step(DT, [{ ...p, pitch: -0.1 }]);
    expect(['investigate', 'chase']).toContain(w.state);
  });

  it('chases a visible player at WARDEN_CHASE_SPEED and catches within 0.8 m', () => {
    const { env, a } = uMap();
    const w = new WardenAI(env, a);
    w.yaw = Math.PI; // facing +z
    const p = player(0, 6);
    w.step(DT, [p]);
    expect(w.state).toBe('chase');
    const z0 = w.p[2];
    run(w, 0.5, [p]);
    expect((w.p[2] - z0)).toBeCloseTo(WARDEN_CHASE_SPEED * 0.5, 1);
    run(w, 3, [p]);
    expect(w.state).toBe('catch');
    expect(w.caught).toEqual([]); // reported once, on the tick it happened
    expect(dist(w, 0, 6)).toBeLessThanOrEqual(WARDEN_CATCH_R + 1e-6);
  });

  it('does not cut straight through geometry that sight passes but his body does not (furniture, door frames)', () => {
    const { env, world, a } = uMap();
    // sight is a thin ray: pretend it passes everything; only the capsule test knows about the wall
    // (his body is ~0.1 m round the ray: the same margin the inside-the-wall check below uses, so skimming its end corner counts)
    const body = new CollisionWorld([wallBox(4.8, 5.2, -5.1, 5.1)]);
    const blocked = (p: [number, number, number], q: [number, number, number]) => lineOfSight(body, { x: p[0], y: 0.5, z: p[2] }, { x: q[0], y: 0.5, z: q[2] });
    const w = new WardenAI({ ...env, los: () => true, walkable: blocked }, a);
    w.yaw = -Math.PI / 2; // facing +x, the player is 10 m away behind the wall
    const p = player(10, 0);
    for (let i = 0; i < 12 / DT; i++) {
      w.step(DT, [p]);
      expect(w.p[0] > 4.8 && w.p[0] < 5.2 && w.p[2] < 5, `inside the wall at ${w.p}`).toBe(false);
      if (w.state === 'catch') break;
    }
    expect(w.state).toBe('catch'); // went round by the corridor (26 m at 4.6 m/s ≈ 6 s) instead of getting stuck
    expect(dist(w, 10, 0)).toBeLessThanOrEqual(WARDEN_CATCH_R + 1e-6);
  });

  it('reports the catch on the tick it happens, then holds and resumes patrol', () => {
    const { env, a } = uMap();
    const w = new WardenAI(env, a);
    w.yaw = Math.PI;
    const p = player(0, 2);
    const hits: number[] = [];
    for (let i = 0; i < 50; i++) { w.step(DT, [p]); hits.push(...w.caught); } // 2.5 s: caught at ~1.2 s, still holding
    expect(hits).toEqual([1]);
    run(w, WARDEN_CATCH_HOLD_S + 0.2, []);
    expect(w.state).toBe('patrol');
  });

  it('does not see through the wall, nor behind his back', () => {
    const { env, a } = uMap();
    const w = new WardenAI(env, a);
    w.yaw = -Math.PI / 2; // forward = (1, 0): toward the wall
    w.step(DT, [player(8, 0)]); // 8 m away, in front, but behind the wall
    expect(w.state).toBe('patrol');
    const w2 = new WardenAI(env, a);
    w2.yaw = 0; // forward −z
    w2.step(DT, [player(0, 6)]); // behind him, outside the 2.5 m sense radius
    expect(w2.state).toBe('patrol');
  });

  it('loses sight behind the wall: after 6 s he investigates the last seen spot by the long way round', () => {
    const { env, a } = uMap();
    const w = new WardenAI(env, a);
    w.yaw = -Math.PI / 2; // facing +x
    const near = player(4, 0);
    w.step(DT, [near]);
    expect(w.state).toBe('chase');
    // the player slips to the far side (10,0): the wall hides them
    const far = player(10, 0);
    run(w, WARDEN_LOSE_SIGHT_S - 1, [far]);
    expect(w.state).toBe('chase');
    run(w, 1.2, [far]);
    expect(w.state).toBe('investigate');
    expect(w.target).toBe(0);
    // it walks the corridor round to (10,0), it does not pass through x=5 inside the wall's z span
    for (let i = 0; i < 40 / DT && w.state === 'investigate'; i++) {
      w.step(DT, [far]);
      expect(Math.abs(w.p[0] - 5) < 0.1 && Math.abs(w.p[2]) < 5).toBe(false);
    }
  });

  it('keeps chasing for the full 6 s without sight, then gives up', () => {
    const { env, a } = uMap();
    const w = new WardenAI(env, a);
    w.yaw = -Math.PI / 2;
    w.step(DT, [player(4, 0)]);
    run(w, 4, [player(10, 0)]);
    expect(w.state).toBe('chase');
    run(w, 2.1, [player(10, 0)]);
    // 6 s total without sight -> investigate
    expect(w.state).toBe('investigate');
  });

  it('chase ignores noise; investigation switches to a new far noise', () => {
    const { env, a } = uMap();
    const w = new WardenAI(env, a);
    w.hear(noise(0, 2, 12));
    w.hear(noise(0, 7, 12));
    expect(w.goal).toEqual([0, 0, 7]);
    w.yaw = Math.PI;
    w.step(DT, [player(0, 5, { f: F_RUN })]);
    expect(w.state).toBe('chase');
    w.hear(noise(0, 0, 12));
    expect(w.state).toBe('chase');
  });
});

describe('voice lines', () => {
  const lineEnv = () => { const m = uMap(); const w = new WardenAI(m.env, m.a); return { ...m, w }; };
  const drain = (w: WardenAI) => w.takeLines();

  it('spot: first sight of a player says a spot line', () => {
    const { w } = lineEnv();
    w.step(DT, [player(0, -3)]);
    expect(w.state).toBe('chase');
    const l = drain(w);
    expect(l).toHaveLength(1);
    expect(l[0].trigger).toBe('spot');
    expect(l[0].text.length).toBeGreaterThan(0);
  });

  it('forget: the player it chases leaves the room, the chase ends at once', () => {
    const { w } = lineEnv();
    w.forceChase([0, 0, 0], 0, 1, [0, 0, -5]);
    expect(w.state).toBe('chase');
    w.forget(1);
    expect(w.state).toBe('patrol');
    w.step(DT, []);
    expect(w.state).toBe('patrol');
  });

  it('cooldown: no second line within 6 s, one after', () => {
    const { w } = lineEnv();
    w.forceChase([0, 0, 0], 0, 1, [0, 0, -5]); // 'spot'
    expect(drain(w)).toHaveLength(1);
    w.step(DT, [player(0, -5, { f: F_RUN })]); // would say sprint, but the cooldown holds
    expect(drain(w)).toHaveLength(0);
    for (let i = 0; i < 6.1 / DT; i++) w.step(DT, [player(0, w.p[2] - 6)]); // stays 6 m ahead, never caught
    w.step(DT, [player(0, w.p[2] - 6, { f: F_RUN })]);
    expect(drain(w).map(l => l.trigger)).toEqual(['sprint']);
  });

  it('chase: a periodic chase line while chasing; fail: sayFail says a fail line', () => {
    const { w } = lineEnv();
    w.forceChase([0, 0, 0], 0, 1, [0, 0, -5]);
    drain(w);
    const got: string[] = [];
    for (let i = 0; i < 20 / DT; i++) { w.step(DT, [player(0, w.p[2] - 6)]); got.push(...drain(w).map(l => l.trigger)); }
    expect(got).toContain('chase');
    const m = lineEnv();
    m.w.sayFail();
    expect(drain(m.w).map(l => l.trigger)).toEqual(['fail']);
  });

  it('recent ids are not repeated back to back', () => {
    const { w } = lineEnv();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) { w.forceChase([0, 0, 0], 0, 1, [0, 0, -5]); ids.push(...drain(w).map(l => l.id)); run(w, 6.1, [player(0, -5)]); drain(w); }
    expect(ids.length).toBe(6);
    // the 'spot' pool has two lines: while one is recent the other is picked
    expect(ids[1]).not.toBe(ids[0]);
  });

  it('lost: losing the chased player says a lost line', () => {
    const { w } = lineEnv();
    w.step(DT, [player(0, -4)]); // far enough that 0.5 s of chase does not reach him
    drain(w);
    run(w, 0.5, [player(0, -4)]);
    run(w, WARDEN_LOSE_SIGHT_S + 6.5, []); // out of sight past the cooldown
    expect(drain(w).map(l => l.trigger)).toContain('lost');
  });

  it('catch: grabbing a player says a catch line', () => {
    const { w } = lineEnv();
    w.forceChase([0, 0, 0], Math.PI, 1, [0, 0, 0]);
    drain(w);
    run(w, 6.1, [player(0, 5)]); // cooldown passes while he keeps chasing at a distance
    drain(w);
    w.p = [0, 0, 0]; w.state = 'chase';
    w.step(DT, [player(0, 0.3)]);
    expect(w.caught).toEqual([1]);
    expect(drain(w).map(l => l.trigger)).toEqual(['catch']);
  });

  it('noise: a loud door/item noise heard on patrol says a noise line; footsteps do not', () => {
    const { w } = lineEnv();
    run(w, 6.1);
    w.hear({ kind: 'item', x: 0, y: 0, z: 6, r: 15 });
    expect(drain(w).map(l => l.trigger)).toEqual(['noise']);
    const b = lineEnv();
    run(b.w, 6.1);
    b.w.hear(noise(0, 6, 12));
    expect(drain(b.w)).toHaveLength(0);
  });

  it('patrol: an ambient line every 25–40 s', () => {
    const { w } = lineEnv();
    run(w, 24);
    expect(drain(w)).toHaveLength(0);
    run(w, 17);
    const l = drain(w);
    expect(l).toHaveLength(1);
    expect(l[0].trigger).toBe('patrol');
  });
});

describe('hiding (locker / under a desk)', () => {
  const open = () => {
    const { env, a } = uMap();
    const w = new WardenAI(env, a);
    w.yaw = Math.PI; // faces +z
    return w;
  };

  it('a hidden player in plain view is not seen, even within the close sense radius', () => {
    const w = open();
    run(w, 1, [player(0, 5, { f: F_HIDE | F_CROUCH })]);
    expect(w.state).not.toBe('chase');
    const w2 = open();
    run(w2, 1, [player(0, 1.5, { f: F_HIDE })]);
    expect(w2.state).not.toBe('chase');
    expect(w2.caught).toEqual([]);
  });

  it('a hidden player is not given away by his own flashlight beam', () => {
    const w = open();
    w.p = [0, 0, 6]; // 6 m ahead of the player, who looks along +z
    const p = player(0, 0, { f: F_LIGHT | F_HIDE, yaw: Math.PI });
    expect(litBy({ ...p, f: F_LIGHT }, w.p, uMap().env.los)).toBe(true);
    w.step(DT, [p]);
    expect(w.state).toBe('patrol');
    w.step(DT, [{ ...p, f: F_LIGHT }]);
    expect(['investigate', 'chase']).toContain(w.state);
  });

  it('he pulls out a player he watched go in, and catches them', () => {
    const w = open();
    w.step(DT, [player(0, 5)]);
    expect(w.state).toBe('chase');
    const hid = (z: number) => player(0, z, { f: F_HIDE });
    let caught = 0;
    for (let i = 0; i < 2.5 / DT; i++) { w.step(DT, [hid(5)]); caught += w.caught.length; }
    expect(caught).toBe(1);
    expect(w.state).toBe('catch');
    expect(w.target).toBe(1);
  });

  it('he does not know about a player who hid before he ever saw them', () => {
    const w = open();
    run(w, 30, [player(0, 3, { f: F_HIDE })]);
    expect(w.state).not.toBe('catch');
    expect(w.target).toBe(0);
  });

  it('after the catch hold he does not instantly re-grab the same hidden player', () => {
    const w = open();
    w.step(DT, [player(0, 5)]);
    run(w, 2.5, [player(0, 5, { f: F_HIDE })]);
    expect(w.state).toBe('catch');
    run(w, WARDEN_CATCH_HOLD_S + 0.2, [player(0, 5, { f: F_HIDE })]);
    expect(w.state).toBe('patrol');
    run(w, 3, [player(0, 5, { f: F_HIDE })]);
    expect(w.state).not.toBe('catch');
  });
});
