import { beforeAll, describe, expect, it } from 'vitest';
import campusData from '../../shared/campus/colliders.json';
import { RoomManager, type Conn } from '../../server/room.ts';
import type { FinaleAI } from '../../server/ai/finale.ts';
import { CollisionWorld, moveCapsule, overlaps } from '../../shared/campus/collision.ts';
import { lineOfSight, NAV_CAPSULE, type NavGraph } from '../../shared/campus/nav.ts';
import { campusDoorSlab } from '../../shared/doors.ts';
import { levelSolids } from '../../shared/level.ts';
import { canRun } from '../../shared/stamina.ts';
import { SPEED, TICK_MS } from '../../shared/constants.ts';
import { F_RUN, ST_OK, type ServerMsg, type Vec3 } from '../../shared/protocol.ts';
import { mulberry32 } from '../../shared/rng.ts';
import { campusNavCached } from '../../client/src/campus/world/navcache.ts';
import { advanceFinaleRoute, finaleGoalPoint, type FinalePoint } from '../../client/src/finale.ts';
import { guideWaypoint, navFromMsg, shutDoorOn } from '../../client/src/guide.ts';

describe('L8 ordinary objective-arrow escape', () => {
  let campusGraph: NavGraph;
  beforeAll(() => { ({ graph: campusGraph } = campusNavCached('.cache/campus-nav.json')); }, 120_000);

  it('follows the real 4 Hz guide with ordinary stamina, no rejected inputs, and a moving pursuer', () => {
    const room = new RoomManager(mulberry32(88), () => campusGraph).create();
    const sent: ServerMsg[] = [];
    const conn: Conn = { id: 1, name: '跟随箭头的学生', send: m => sent.push(m), sendRaw: s => sent.push(JSON.parse(s)) };
    room.add(conn, 0);
    room.handle(conn, { t: 'debug', op: 'level', level: 7 }, 0);
    const player = room.players.get(conn.id)!, def = room.level.def.finale!;
    player.p = [def.rollcall.x, def.rollcall.y, def.rollcall.z + 1.45];
    room.handle(conn, { t: 'act', kind: 'rollcall', id: conn.id }, 0);
    room.step();
    expect(sent.some(m => m.t === 'finale' && m.phase === 'chase')).toBe(true);

    // Use the actual transmitted campus graph, as Game.tickGuide does; the NPC's
    // denser chase spine must not conceal failures in the player's arrow route.
    const nav = sent.filter((m): m is Extract<ServerMsg, { t: 'nav' }> => m.t === 'nav').at(-1)!;
    const graph = navFromMsg(nav.n, nav.adj)!;
    expect(graph.nodes.length).toBeGreaterThan(0);
    const world = new CollisionWorld([
      ...room.world.boxes, ...levelSolids(room.level.def),
      ...room.doors.map(d => campusDoorSlab(d, room.doorOpen[d.id])),
    ]);
    for (const h of campusData.holes) world.addHole(h.x0, h.x1, h.z0, h.z1);
    const internal = room as unknown as { finaleAI: FinaleAI };
    const dt = TICK_MS / 1000, guideTicks = Math.round(250 / TICK_MS);
    let routeIndex = 0, minimumGap = Infinity, mobDistance = 0, walkedTicks = 0, ranTicks = 0;
    let oldMob: Vec3 = [...internal.finaleAI.p];
    let waypoint: FinalePoint = def.route[0];

    for (let tick = 1; tick <= 90 * 1000 / TICK_MS && !player.escaped && player.st === ST_OK; tick++) {
      const from = { x: player.p[0], y: player.p[1], z: player.p[2] };
      if ((tick - 1) % guideTicks === 0) {
        routeIndex = advanceFinaleRoute(def.route, from, routeIndex);
        const goal = finaleGoalPoint('chase', def, routeIndex)!;
        waypoint = guideWaypoint(graph, from, goal,
          (a, b) => lineOfSight(world, a, b),
          (a, b) => shutDoorOn(room.doors, room.doorOpen, a, b));
      }
      // Holding Run uses the same exhaustion/recovery hysteresis as normal play;
      // there is no debug safety, stamina refill, teleport, or waypoint override.
      const running = canRun(player.stamina, player.exhausted);
      if (running) ranTicks++; else walkedTicks++;
      const dx = waypoint.x - from.x, dz = waypoint.z - from.z, distance = Math.hypot(dx, dz);
      const budget = Math.min(distance, (running ? SPEED.run : SPEED.walk) * dt);
      const body = { ...from, vy: 0, grounded: true };
      moveCapsule(world, body, distance ? dx / distance * budget : 0, distance ? dz / distance * budget : 0, dt, NAV_CAPSULE);
      room.handle(conn, { t: 'input', seq: tick, p: [body.x, body.y, body.z], yaw: Math.atan2(-dx, -dz),
        pitch: 0, f: running ? F_RUN : 0, c: player.c }, tick * TICK_MS);
      room.step();

      const mob = internal.finaleAI.p;
      expect(overlaps(world, { x: mob[0], y: mob[1], z: mob[2], vy: 0, grounded: true }, NAV_CAPSULE)).toBe(false);
      mobDistance += Math.hypot(mob[0] - oldMob[0], mob[2] - oldMob[2]);
      oldMob = [...mob];
      minimumGap = Math.min(minimumGap, Math.hypot(mob[0] - player.p[0], mob[2] - player.p[2]));
    }

    expect(player.escaped, `stopped at ${player.p}; route ${routeIndex}; Warden gap ${minimumGap}`).toBe(true);
    expect(player.st).toBe(ST_OK);
    expect(routeIndex).toBe(def.route.length - 1);
    expect(sent.filter(m => m.t === 'correct' && !m.forced)).toHaveLength(0);
    expect(ranTicks).toBeGreaterThan(0);
    expect(walkedTicks).toBeGreaterThan(0);
    expect(mobDistance).toBeGreaterThan(100);
    expect(minimumGap).toBeGreaterThan(0.8);
    expect(sent.some(m => m.t === 'completed' && m.members[0].escaped && m.downs === 0)).toBe(true);
  });
});
