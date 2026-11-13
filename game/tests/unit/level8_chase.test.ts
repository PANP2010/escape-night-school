import { describe, expect, it } from 'vitest';
import { RoomManager, type Conn } from '../../server/room.ts';
import { FinaleAI } from '../../server/ai/finale.ts';
import { type ServerMsg, type Vec3, F_RUN, ST_OK, ST_SPECTATE } from '../../shared/protocol.ts';
import { CollisionWorld, moveCapsule, overlaps } from '../../shared/campus/collision.ts';
import { NAV_CAPSULE, type NavGraph } from '../../shared/campus/nav.ts';
import { levelSolids } from '../../shared/level.ts';
import { campusDoorSlab } from '../../shared/doors.ts';
import { canRun } from '../../shared/stamina.ts';
import { SPEED, TICK_MS } from '../../shared/constants.ts';
import { mulberry32 } from '../../shared/rng.ts';

function setup() {
  const room = new RoomManager(mulberry32(1)).create();
  const sent: ServerMsg[] = [];
  const conn: Conn = { id: 1, name: '逃课生', send: m => sent.push(m), sendRaw: s => sent.push(JSON.parse(s)) };
  room.add(conn, 0);
  room.handle(conn, { t: 'debug', op: 'level', level: 7 }, 0);
  const pl = room.players.get(1)!, f = room.level.def.finale!;
  pl.p = [f.rollcall.x, 0, f.rollcall.z + 1.45];
  room.handle(conn, { t: 'act', kind: 'rollcall', id: 1 }, 0);
  room.step();
  expect(sent.some(m => m.t === 'finale' && m.phase === 'chase')).toBe(true);
  const internal = room as unknown as { finaleAI: FinaleAI; finaleGraph(): NavGraph; campusMoveOk(w: CollisionWorld, a: Vec3, b: Vec3): boolean };
  const world = new CollisionWorld([...room.world.boxes, ...levelSolids(room.level.def), ...room.doors.map(d => campusDoorSlab(d, false))]);
  return { room, pl, conn, sent, internal, world };
}

describe('L8 actual pursuit and fair escape', () => {
  it('builds only collision-clear graph edges, including the office and opened gate, without a supplied campus graph', () => {
    const { internal, room } = setup();
    const g = internal.finaleGraph();
    for (let i = 0; i < g.nodes.length; i++) for (const j of g.adj[i]) {
      const a = g.nodes[i], b = g.nodes[j];
      expect(internal.campusMoveOk(room.world, [a.x, a.y, a.z], [b.x, b.y, b.z]), `edge ${i} to ${j}`).toBe(true);
    }
    const f = room.level.def.finale!;
    const a = g.nearest(f.chaseSpawn.x, 0, f.chaseSpawn.z), b = g.nearest(room.level.exit.x, 0, room.level.exit.z);
    expect(g.astar(a, b)).not.toBeNull();
  });

  it('catches a stationary solo player in place, records one down and immediately restarts without a rescuer', () => {
    const { room, pl, sent } = setup();
    const p = [...pl.p];
    for (let i = 0; i < 20 * 1000 / TICK_MS && pl.st === ST_OK; i++) room.step();
    expect(pl.st).toBe(ST_SPECTATE);
    expect(pl.heldUntil).toBeUndefined();
    expect(pl.p).toEqual(p);
    expect(sent.filter(m => m.t === 'caught')).toHaveLength(1);
    expect(sent.find(m => m.t === 'caught')).toMatchObject({ id: 1, by: 'warden', at: p });
    expect(sent.filter(m => m.t === 'fade')).toEqual([{ t: 'fade', secs: 3, restart: true }]);
    const state = sent.filter(m => m.t === 'finale').at(-1);
    expect(state).toMatchObject({ downs: 1 });
  });

  it('a player can escape along every authored leg with ordinary run/rest stamina and accepted input, while Warden really follows', () => {
    const { room, pl, conn, sent, world, internal } = setup();
    const route = room.level.def.finale!.route;
    let index = 0, seq = 0, minimumGap = Infinity, mobDistance = 0;
    let oldMob = [...internal.finaleAI.p];
    const dt = TICK_MS / 1000;
    let running = true;
    for (let t = 1; t <= 90 * 1000 / TICK_MS && !pl.escaped && pl.st === ST_OK; t++) {
      // Match the client autopilot's arrival radius: each turn starts before the exact authored point.
      while (index < route.length - 1 && Math.hypot(pl.p[0] - route[index].x, pl.p[2] - route[index].z) < 0.3) index++;
      const q = route[index], dx = q.x - pl.p[0], dz = q.z - pl.p[2], d = Math.hypot(dx, dz);
      if (pl.stamina < 0.06) running = false;
      if (pl.stamina > 0.97) running = true;
      const run = running && canRun(pl.stamina, pl.exhausted), budget = Math.min(d, (run ? SPEED.run : SPEED.walk) * dt);
      const p = { x: pl.p[0], y: pl.p[1], z: pl.p[2], vy: 0, grounded: true };
      moveCapsule(world, p, d ? dx / d * budget : 0, d ? dz / d * budget : 0, dt, NAV_CAPSULE);
      room.handle(conn, { t: 'input', seq: ++seq, p: [p.x, p.y, p.z], yaw: Math.atan2(-dx, -dz), pitch: 0, f: run ? F_RUN : 0, c: pl.c }, t * TICK_MS);
      room.step();
      const mob = internal.finaleAI.p;
      expect(overlaps(world, { x: mob[0], y: mob[1], z: mob[2], vy: 0, grounded: true }, NAV_CAPSULE)).toBe(false);
      mobDistance += Math.hypot(mob[0] - oldMob[0], mob[2] - oldMob[2]); oldMob = [...mob];
      minimumGap = Math.min(minimumGap, Math.hypot(mob[0] - pl.p[0], mob[2] - pl.p[2]));
    }
    expect(pl.st).toBe(ST_OK);
    expect(pl.escaped, `stuck at ${pl.p}, waypoint ${index}, closest Warden gap ${minimumGap}`).toBe(true);
    expect(mobDistance).toBeGreaterThan(100);
    expect(sent.filter(m => m.t === 'correct' && !m.forced)).toHaveLength(0);
    expect(sent.some(m => m.t === 'completed' && m.members[0].escaped && m.downs === 0)).toBe(true);
  });
});
