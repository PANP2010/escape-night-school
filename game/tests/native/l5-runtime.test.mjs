import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// The application builds JSON imports with Vite. Native Node requires an
// explicit JSON attribute; this hook supplies it without rewriting game code.
registerHooks({
  load(url, context, nextLoad) {
    return nextLoad(url, url.endsWith('.json')
      ? { ...context, importAttributes: { ...context.importAttributes, type: 'json' } }
      : context);
  },
});

const [{ GymSwitches, sweptBallHit }, { GymRuntime }, { L5, L5_INDEX },
  { generateLevel, levelSolids, LEVELS }, { CollisionWorld, moveCapsule },
  { walk, NAV_CAPSULE }, { campusDoorSlab }, { gymAreaNav }, { Room },
  { default: campusData }] = await Promise.all([
  import('../../shared/gym.ts'), import('../../server/gym.ts'), import('../../shared/levels/l5.ts'),
  import('../../shared/level.ts'), import('../../shared/campus/collision.ts'),
  import('../../shared/campus/nav.ts'), import('../../shared/doors.ts'), import('../../server/gym-nav.ts'),
  import('../../server/room.ts'), import('../../shared/campus/colliders.json', { with: { type: 'json' } }),
]);

const gymDef = L5.gym;
const world = new CollisionWorld([...campusData.colliders, ...levelSolids(L5),
  ...campusData.doors.filter((d) => d.id !== gymDef.equipmentDoor).map((d) => campusDoorSlab(d, false))]);
const graph = gymAreaNav(generateLevel(L5_INDEX, 42));
const setupRuntime = (blocked = (_x, _z, _radius) => false) => {
  const noise = [], sounds = [], trips = [];
  const runtime = new GymRuntime(gymDef, 0, {
    blocked, noise: (p, radius, player) => noise.push({ p: [...p], radius, player }),
    sound: (event) => sounds.push(event), trip: (id) => trips.push(id),
  });
  return { runtime, noise, sounds, trips };
};
const setupRoom = (withMonitors = false) => {
  const messages = [], room = new Room('GYM5', 42, withMonitors ? graph : undefined);
  const conn = { id: 1, name: 'gym-test', send: (message) => messages.push(structuredClone(message)), sendRaw: (s) => messages.push(JSON.parse(s)) };
  room.add(conn, 0); room.handle(conn, { t: 'start' }, 0); room.handle(conn, { t: 'debug', op: 'level5' }, 0);
  return { room, conn, messages, player: room.players.get(conn.id) };
};

test('L5 stays at wire index 4 and does not replace the third campaign chapter', () => {
  assert.equal(L5_INDEX, 4); assert.equal(generateLevel(4, 42).def, L5);
  assert.equal(generateLevel(2, 42).def.name, '三楼·无尽走廊');
  assert.equal(LEVELS[4], L5); assert.equal(LEVELS.length, 5);
  assert.equal(generateLevel(3, 42).def.name, '广播站');
});

for (const count of [1, 2, 3, 4]) test(`${count} player switch deadline is strict and cannot be extended by spam`, () => {
  const switches = new GymSwitches(), duration = count === 1 ? 20 : 5;
  switches.syncTeam(Array.from({ length: count }, (_, i) => i + 1));
  assert.equal(switches.press(0, 0), true); assert.equal(switches.until[0], duration);
  assert.equal(switches.press(0, duration - 0.001), false); assert.equal(switches.until[0], duration);
  switches.press(1, 1); switches.press(2, 2); switches.press(3, duration);
  assert.equal(switches.complete, false); assert.equal(switches.until[0], 0);
  assert.equal(switches.press(0, duration), true); assert.equal(switches.complete, true);
  switches.expire(200); assert.equal(switches.complete, true);
});

test('team changes discard a solo latch until the puzzle is complete', () => {
  const switches = new GymSwitches(); switches.syncTeam([1]); switches.press(0, 0);
  switches.syncTeam([1, 2]); assert.deepEqual(switches.until, [0, 0, 0, 0]);
  switches.press(0, 1); switches.syncTeam([2, 1]); assert.equal(switches.until[0], 6);
  switches.syncTeam([1, 3]); assert.deepEqual(switches.until, [0, 0, 0, 0]);
});

test('a swept ball meets a player between different endpoint heights without hitting another storey', () => {
  assert.equal(sweptBallHit([-1, 0.8, 0], [1, 0.035, 0], [0, 0.035, 0], 0.57), true);
  assert.equal(sweptBallHit([-1, 0.035, 0], [1, 0.8, 0], [0, 0.035, 0], 0.57), true);
  assert.equal(sweptBallHit([0, 1, 0], [0, 0.035, 0], [0, 0.035, 0], 0.57), true);
  assert.equal(sweptBallHit([-1, 2, 0], [1, 2, 0], [0, 0.035, 0], 0.57), false);
  assert.equal(sweptBallHit([-1, 0, 0], [1, 2, 0], [0, 0, 0], 0.57), true);
  assert.equal(sweptBallHit([-1, 0, 0], [1, 3, 0], [0, 0, 0], 0.4), false);
});

test('real equipment doorway releases scheduled basketballs that fan across the court and bounce', () => {
  const { runtime, sounds, noise } = setupRuntime((x, z, radius) =>
    x < L5.area.x0 || x > L5.area.x1 || z < L5.area.z0 || z > L5.area.z1 ||
    world.query(x - radius, z - radius, x + radius, z + radius).some((b) => b.maxY > 0.08 && b.minY < 0.48 &&
      Math.hypot(x - Math.max(b.minX, Math.min(x, b.maxX)), z - Math.max(b.minZ, Math.min(z, b.maxZ))) < radius));
  runtime.step(5.95, 0.05, []); assert.equal(runtime.balls.length, 0);
  let furthestZ = 0, fanned = false;
  for (let tick = 120; tick <= 400; tick++) {
    runtime.step(tick * 0.05, 0.05, []);
    for (const ball of runtime.balls) { furthestZ = Math.max(furthestZ, ball.p[2]); fanned ||= Math.abs(ball.v[0]) > 0; }
  }
  assert.ok(furthestZ > 60, `basketball stayed near equipment room: ${furthestZ}`);
  assert.equal(fanned, true); assert.ok(sounds.some((event) => event.kind === 'bounce'));
  assert.ok(noise.length > 1); assert.ok(noise.every((event) => event.radius === 10));
});

test('a fast ball cannot tunnel through a player; trip lasts exactly 1.5 seconds and emits one 15m impact', () => {
  const { runtime, trips, noise, sounds } = setupRuntime(); runtime.step(6, 0.05, []);
  runtime.balls[0].p = [0, 0, 0]; runtime.balls[0].v = [12, 0];
  runtime.step(6.1, 0.2, [{ id: 1, p: [1.2, 0, 0], active: true }]);
  assert.deepEqual(trips, [1]); assert.equal(runtime.tripped(1, 7.599), true); assert.equal(runtime.tripped(1, 7.6), false);
  assert.deepEqual(noise.filter((event) => event.radius === 15), [{ p: [1.2, 0, 0], radius: 15, player: 1 }]);
  assert.equal(sounds.filter((event) => event.kind === 'trip').length, 1);
  runtime.touchMove(1, [0, 0, 0], [3, 0, 0], 6.2); assert.deepEqual(trips, [1]);
});

test('all navigation nodes are grounded and connected; both stands support real player capsules', () => {
  assert.ok(graph.nodes.length > 0);
  const spawn = L5.spawns[0], reachable = graph.reachable(graph.nearest(spawn.x, spawn.y ?? 0, spawn.z));
  for (const [index, node] of graph.nodes.entries()) {
    const body = { ...node, vy: 0, grounded: true }; moveCapsule(world, body, 0, 0, 0.05, NAV_CAPSULE);
    assert.ok(Math.abs(body.y - node.y) < 0.00001, `node ${index} changed height`); assert.ok(reachable.has(index), `node ${index} disconnected`);
  }
  for (const stand of gymDef.stands) {
    const x = stand.x + stand.w / 2, points = Array.from({ length: stand.rows }, (_, i) => [x, stand.z + (i + 0.5) * stand.run]);
    const playerCapsule = { ...NAV_CAPSULE, radius: 0.35 }, from = { x, y: 0, z: stand.z - 0.4 };
    const up = walk(world, from, points, playerCapsule); assert.ok(up);
    assert.deepEqual(up.map((y) => +y.toFixed(2)), [0.18, 0.36, 0.54, 0.72]);
    const down = walk(world, { x, y: up.at(-1), z: points.at(-1)[1] }, points.slice(0, -1).reverse().concat([[x, from.z]]), playerCapsule);
    assert.ok(down); assert.equal(down.at(-1), 0);
  }
});

test('room authority rejects movement and in-reach switches during the basketball trip, then permits both again', () => {
  const { room, conn, player } = setupRoom();
  for (let i = 0; i < 120; i++) room.step();
  const station = gymDef.switches[1]; player.p = [station.x, station.y, station.z];
  const ball = room.gym.balls[0]; ball.p = [...player.p]; ball.v = [0, 0];
  room.step(); const frozen = [...player.p], at = room.tick * 0.05;
  assert.equal(room.gym.tripped(conn.id, at), true);
  room.handle(conn, { t: 'input', seq: 1, p: [player.p[0] + 0.1, player.p[1], player.p[2]], yaw: 0, pitch: 0, f: 0, c: player.c }, 10_000);
  room.handle(conn, { t: 'act', kind: 'gym-switch', id: 1 }, 10_000);
  assert.deepEqual(player.p, frozen); assert.equal(room.gym.switches.until[1], 0);
  for (let i = 0; i < 30; i++) room.step();
  assert.equal(room.gym.tripped(conn.id, room.tick * 0.05), false);
  room.handle(conn, { t: 'act', kind: 'gym-switch', id: 1 }, 12_000); assert.ok(room.gym.switches.until[1] > room.tick * 0.05);
  room.handle(conn, { t: 'input', seq: 2, p: [player.p[0] + 0.1, player.p[1], player.p[2]], yaw: 0, pitch: 0, f: 0, c: player.c }, 12_000);
  assert.ok(Math.abs(player.p[0] - frozen[0] - 0.1) < 0.00001);
});

test('both room monitors freeze when watched and descend from the top stand to catch an unwatched court player', () => {
  const { room } = setupRoom(true); assert.equal(room.monitors.length, 2);
  for (const monitor of room.monitors) {
    const start = [...monitor.p]; assert.equal(start[1], 0.72);
    const viewer = { id: 1, p: [start[0], 0, 65], yaw: Math.PI, f: 0 };
    monitor.forceHunt(start, 0); monitor.step(0.05, [viewer]);
    assert.equal(monitor.state, 'frozen'); assert.deepEqual(monitor.p, start);
    viewer.yaw = 0;
    for (let tick = 0; tick < 120 && !monitor.caught.length; tick++) monitor.step(0.05, [viewer]);
    assert.deepEqual(monitor.caught, [1]); assert.ok(monitor.p[1] < 0.1); assert.equal(monitor.state, 'hold');
  }
});
