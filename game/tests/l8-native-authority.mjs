// Dependency-free checks of real TypeScript game modules. This is not Vitest.
// From the repository root:
//   node game/tests/l8-native-authority.mjs > game/test-results/l8-native-authority.log 2>&1
// Requires Node with native TypeScript stripping and module.registerHooks, plus
// the existing game/.cache/campus-nav.json. No dependency or cache files are written.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const gameUrl = new URL('../', import.meta.url);
const clientFinaleUrl = new URL('client/src/finale.ts', gameUrl).href;
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && new URL(url).pathname.endsWith('.json')) {
      return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
    }
    if (url === clientFinaleUrl) {
      const source = readFileSync(new URL(url), 'utf8');
      const unusedRenderingImport = /^import \* as THREE from ['"]three['"];\r?\n/m;
      assert.match(source, unusedRenderingImport, 'Expected the unused Three rendering import in client finale');
      // Only the pure exported objective/route functions are called. Rendering
      // functions and every game mechanism remain exactly as authored on disk.
      return { format: 'module-typescript', source: source.replace(unusedRenderingImport, ''), shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const [roomApi, protocol, constants, navApi, collision, doors, levels, interact, stamina, rng, guide, finale, dataModule] = await Promise.all([
  import(new URL('server/room.ts', gameUrl)),
  import(new URL('shared/protocol.ts', gameUrl)),
  import(new URL('shared/constants.ts', gameUrl)),
  import(new URL('shared/campus/nav.ts', gameUrl)),
  import(new URL('shared/campus/collision.ts', gameUrl)),
  import(new URL('shared/doors.ts', gameUrl)),
  import(new URL('shared/level.ts', gameUrl)),
  import(new URL('shared/interact.ts', gameUrl)),
  import(new URL('shared/stamina.ts', gameUrl)),
  import(new URL('shared/rng.ts', gameUrl)),
  import(new URL('client/src/guide.ts', gameUrl)),
  import(clientFinaleUrl),
  import(new URL('shared/campus/colliders.json', gameUrl)),
]);
const { RoomManager, FINALE_CHASE_S, FINALE_RESCUE_S, LEVEL_FADE_S, REVIVE_S, ROLLCALL_R } = roomApi;
const { ST_OK, ST_DOWN, ST_SPECTATE, F_RUN } = protocol;
const { TICK_MS, SPEED } = constants;
const { NavGraph, NAV_CAPSULE, lineOfSight } = navApi;
const { CollisionWorld, moveCapsule, overlaps } = collision;
const { campusDoorSlab } = doors;
const { levelSolids } = levels;
const { boxAt, inReach } = interact;
const { canRun } = stamina;
const { mulberry32 } = rng;
const { guideWaypoint, navFromMsg, shutDoorOn } = guide;
const { advanceFinaleRoute, finaleGoalPoint } = finale;
const campusData = dataModule.default;

assert.ok(roomApi.debugEnabled(), 'Existing debug commands must be enabled to stage these deterministic scenarios');
console.log('Native Node assertions, not Vitest. Real Room/AI/collision/guide code; no game methods mocked.');
console.log('Boundary fixtures use existing debug commands and explicit starting positions. The guide escape uses ordinary input only after roll call.');

function stepTicks(room, count) { for (let i = 0; i < count; i++) room.step(); }
function tickCount(seconds) {
  const n = seconds * 1000 / TICK_MS;
  assert.ok(Math.abs(n - Math.round(n)) < 1e-8, 'Scenario duration must use whole server ticks');
  return Math.round(n);
}
function stepSeconds(room, seconds) { stepTicks(room, tickCount(seconds)); }
function send(s, id, message) { s.room.handle(s.conns.get(id), message, s.room.tick * TICK_MS); }
function latest(s, id, type) { return s.messages.get(id).findLast(m => m.t === type); }
function state(s, id = s.room.host) { return latest(s, id, 'finale'); }
function join(s, id) {
  const messages = [];
  const conn = { id, name: `native-player-${id}`, send: m => messages.push(m), sendRaw: raw => messages.push(JSON.parse(raw)) };
  s.conns.set(id, conn); s.messages.set(id, messages);
  s.room.add(conn, s.room.tick * TICK_MS);
  return s.room.players.get(id);
}
function setup(count = 2, { level = 7, lobbySeconds = 0, graph } = {}) {
  const s = { room: new RoomManager(mulberry32(88), graph ? () => graph : undefined).create(true), conns: new Map(), messages: new Map() };
  for (let id = 1; id <= count; id++) join(s, id);
  stepSeconds(s.room, lobbySeconds);
  s.startedAt = s.room.tick;
  send(s, 1, { t: 'start' });
  if (level !== 0) send(s, 1, { t: 'debug', op: 'level', level });
  assert.equal(s.room.started, true);
  assert.equal(s.room.levelIndex, level);
  return s;
}
function approachBook(s, id = s.room.host) {
  const b = s.room.level.def.finale.rollcall;
  s.room.players.get(id).p = [b.x, b.y, b.z + 1.45];
}
function crossAll(s, id = s.room.host) {
  approachBook(s, id);
  for (const member of state(s, id).members) if (member.status !== 'left') send(s, id, { t: 'act', kind: 'rollcall', id: member.id });
  s.room.step();
  assert.equal(state(s, id).phase, 'chase');
}
function safeZone(s, id) {
  const e = s.room.level.exit;
  send(s, id, { t: 'debug', op: 'tp', x: e.x, z: e.z, floor: 0 });
}
function movementWorld(s) {
  const world = new CollisionWorld([...s.room.world.boxes, ...levelSolids(s.room.level.def),
    ...s.room.doors.map(d => campusDoorSlab(d, s.room.doorOpen[d.id]))]);
  for (const h of campusData.holes) world.addHole(h.x0, h.x1, h.z0, h.z1);
  return world;
}

let passed = 0, failed = 0;
function check(name, fn) {
  try {
    const details = fn();
    passed++;
    console.log(`PASS ${name}${details ? ` ${JSON.stringify(details)}` : ''}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}\n${error.stack ?? error}`);
  }
}

check('whole-run time/downs include earlier chapters, exclude lobby, freeze at completion, and reset on explicit replay', () => {
  const s = setup(2, { level: 0, lobbySeconds: 12 }), seed = s.room.seed;
  stepSeconds(s.room, 10);
  send(s, 1, { t: 'debug', op: 'down' });
  send(s, 1, { t: 'debug', op: 'level', level: 1 });
  stepSeconds(s.room, 5);
  send(s, 2, { t: 'debug', op: 'down' });
  send(s, 1, { t: 'debug', op: 'level', level: 7 });
  assert.equal(state(s).downs, 2);
  assert.deepEqual(state(s).members.map(m => m.downs), [1, 1]);
  crossAll(s);
  safeZone(s, 1); safeZone(s, 2); s.room.step();
  const result = latest(s, 1, 'completed');
  assert.ok(result);
  assert.equal(result.elapsedMs, (s.room.tick - s.startedAt) * TICK_MS);
  assert.equal(result.downs, 2);
  assert.deepEqual(result.members.map(m => [m.downs, m.escaped]), [[1, true], [1, true]]);
  stepSeconds(s.room, 2);
  join(s, 9);
  assert.deepEqual(latest(s, 9, 'completed'), result);
  assert.equal(state(s, 9).elapsedMs, result.elapsedMs);
  send(s, 1, { t: 'restart' });
  stepSeconds(s.room, LEVEL_FADE_S);
  assert.equal(s.room.seed, seed);
  assert.equal(s.room.levelIndex, 7);
  assert.equal(state(s).phase, 'rollcall');
  assert.equal(state(s).downs, 0);
  assert.ok(state(s).members.every(m => m.downs === 0));
  assert.equal(state(s).elapsedMs, 0);
  return { completedMs: result.elapsedMs, earlierChapterDowns: result.downs, replayMs: state(s).elapsedMs };
});

check('first escape at chase 170 seconds grants a full 45-second extraction window', () => {
  const s = setup(); crossAll(s);
  // Existing debug safety stages the clock boundary without mocking AI or timers.
  send(s, 1, { t: 'debug', op: 'safe', s: FINALE_CHASE_S + FINALE_RESCUE_S + 10 });
  stepSeconds(s.room, FINALE_CHASE_S - 10);
  safeZone(s, 1); s.room.step();
  const escapeTick = s.room.tick;
  assert.equal(state(s).rescueMs, FINALE_RESCUE_S * 1000);
  stepSeconds(s.room, 10);
  assert.equal(s.room.players.get(2).st, ST_OK);
  assert.equal(latest(s, 1, 'completed'), undefined);
  stepTicks(s.room, tickCount(FINALE_RESCUE_S - 10) - 1);
  assert.equal(s.room.players.get(2).st, ST_OK);
  assert.equal(latest(s, 1, 'completed'), undefined);
  s.room.step();
  assert.equal((s.room.tick - escapeTick) * TICK_MS, FINALE_RESCUE_S * 1000);
  assert.equal(s.room.players.get(2).st, ST_SPECTATE);
  assert.deepEqual(latest(s, 1, 'completed'), latest(s, 2, 'completed'));
  assert.deepEqual(latest(s, 1, 'completed').members.map(m => m.escaped), [true, false]);
  return { extractionWindowMs: (s.room.tick - escapeTick) * TICK_MS };
});

check('roll-call rejects remote/downed/forged/duplicate actions and the actual office wall blocks in-range sight', () => {
  const s = setup(), b = s.room.level.def.finale.rollcall;
  send(s, 1, { t: 'act', kind: 'rollcall', id: 1 });
  assert.ok(state(s).members.every(m => !m.crossedOut));
  approachBook(s);
  send(s, 1, { t: 'act', kind: 'rollcall', id: 9999 });
  assert.ok(state(s).members.every(m => !m.crossedOut));
  send(s, 1, { t: 'debug', op: 'down' });
  send(s, 1, { t: 'act', kind: 'rollcall', id: 1 });
  assert.ok(state(s).members.every(m => !m.crossedOut));
  send(s, 2, { t: 'debug', op: 'level', level: 7 });
  // A direct fixture at the real partition line isolates LOS from reach. It is
  // deliberately not a movement claim; ordinary movement is checked separately.
  const p = [b.x, 0, 128.8], box = boxAt([b.x, b.y, b.z], ROLLCALL_R, 1.4);
  assert.equal(inReach(p, box.min, box.max), true);
  assert.equal(lineOfSight(movementWorld(s), { x: p[0], y: 1.5, z: p[2] }, { x: b.x, y: b.y + 0.98, z: b.z }), false);
  s.room.players.get(1).p = p;
  send(s, 1, { t: 'act', kind: 'rollcall', id: 1 });
  assert.ok(state(s).members.every(m => !m.crossedOut));
  approachBook(s);
  send(s, 1, { t: 'act', kind: 'rollcall', id: 1 });
  const revision = state(s).revision;
  send(s, 1, { t: 'act', kind: 'rollcall', id: 1 });
  assert.equal(state(s).revision, revision);
  assert.equal(state(s).members.filter(m => m.crossedOut).length, 1);
});

check('the real pursuer catches a stationary player in place and records exactly one down', () => {
  const s = setup(1); crossAll(s);
  const pl = s.room.players.get(1), position = [...pl.p], fromTick = s.room.tick;
  const world = movementWorld(s);
  assert.equal(overlaps(world, { x: position[0], y: position[1], z: position[2], vy: 0, grounded: true }, NAV_CAPSULE), false);
  while (pl.st === ST_OK && s.room.tick - fromTick < tickCount(20)) s.room.step();
  assert.equal(pl.st, ST_DOWN);
  assert.deepEqual(pl.p, position);
  stepSeconds(s.room, 1);
  assert.equal(s.messages.get(1).filter(m => m.t === 'caught').length, 1);
  assert.equal(state(s).downs, 1);
  assert.equal(state(s).members[0].downs, 1);
  return { caughtWithinMs: (s.room.tick - fromTick) * TICK_MS - 1000 };
});

check('ordinary hold-to-revive succeeds and automatic wipe preserves accumulated downs', () => {
  const s = setup(); crossAll(s);
  send(s, 1, { t: 'debug', op: 'safe', s: 60 });
  send(s, 2, { t: 'debug', op: 'down' });
  s.room.players.get(1).p = [...s.room.players.get(2).p];
  for (let i = 0; i <= tickCount(REVIVE_S); i++) {
    send(s, 1, { t: 'act', kind: 'revive', id: 2 }); s.room.step();
  }
  assert.equal(s.room.players.get(2).st, ST_OK);
  assert.equal(s.room.players.get(2).heldUntil, undefined);
  assert.equal(state(s).downs, 1);
  send(s, 1, { t: 'debug', op: 'down', s: 1 });
  send(s, 2, { t: 'debug', op: 'down', s: 1 });
  const beforeWipeMs = state(s).elapsedMs;
  stepSeconds(s.room, 1 + LEVEL_FADE_S + 0.1);
  assert.equal(state(s).phase, 'rollcall');
  assert.equal(state(s).downs, 3);
  assert.deepEqual(state(s).members.map(m => m.downs), [1, 2]);
  assert.ok(state(s).elapsedMs > beforeWipeMs);
  assert.ok(state(s).members.every(m => !m.crossedOut));
});

check('late joins observe the current attempt, cannot extract, and enter play after a wipe', () => {
  const s = setup(); crossAll(s);
  const late = join(s, 9);
  assert.equal(late.st, ST_SPECTATE);
  assert.equal(state(s, 9).phase, 'chase');
  assert.deepEqual(state(s, 9).members.map(m => m.id), [1, 2]);
  safeZone(s, 9); s.room.step();
  assert.notEqual(late.escaped, true);
  send(s, 1, { t: 'debug', op: 'down', s: 1 });
  send(s, 2, { t: 'debug', op: 'down', s: 1 });
  stepSeconds(s.room, 1 + LEVEL_FADE_S + 0.1);
  assert.equal(late.st, ST_OK);
  assert.equal(state(s, 9).phase, 'rollcall');
  assert.deepEqual(state(s, 9).members.map(m => m.id), [1, 2, 9]);
});

check('an observer left alone after participant disconnect becomes the active host after reset', () => {
  const s = setup(1), late = join(s, 9);
  s.room.remove(s.conns.get(1), s.room.tick * TICK_MS);
  stepSeconds(s.room, LEVEL_FADE_S + 0.1);
  assert.equal(s.room.host, 9);
  assert.equal(late.st, ST_OK);
  assert.equal(state(s, 9).phase, 'rollcall');
  crossAll(s, 9);
});

check('joining during a same-seed wipe receives the remaining fade before the new roll-call state', () => {
  const s = setup(1); crossAll(s);
  const seed = s.room.seed;
  send(s, 1, { t: 'debug', op: 'down', s: 1 });
  stepSeconds(s.room, 1.5);
  const late = join(s, 9), messages = s.messages.get(9), fade = latest(s, 9, 'fade');
  assert.ok(fade);
  assert.equal(fade.restart, true);
  assert.equal(fade.secs, LEVEL_FADE_S - 0.5);
  assert.equal(state(s, 9).phase, 'chase');
  assert.ok(messages.findIndex(m => m.t === 'room') < messages.findIndex(m => m.t === 'fade'));
  assert.ok(messages.findIndex(m => m.t === 'finale') < messages.findIndex(m => m.t === 'fade'));
  stepSeconds(s.room, fade.secs);
  assert.equal(s.room.seed, seed);
  assert.equal(s.room.levelIndex, 7);
  assert.equal(state(s, 9).phase, 'rollcall');
  assert.equal(late.st, ST_OK);
  return { replayedFadeSeconds: fade.secs };
});

check('the 180-second unassisted deadline automatically restarts the same seed', () => {
  const s = setup(1); crossAll(s);
  const seed = s.room.seed;
  send(s, 1, { t: 'debug', op: 'safe', s: FINALE_CHASE_S + 10 });
  stepTicks(s.room, tickCount(FINALE_CHASE_S) - 1);
  assert.equal(latest(s, 1, 'fade'), undefined);
  assert.equal(s.room.players.get(1).st, ST_OK);
  s.room.step();
  assert.equal(latest(s, 1, 'fade').restart, true);
  assert.equal(s.room.players.get(1).st, ST_SPECTATE);
  stepSeconds(s.room, LEVEL_FADE_S);
  assert.equal(s.room.seed, seed);
  assert.equal(s.room.levelIndex, 7);
  assert.equal(state(s).phase, 'rollcall');
  assert.ok(state(s).elapsedMs >= (FINALE_CHASE_S + LEVEL_FADE_S) * 1000);
});

check('an escaped participant stays in the result after disconnect when only an observer remains', () => {
  const s = setup(); crossAll(s);
  safeZone(s, 1); s.room.step();
  join(s, 9);
  for (const id of [1, 2]) s.room.remove(s.conns.get(id), s.room.tick * TICK_MS);
  s.room.step();
  assert.equal(s.room.host, 9);
  assert.equal(state(s, 9).phase, 'complete');
  assert.deepEqual(latest(s, 9, 'completed').members.map(m => [m.id, m.escaped]), [[1, true], [2, false]]);
});

check('pure client objectives exclude departed names and distinguish the chase clock from the extraction clock', () => {
  const s = { t: 'finale', revision: 1, phase: 'rollcall', elapsedMs: 1000, downs: 0,
    members: [{ id: 1, name: '甲', crossedOut: true, status: 'playing', downs: 0 },
      { id: 2, name: '乙', crossedOut: false, status: 'left', downs: 0 }] };
  assert.equal(finale.finaleObjective(s).got, '已划名：1/1');
  assert.equal(finale.finaleStatusText(s), '划掉全队名字 · 1/1');
  assert.match(finale.finaleStatusText({ ...s, phase: 'chase', remainingMs: 10000, rescueMs: 45000 }), /队伍撤离剩余 00:45/);
  assert.match(finale.finaleObjective({ ...s, phase: 'chase', remainingMs: 10000, rescueMs: 45000 }).got, /撤离剩余 00:45/);
  assert.equal(finale.formatClock(3661000), '1:01:01');
  assert.equal(finale.formatClock(-1000), '00:00');
});

function escapeWithNavigation(mode) {
  const cache = JSON.parse(readFileSync(new URL('.cache/campus-nav.json', gameUrl), 'utf8'));
  assert.ok(Array.isArray(cache.nodes) && cache.nodes.length > 0);
  assert.equal(cache.adj.length, cache.nodes.length);
  assert.ok(cache.nodes.every(n => [n.x, n.y, n.z].every(Number.isFinite)));
  assert.ok(cache.adj.every(edges => Array.isArray(edges) && edges.every(i => Number.isInteger(i) && i >= 0 && i < cache.nodes.length)));
  const campusGraph = new NavGraph();
  campusGraph.nodes.push(...cache.nodes); campusGraph.adj.push(...cache.adj);
  const s = setup(1, { graph: campusGraph }); crossAll(s);
  const nav = latest(s, 1, 'nav'), graph = navFromMsg(nav.n, nav.adj), world = movementWorld(s);
  assert.ok(graph?.nodes.length);
  const player = s.room.players.get(1), def = s.room.level.def.finale;
  const dt = TICK_MS / 1000, guideTicks = tickCount(0.25), chaseTick = s.room.tick;
  let index = 0, waypoint = def.route[0], minGap = Infinity, mobDistance = 0, ranTicks = 0, walkedTicks = 0;
  let previousMob = [...s.room.finaleAI.p];
  for (let tick = 1; tick <= tickCount(90) && !player.escaped && player.st === ST_OK; tick++) {
    const from = { x: player.p[0], y: player.p[1], z: player.p[2] };
    if (mode === 'authored') {
      // The browser turns before reaching each exact point. Keep the real .3 m
      // arrival radius so tight grate corners cannot hide behind centred leg checks.
      while (index < def.route.length - 1 && Math.hypot(def.route[index].x - from.x, def.route[index].z - from.z) < 0.3) index++;
      waypoint = def.route[index];
    } else if ((tick - 1) % guideTicks === 0) {
      index = advanceFinaleRoute(def.route, from, index);
      waypoint = guideWaypoint(graph, from, finaleGoalPoint('chase', def, index),
        (a, b) => lineOfSight(world, a, b), (a, b) => shutDoorOn(s.room.doors, s.room.doorOpen, a, b));
    }
    const running = canRun(player.stamina, player.exhausted);
    if (running) ranTicks++; else walkedTicks++;
    const dx = waypoint.x - from.x, dz = waypoint.z - from.z, distance = Math.hypot(dx, dz);
    const budget = Math.min(distance, (running ? SPEED.run : SPEED.walk) * dt), body = { ...from, vy: 0, grounded: true };
    moveCapsule(world, body, distance ? dx / distance * budget : 0, distance ? dz / distance * budget : 0, dt, NAV_CAPSULE);
    send(s, 1, { t: 'input', seq: tick, p: [body.x, body.y, body.z], yaw: Math.atan2(-dx, -dz), pitch: 0, f: running ? F_RUN : 0, c: player.c });
    s.room.step();
    const mob = s.room.finaleAI.p;
    assert.equal(overlaps(world, { x: mob[0], y: mob[1], z: mob[2], vy: 0, grounded: true }, NAV_CAPSULE), false);
    mobDistance += Math.hypot(mob[0] - previousMob[0], mob[2] - previousMob[2]); previousMob = [...mob];
    minGap = Math.min(minGap, Math.hypot(mob[0] - player.p[0], mob[2] - player.p[2]));
  }
  assert.equal(player.escaped, true, `Stopped at ${player.p}, route ${index}, pursuer gap ${minGap}`);
  assert.equal(player.st, ST_OK);
  assert.equal(index, def.route.length - 1);
  const corrections = s.messages.get(1).filter(m => m.t === 'correct' && !m.forced).length;
  assert.equal(corrections, 0);
  assert.ok(ranTicks > 0 && walkedTicks > 0);
  assert.ok(mobDistance > 100);
  assert.ok(minGap > 0.8);
  assert.equal(latest(s, 1, 'completed').members[0].escaped, true);
  assert.equal(latest(s, 1, 'completed').downs, 0);
  return { chaseSeconds: (s.room.tick - chaseTick) * dt, corrections, minGap, mobDistance, ranTicks, walkedTicks, cachedNavNodes: campusGraph.nodes.length };
}

check('actual cached nav and 4 Hz guide escape with ordinary stamina, zero rejected inputs, and real pursuit', () => escapeWithNavigation('guide'));
check('continuous authored route turns with ordinary stamina, zero rejected inputs, and real pursuit', () => escapeWithNavigation('authored'));

console.log(`RESULT ${passed} passed, ${failed} failed. Native Node assertions only; no browser, Vitest runner, or dependency installation.`);
if (failed) process.exitCode = 1;
