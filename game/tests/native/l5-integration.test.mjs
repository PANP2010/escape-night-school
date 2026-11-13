import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Vite accepts the game's JSON imports; native Node needs this attribute.
registerHooks({ load(url, context, nextLoad) {
  return nextLoad(url, url.endsWith('.json')
    ? { ...context, importAttributes: { ...context.importAttributes, type: 'json' } }
    : context);
} });

const [{ Room, LEVEL_FADE_S }, { generateLevel, exitOpen, LEVELS }, { L5 },
  { objective }, { freshLoop }, { parseClientMsg }, { TICK_MS }] = await Promise.all([
  import('../../server/room.ts'), import('../../shared/level.ts'), import('../../shared/levels/l5.ts'),
  import('../../client/src/objective.ts'), import('../../shared/loop.ts'),
  import('../../shared/protocol.ts'), import('../../shared/constants.ts'),
]);

function setup(n = 1) {
  const room = new Room('INTEG', 42), inbox = new Map();
  for (let id = 1; id <= n; id++) {
    const messages = []; inbox.set(id, messages);
    room.add({ id, name: `player${id}`, send: (m) => messages.push(structuredClone(m)), sendRaw: (s) => messages.push(JSON.parse(s)) }, 0);
  }
  return { room, inbox };
}
const run = (room, seconds) => { for (let i = 0; i < Math.ceil(seconds * 1000 / TICK_MS); i++) room.step(); };
const last = (messages, type) => messages.filter((m) => m.t === type).at(-1);
function press(room, id, station) {
  const p = room.players.get(id), s = L5.gym.switches[station];
  p.p = [s.x, s.y, s.z + 0.6];
  return room.act(p, 'gym-switch', station);
}

test('shared exit and objective interfaces preserve keys, blackout and personal loop progress alongside L5', () => {
  assert.equal(LEVELS[4], L5); assert.equal(LEVELS.length, 5);
  assert.equal(exitOpen(generateLevel(0, 1), 0, {}), false);
  assert.equal(exitOpen(generateLevel(0, 1), 0, { stair_key: 1 }), true);
  const blackout = generateLevel(1, 1);
  assert.equal(exitOpen(blackout, blackout.def.blackout.fuses - 1, { stair_key: 1 }), false);
  assert.equal(exitOpen(blackout, blackout.def.blackout.fuses, {}), true);
  const corridor = generateLevel(2, 1), unsolved = freshLoop();
  assert.equal(exitOpen(corridor, 99, { stair_key: 1 }, unsolved), false);
  assert.equal(exitOpen(corridor, 0, {}, { ...unsolved, step: corridor.def.loop.sequence.length }), true);
  assert.equal(exitOpen(corridor, 99, { stair_key: 1 }, true), false);
  assert.equal(objective(corridor.def, {}, 0, unsolved).personal, true);
  assert.equal(objective(corridor.def, {}, 0, unsolved).cur, 0);
  const gym = generateLevel(4, 1);
  assert.equal(exitOpen(gym, 99, { stair_key: 1 }, { ...unsolved, step: 99 }), false);
  assert.equal(exitOpen(gym, 0, {}, true), true);
});

test('L5 rejects forged puzzle state and host-only test entry remains disabled in production', () => {
  assert.equal(parseClientMsg('{"t":"gym","complete":true}'), null);
  for (const id of [-1, 4.5, '1', null]) assert.equal(parseClientMsg(JSON.stringify({ t: 'act', kind: 'gym-switch', id })), null);
  assert.deepEqual(parseClientMsg('{"t":"act","kind":"gym-switch","id":3}'), { t: 'act', kind: 'gym-switch', id: 3 });
  const { room } = setup(2);
  room.handle(room.players.get(2).conn, { t: 'debug', op: 'level5' }, 0);
  assert.equal(room.levelIndex, 0);
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    room.handle(room.players.get(1).conn, { t: 'debug', op: 'level5' }, 0);
    assert.equal(room.levelIndex, 0); assert.equal(room.badMsgs, 1);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
  room.handle(room.players.get(1).conn, { t: 'debug', op: 'level5' }, 0);
  assert.equal(room.levelIndex, 4);
});

test('solo HUD uses authoritative deadlines and L5 completes before an explicit fresh load resets the puzzle', () => {
  const { room, inbox } = setup();
  room.handle(room.players.get(1).conn, { t: 'debug', op: 'level5' }, 0);
  const player = room.players.get(1);
  player.p = [L5.exit.x, L5.exit.y, L5.exit.z]; room.step();
  assert.equal(last(inbox.get(1), 'fade'), undefined);
  for (let station = 0; station < 4; station++) {
    assert.equal(press(room, 1, station), true);
    if (station < 3) {
      const hud = objective(L5, { stair_key: 1, fuse: 99 }, 99, room.gym.snapshot(room.tick * TICK_MS / 1000));
      assert.equal(hud.cur, 0); assert.match(hud.steps[0], /单人各锁定20秒/);
      assert.match(hud.got, new RegExp(`${station + 1}${L5.gym.switches[station].label}：亮 20.0秒`));
      player.p = [-90, 0.035, 60]; run(room, 4);
    }
  }
  assert.equal(room.gym.switches.complete, true);
  const unlocked = objective(L5, {}, 0, room.gym.snapshot(room.tick * TICK_MS / 1000));
  assert.equal(unlocked.cur, 1); assert.match(unlocked.got, /东门门禁解除/);
  player.p = [L5.exit.x, L5.exit.y, L5.exit.z]; room.step();
  assert.deepEqual(last(inbox.get(1), 'fade'), { t: 'fade', secs: LEVEL_FADE_S, restart: false });
  const frozen = [...player.p], oldEpoch = player.c;
  room.applyInput(player, { t: 'input', seq: 1, p: [-85, 0, 60], yaw: 0, pitch: 0, f: 0, c: oldEpoch }, 10_000);
  assert.deepEqual(player.p, frozen);
  run(room, LEVEL_FADE_S);
  assert.equal(room.levelIndex, 4); assert.equal(room.completed, true); assert.equal(room.gym.switches.complete, true);
  assert.deepEqual(last(inbox.get(1), 'complete'), { t: 'complete', level: 4 });
  assert.equal(player.c, oldEpoch);
  room.loadLevel(4);
  assert.equal(room.completed, false); assert.equal(room.gym.switches.complete, false);
  assert.deepEqual(room.gym.switches.until, [0, 0, 0, 0]); assert.equal(room.gym.balls.length, 0);
  assert.equal(player.c, oldEpoch + 1);
});

test('normal campaign ending requires the real L5 switches and completes exactly once', () => {
  const { room, inbox } = setup();
  room.loadLevel(LEVELS.length - 1);
  const player = room.players.get(1);
  assert.equal(room.level.def, L5);
  for (let station = 0; station < 4; station++) assert.equal(press(room, 1, station), true);
  player.p = [room.level.exit.x, room.level.exit.y, room.level.exit.z];
  room.step(); run(room, LEVEL_FADE_S);
  assert.equal(room.completed, true); assert.equal(room.levelIndex, LEVELS.length - 1);
  assert.deepEqual(last(inbox.get(1), 'complete'), { t: 'complete', level: LEVELS.length - 1 });
  assert.equal(room.level.def, L5);
  run(room, LEVEL_FADE_S);
  assert.equal(inbox.get(1).filter((m) => m.t === 'complete').length, 1);
});

test('both connections receive identical multiplayer deadlines and the last standing teammate gates exit', () => {
  const { room, inbox } = setup(2);
  room.handle(room.players.get(1).conn, { t: 'debug', op: 'level5' }, 0);
  for (let station = 0; station < 4; station++) assert.equal(press(room, station % 2 + 1, station), true);
  assert.deepEqual(last(inbox.get(1), 'gym'), last(inbox.get(2), 'gym'));
  assert.equal(last(inbox.get(1), 'gym').solo, false);
  room.players.get(1).p = [L5.exit.x, L5.exit.y, L5.exit.z]; room.step();
  assert.equal(last(inbox.get(1), 'fade'), undefined);
  room.players.get(2).p = [L5.exit.x, L5.exit.y, L5.exit.z]; room.step();
  assert.equal(last(inbox.get(1), 'fade').restart, false);
  assert.deepEqual(last(inbox.get(1), 'fade'), last(inbox.get(2), 'fade'));
});
