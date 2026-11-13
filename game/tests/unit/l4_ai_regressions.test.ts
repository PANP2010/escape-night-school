import { expect, it } from 'vitest';
import { WardenAI, type WardenEnv } from '../../server/ai/warden.ts';
import { Room } from '../../server/room.ts';
import { campusNavCached } from '../../client/src/campus/world/navcache.ts';
import { CollisionWorld, overlaps, type AABB } from '../../shared/campus/collision.ts';
import { NAV_CAPSULE, walk } from '../../shared/campus/nav.ts';
import { campusDoorSlab, type DoorSpot } from '../../shared/doors.ts';
import { generateLevel, levelSolids } from '../../shared/level.ts';
import type { ServerMsg, Vec3 } from '../../shared/protocol.ts';
import campusData from '../../shared/campus/colliders.json';

const fullNav = () => campusNavCached('test-results/l4-campus-nav.json').graph;
const world = new CollisionWorld([
  ...(campusData.colliders as AABB[]),
  ...(campusData.doors as DoorSpot[]).map(d => campusDoorSlab(d, false)),
  ...levelSolids(generateLevel(3, 4).def),
]);
for (const h of campusData.holes) world.addHole(h.x0, h.x1, h.z0, h.z1);

const aiRoom = (nav = fullNav()) => {
  const room = new Room('L4AI', 4, nav, 3);
  const ai = room as unknown as { warden: WardenAI; wardenEnv: WardenEnv };
  return { room, warden: ai.warden, wardenEnv: ai.wardenEnv };
};
const clear = (p: Vec3) => !overlaps(world, { x: p[0], y: p[1], z: p[2], vy: 0, grounded: true }, NAV_CAPSULE);
const route = (warden: WardenAI) => (warden as unknown as { route: number[] }).route;

it('real L4 point-name exposure replaces a previous investigation at the same XZ on another floor', () => {
  const { room, warden, wardenEnv: { graph } } = aiRoom();
  const messages: ServerMsg[] = [];
  room.add({ id: 1, name: '同学', send: m => messages.push(m), sendRaw: s => messages.push(JSON.parse(s)) }, 0);
  const player = room.players.get(1)!;
  player.p = [-28, 10.8, 130];
  warden.reset(graph.nearest(-24, 10.8, 130));
  warden.yaw = -Math.PI / 2;
  room.tick = 1199;
  room.broadcastStation!.nextAt = 60;
  warden.hear({ kind: 'run', x: -28, y: 7.2, z: 130, r: 12 });
  expect(warden.goal).toEqual([-28, 7.2, 130]);
  const oldEnd = route(warden).at(-1)!;
  expect(graph.nodes[oldEnd].y).toBeCloseTo(7.2);
  warden.hear({ kind: 'run', x: -27.8, y: 7.3, z: 130.1, r: 12 });
  expect(warden.goal).toEqual([-28, 7.2, 130]); // nearby same-storey footsteps still keep the plan
  room.step();
  expect(room.broadcastStation!.call?.id).toBe(1);
  expect(warden.goal).toEqual([-28, 10.8, 130]);
  expect(route(warden).at(-1)).not.toBe(oldEnd);
  expect(graph.nodes[route(warden).at(-1)!].y).toBeCloseTo(10.8);
  expect(messages.some(m => m.t === 'broadcast' && m.call?.p?.[1] === 10.8)).toBe(true);
});

it('real L4 broadcast investigation from either east corridor stays outside solids for the full exposure', () => {
  const full = fullNav();
  for (const y of [7.2, 10.8]) {
    const { room, warden, wardenEnv: { graph } } = aiRoom(full);
    room.tick = 1220; // past the real room opening keep-out, as a natural point-name call is
    warden.reset(graph.nearest(-9.05, y, 129.15));
    warden.hear({ kind: 'item', x: -32.5, y: 10.8, z: 129.44, r: 200 });
    expect(warden.state).toBe('investigate');
    expect(warden.goal).toEqual([-32.5, 10.8, 129.44]);
    for (let tick = 1; tick <= 200; tick++) {
      warden.step(.05, []);
      expect(clear(warden.p), `start ${y}, exposure ${(tick * .05).toFixed(2)}s, ${warden.p}`).toBe(true);
    }
  }
});

it('L4 slopes join their flat landings without putting a linear-moving monster inside a tread', () => {
  const { wardenEnv: { graph } } = aiRoom();
  let slopes = 0, approaches = 0;
  graph.adj.forEach((links, i) => {
    for (const j of links) {
      const from = graph.nodes[i], to = graph.nodes[j];
      const slope = Math.abs(from.y - to.y) >= .1;
      const doorway = [from, to].some(n => Math.abs(n.z - 134.13) < .01 &&
        (Math.abs(n.x + 13.65) < .01 || Math.abs(n.x + 12.1) < .01));
      if (!slope && !doorway) continue;
      if (slope) slopes++;
      else approaches++;
      expect(walk(world, from, [[to.x, to.z]]), `${i} → ${j}`).not.toBeNull();
      for (let k = 0; k <= 100; k++) {
        const t = k / 100;
        expect(clear([from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, from.z + (to.z - from.z) * t]),
          `${i} → ${j} at ${t}`).toBe(true);
      }
    }
  });
  expect(slopes).toBeGreaterThanOrEqual(4);
  expect(approaches).toBeGreaterThanOrEqual(12);
});
