import assert from 'node:assert/strict';
import { MidnightBroadcast, type BroadcastPlayer } from '../server/broadcast.ts';
import { L4, L4_INDEX } from '../shared/levels/l4.ts';
import { L5, L5_INDEX } from '../shared/levels/l5.ts';
import { exitOpen, generateLevel, inArea, levelSolids, LEVELS } from '../shared/level.ts';
import { parseClientMsg, ST_OK, ST_DOWN, ST_SPECTATE, F_HIDE, type ServerMsg, type Vec3 } from '../shared/protocol.ts';
import { Room, LEVEL_FADE_S, levelAreaNav } from '../server/room.ts';
import { objective } from '../client/src/objective.ts';
import { hideTarget } from '../shared/interact.ts';
import { campusNavCached } from '../client/src/campus/world/navcache.ts';
import { CollisionWorld, groundHeight, overlaps, type AABB } from '../shared/campus/collision.ts';
import { NAV_CAPSULE, walk } from '../shared/campus/nav.ts';
import campusData from '../shared/campus/colliders.json';

const def = L4.broadcast!;
const station = (seed = 4) => new MidnightBroadcast(def, seed);
const player = (at = def.console, id = 1): BroadcastPlayer => ({ id, p: [at.x, at.y, at.z], st: ST_OK, hidden: false });
const readAll = (s: MidnightBroadcast) => def.stickers.forEach((at, id) => assert.equal(s.read(player(at), id), true));
const setup = (nav?: ReturnType<typeof campusNavCached>['graph']) => {
  const room = new Room('L4AB', 4, nav, L4_INDEX), inbox = new Map<number, ServerMsg[]>();
  const add = (id: number) => { const messages: ServerMsg[] = []; inbox.set(id, messages); const c = { id, name: `同学${id}`, send: (m: ServerMsg) => messages.push(m), sendRaw: (s: string) => messages.push(JSON.parse(s)) }; room.add(c, 0); return c; };
  const a = add(1), b = add(2);
  return { room, a, b, inbox, add };
};
const steps = (room: Room, secs: number) => { for (let i = 0; i < secs * 20; i++) room.step(); };

export function l4Cases(it: (name: string, fn: () => void) => unknown) {
  it('L4 follows the genuine L3 at index 3 and leads to the real L5', () => {
    assert.notEqual(LEVELS[2], L4); assert.equal(LEVELS[3], L4); assert.equal(LEVELS.length, 8); assert.equal(LEVELS[4], L5); assert.equal(generateLevel(3, 1).def, L4); assert.equal(generateLevel(1, 1).def.building, 'B');
    assert.deepEqual(L4.floors, [3, 4]); assert.equal(L4.spawns.length, 4);
    for (const p of [...L4.spawns, ...def.stickers, def.console, L4.exit, ...L4.hides]) assert.ok(inArea(generateLevel(3, 1), p.x, p.y!, p.z));
  });
  it('password is deterministic, four numeric digits, supports leading zeros, and snapshots disclose only read clues', () => {
    const s = station(); assert.deepEqual(s.digits, station().digits); assert.match(s.digits.join(''), /^\d{4}$/);
    assert.deepEqual(s.snapshot(0, []).clues, [null, null, null, null]); assert.equal('digits' in s.snapshot(0, []), false);
    const seeds = Array.from({ length: 100 }, (_, seed) => station(seed)); assert.ok(seeds.some(s => s.digits[0] === '0'));
    assert.ok(new Set(seeds.map(s => s.digits.join(''))).size > 90);
  });
  it('read requires server reach, correct floor, alive status and no hiding; duplicate reads are safe', () => {
    const s = station(), at = def.stickers[0];
    assert.equal(s.read(player(), 0), false); assert.equal(s.read({ ...player(at), p: [at.x, at.y + 3.6, at.z] }, 0), false);
    assert.equal(s.read({ ...player(at), hidden: true }, 0), false); assert.equal(s.read({ ...player(at), st: ST_DOWN }, 0), false);
    assert.equal(s.read(player(at), 9), false); assert.equal(s.read(player(at), 0), true); assert.equal(s.read(player(at), 0), true);
    assert.deepEqual(s.clues, [s.digits[0], null, null, null]);
  });
  it('console requires four collected stickers and exact ordered code, enforces cooldown and reaches off exactly once', () => {
    const s = station(), p = player(), code = s.digits.join('');
    assert.equal(s.submit(p, code, 0), 'missing'); readAll(s);
    const wrong = String((Number(code) + 1) % 10000).padStart(4, '0');
    assert.equal(s.submit(p, wrong, 1), 'wrong'); assert.equal(s.off, false); assert.equal(s.submit(p, code, 1.5), 'refused');
    assert.equal(s.submit({ ...p, p: [p.p[0], 7.2, p.p[2]] }, code, 2), 'refused');
    assert.equal(s.submit({ ...p, hidden: true }, code, 2), 'refused');
    assert.equal(s.submit(p, code, 2), 'off'); assert.equal(s.submit(p, code, 3), 'refused');
    s.step(1000, [p]); assert.equal(s.snapshot(1000, [p]).call, null); assert.equal(s.snapshot(1000, [p]).nextIn, 0);
  });
  it('all scheduled calls occur 60–90 seconds apart and expose an eligible player for exactly 10 seconds', () => {
    const s = station(), p = player();
    for (let i = 0; i < 20; i++) {
      const at = s.nextAt; assert.ok(at >= 60); s.step(at - .01, [p]); assert.equal(s.snapshot(at - .01, [p]).call, null);
      s.step(at, [p]); assert.equal(s.snapshot(at, [p]).call?.id, 1); assert.equal(s.snapshot(at, [p]).call?.left, 10);
      assert.ok(s.nextAt - at >= 60 && s.nextAt - at <= 90); assert.ok(s.snapshot(at + 9.99, [p]).call);
      s.step(at + 10, [p]); assert.equal(s.snapshot(at + 10, [p]).call, null);
    }
  });
  it('calls ignore downed/spectator players and clear a disconnected target', () => {
    const s = station(); s.step(s.nextAt, [{ ...player(), st: ST_DOWN }, { ...player(), id: 2, st: ST_SPECTATE }]); assert.equal(s.call, null);
    const at = s.nextAt; s.step(at, [player()]); assert.equal(s.snapshot(at, [player()]).call?.id, 1); s.step(at + 1, []); assert.equal(s.call, null);
  });
  it('locker/booth shielding suppresses location immediately, exit resumes the remaining exposure, movement tracks latest position', () => {
    const s = station(), p = player(), at = s.nextAt; s.step(at, [p]); p.p = [-12, 7.2, 130];
    assert.deepEqual(s.snapshot(at + 1, [p]).call?.p, p.p);
    p.hidden = true; const shielded = s.snapshot(at + 2, [p]).call; assert.equal(shielded?.shielded, true); assert.equal('p' in shielded!, false);
    p.hidden = false; assert.deepEqual(s.snapshot(at + 3, [p]).call?.p, p.p); assert.equal(s.snapshot(at + 3, [p]).call?.left, 7);
  });
  it('malformed and oversized protocol answers never reach puzzle handlers', () => {
    for (const code of ['123', '12345', 'abcd', 1234, '\n1234', '１２３４']) assert.equal(parseClientMsg(JSON.stringify({ t: 'broadcast', op: 'code', code })), null);
    for (const id of [-1, 4, .1, '1']) assert.equal(parseClientMsg(JSON.stringify({ t: 'broadcast', op: 'read', id })), null);
    assert.deepEqual(parseClientMsg('{"t":"broadcast","op":"code","code":"0012"}'), { t: 'broadcast', op: 'code', code: '0012' });
  });
  it('multiplayer room shares clues/off on both connections and full state with late joiners', () => {
    const { room, a, b, inbox, add } = setup();
    for (const [id, at] of def.stickers.entries()) { const c = id % 2 ? b : a; room.players.get(c.id)!.p = [at.x, at.y, at.z]; room.handle(c, { t: 'broadcast', op: 'read', id }, 0); }
    const last = (id: number) => inbox.get(id)!.filter(m => m.t === 'broadcast').at(-1);
    assert.deepEqual(last(1), last(2)); assert.deepEqual((last(1) as any).clues, room.broadcastStation!.digits);
    const at = def.console; room.players.get(2)!.p = [at.x, at.y, at.z]; room.handle(b, { t: 'broadcast', op: 'code', code: room.broadcastStation!.digits.join('') }, 0);
    assert.equal((last(1) as any).off, true); add(3); assert.deepEqual(last(3), last(1));
  });
  it('keypad rejection gives the sender retry feedback without sharing errors or changing station progress', () => {
    const { room, a, b, inbox } = setup(), station = room.broadcastStation!, p = room.players.get(a.id)!;
    readAll(station); const at = def.console, code = station.digits.join('');
    p.p = [at.x, at.y, at.z];
    const wrong = String((Number(code) + 1) % 10000).padStart(4, '0');
    room.handle(a, { t: 'broadcast', op: 'code', code: wrong }, 0);
    room.handle(a, { t: 'broadcast', op: 'code', code }, 0);
    assert.equal(station.off, false);
    assert.ok(inbox.get(a.id)!.some(m => m.t === 'error' && /稍等一秒/.test(m.msg)));
    assert.equal(inbox.get(b.id)!.some(m => m.t === 'error'), false);
    steps(room, 1.1);
    p.p = [-18, 7.2, 130];
    room.handle(a, { t: 'broadcast', op: 'code', code }, 1100);
    assert.equal(station.off, false);
    assert.ok(inbox.get(a.id)!.filter(m => m.t === 'error').at(-1)?.msg.includes('离开广播台'));
    p.p = [at.x, at.y, at.z]; room.handle(a, { t: 'broadcast', op: 'code', code }, 1100);
    assert.equal(station.off, true);
  });
  it('hidden/downed/frozen room players cannot read or enter codes, and client F_HIDE cannot grant shielding', () => {
    const { room, a } = setup(), at = def.stickers[0], p = room.players.get(1)!;
    p.p = [at.x, at.y, at.z]; p.st = ST_DOWN; room.handle(a, { t: 'broadcast', op: 'read', id: 0 }, 0); assert.equal(room.broadcastStation!.clues[0], null);
    p.st = ST_OK; room.applyInput(p, { t: 'input', seq: 1, p: [...p.p], yaw: 0, pitch: 0, f: F_HIDE }, 50); assert.equal(p.f & F_HIDE, 0);
    (room as any).advanceAt = 20; room.handle(a, { t: 'broadcast', op: 'read', id: 0 }, 0); assert.equal(room.broadcastStation!.clues[0], null);
  });
  it('same-xz hiding on a different floor is refused by both client selection and server; lockers and booths really set authoritative hiding', () => {
    const { room, a } = setup(), p = room.players.get(a.id)!;
    for (const id of [0, 2]) { const h = L4.hides[id]; p.p = [h.x, h.y! + 3.6, h.z]; assert.equal(room.hideIn(p, id), false);
      p.p = [h.x, h.y!, h.z]; assert.equal(room.hideIn(p, id), true); assert.ok(p.f & F_HIDE); assert.ok(room.unhide(p)); }
    assert.equal(hideTarget([L4.hides[0]], L4.hides[0].x, L4.hides[0].z, 0, 1.2, 10.8), -1);
  });
  it('exit ignores stair keys/fuses and requires station off plus every standing survivor at the 3F exit', () => {
    const { room, a, b, inbox } = setup(), e = L4.exit;
    assert.equal(exitOpen(room.level, 99, { stair_key: 1 }), false); assert.equal(exitOpen(room.level, 0, {}, true), true);
    room.players.get(a.id)!.p = [e.x, e.y, e.z]; room.players.get(b.id)!.p = [e.x, e.y, e.z]; room.bag.stair_key = 1;
    room.step(); assert.equal(inbox.get(1)!.some(m => m.t === 'fade'), false);
    room.broadcastStation!.off = true; room.players.get(b.id)!.p = [-20, 7.2, 130]; room.step(); assert.equal(inbox.get(1)!.some(m => m.t === 'fade'), false);
    room.players.get(b.id)!.p = [e.x, e.y + 3.6, e.z]; room.step(); assert.equal(inbox.get(1)!.some(m => m.t === 'fade'), false);
    room.players.get(b.id)!.p = [e.x, e.y, e.z]; room.step(); assert.ok(inbox.get(1)!.some(m => m.t === 'fade' && !m.restart));
    steps(room, LEVEL_FADE_S);
    assert.equal(room.completed, false); assert.equal(room.levelIndex, L5_INDEX);
    assert.equal(room.level.def, L5); assert.equal(room.broadcastStation, undefined);
    assert.ok(room.gym, 'L4 gathering must load the actual L5 puzzle');
    assert.equal(room.gym.switches.complete, false); assert.deepEqual(room.gym.switches.until, [0, 0, 0, 0]);
    for (const messages of inbox.values()) {
      assert.equal(messages.some(m => m.t === 'complete'), false);
      assert.ok(messages.some(m => m.t === 'room' && m.level === L5_INDEX));
      assert.ok(messages.some(m => m.t === 'gym' && !m.complete));
    }
  });
  it('HUD exposes collection, code order and exit as three real objective stages', () => {
    const s = station(); assert.equal(objective(L4, {}, 0, s.snapshot(0, [])).cur, 0); readAll(s);
    assert.equal(objective(L4, {}, 0, s.snapshot(0, [])).cur, 1); s.submit(player(), s.digits.join(''), 0);
    const o = objective(L4, {}, 0, s.snapshot(0, [])); assert.equal(o.cur, 2); assert.match(o.steps[2], /三楼/);
  });
  it('real campus nav connects both floors, every spawn, sticker, shelter, console and exit; routes respect capsule collision', () => {
    const full = campusNavCached('test-results/l4-campus-nav.json').graph, lv = generateLevel(3, 4), nav = levelAreaNav(full, lv);
    const at = (p: { x: number; y?: number; z: number }) => nav.nearest(p.x, p.y ?? 7.2, p.z);
    const reach = nav.reachable(at(L4.spawns[0]));
    for (const p of [...L4.spawns, ...def.stickers, def.console, L4.exit, ...L4.hides]) { const n = nav.nodes[at(p)]; assert.ok(Math.abs(n.y - p.y!) < .4, JSON.stringify(p)); assert.ok(reach.has(at(p)), JSON.stringify(p)); }
    const world = new CollisionWorld([...(campusData.colliders as AABB[]), ...levelSolids(L4)]); for (const h of campusData.holes) world.addHole(h.x0, h.x1, h.z0, h.z1);
    for (const p of [...L4.spawns, L4.exit]) { assert.ok(!overlaps(world, { x: p.x, y: p.y!, z: p.z, vy: 0, grounded: true }, NAV_CAPSULE)); assert.ok(Math.abs(groundHeight(world, p.x, p.z, .24, p.y! + .3) - p.y!) < .1); }
    assert.equal(walk(world, { x: -12, y: 7.2, z: 135.52 }, [[-9, 135.52]]), null, 'lower flight must be physically sealed before the soft region boundary');
    for (const h of L4.hides) { const n = nav.nodes[at(h)]; assert.ok(walk(world, n, [[h.x, h.z - .7]]), `shelter ${JSON.stringify(h)}`); }
    for (const p of [...def.stickers, def.console]) { const n = nav.nodes[at(p)]; const z = p.z + ('face' in p && p.face === 'z+' ? .6 : -.6); assert.ok(walk(world, n, [[p.x, z]]), JSON.stringify(p)); }
  });
  it('L4 stair graph crosses the enclosure only through a capsule-clear doorway', () => {
    const nav = levelAreaNav(campusNavCached('test-results/l4-campus-nav.json').graph, generateLevel(3, 4));
    const world = new CollisionWorld([...(campusData.colliders as AABB[]), ...levelSolids(L4)]);
    let crossings = 0;
    nav.adj.forEach((links, i) => { for (const j of links) if (i < j) {
      const a = nav.nodes[i], b = nav.nodes[j];
      if (Math.abs(a.y - b.y) > .1 || !((a.x < -13 && b.x > -12.8) || (b.x < -13 && a.x > -12.8))) continue;
      crossings++;
      for (let k = 0; k <= 50; k++) { const t = k / 50;
        assert.equal(overlaps(world, { x: a.x + (b.x - a.x) * t, y: a.y, z: a.z + (b.z - a.z) * t, vy: 0, grounded: true }, NAV_CAPSULE), false, `stair door ${i}→${j} at ${t}`);
      }
    } });
    assert.ok(crossings >= 2);
  });
  it('downed L4 survivors must also gather, and L2 progresses only to a registered next level', () => {
    const { room, a, b, inbox } = setup(), e = L4.exit;
    room.broadcastStation!.off = true; room.players.get(a.id)!.p = [e.x, e.y, e.z]; room.players.get(b.id)!.st = ST_DOWN;
    room.step(); assert.equal(inbox.get(1)!.some(m => m.t === 'fade'), false);
    room.players.get(b.id)!.st = ST_SPECTATE; room.step(); assert.ok(inbox.get(1)!.some(m => m.t === 'fade'));
    {
      const lv2 = new Room('L2AB', 4, undefined, 1), messages: ServerMsg[] = [];
      lv2.add({ id: 1, name: '甲', send: m => messages.push(m), sendRaw: s => messages.push(JSON.parse(s)) }, 0);
      lv2.fusesIn = 3; lv2.players.get(1)!.p = [lv2.level.exit.x, lv2.level.exit.y, lv2.level.exit.z]; steps(lv2, LEVEL_FADE_S + 1);
      assert.equal(lv2.levelIndex, LEVELS[2] ? 2 : 1);
    }
  });
  it('real monster hears an exposed call across floors; shielded target emits no new location', () => {
    const nav = campusNavCached('test-results/l4-campus-nav.json').graph;
    const { room } = setup(nav), s = room.broadcastStation!, p = room.players.get(1)!;
    p.p = [-28, 10.8, 130]; room.players.get(2)!.st = ST_SPECTATE;
    const heard: unknown[] = [], warden = (room as any).warden; assert.ok(warden);
    const hear = warden.hear.bind(warden); warden.hear = (ev: unknown) => { heard.push(ev); hear(ev); };
    s.nextAt = 61; steps(room, 61); assert.ok(heard.length > 0); assert.notEqual(warden.state, 'patrol');
    p.p = [L4.hides[1].x, 10.8, L4.hides[1].z]; assert.ok(room.hideIn(p, 1)); const count = heard.length; steps(room, .5); assert.equal(heard.length, count);
  });
}
