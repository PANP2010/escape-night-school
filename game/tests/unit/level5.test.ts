import { withCampaignEndingAt } from './campaign-fixture.ts';
import { describe, expect, it, vi } from 'vitest';
import { generateLevel, exitOpen, inArea, LEVELS, levelSolids } from '../../shared/level.ts';
import { L5, L5_INDEX } from '../../shared/levels/l5.ts';
import { L1 } from '../../shared/levels/l1.ts';
import { L2 } from '../../shared/levels/l2.ts';
import { L3 } from '../../shared/levels/l3.ts';
import { L4 } from '../../shared/levels/l4.ts';
import { gymAreaNav } from '../../server/gym-nav.ts';
import { Room, RoomManager, LEVEL_FADE_S, type Conn } from '../../server/room.ts';
import { parseClientMsg, ST_DOWN, ST_SPECTATE, type ServerMsg, type Vec3 } from '../../shared/protocol.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { CollisionWorld, moveCapsule, overlaps, type AABB } from '../../shared/campus/collision.ts';
import campusData from '../../shared/campus/colliders.json';
import { campusDoorSlab, type DoorSpot } from '../../shared/doors.ts';
import { NAV_CAPSULE } from '../../shared/campus/nav.ts';
import { NavGraph } from '../../shared/campus/nav.ts';
import { boxAt, inReach, rayTarget } from '../../shared/interact.ts';
import { objective } from '../../client/src/objective.ts';

function setup(n = 1) {
  const room = new Room('GYM5', 42), inbox = new Map<number, ServerMsg[]>();
  const conn = (id: number): Conn => { const got: ServerMsg[] = []; inbox.set(id, got); return { id, name: `p${id}`, send: (m) => got.push(m), sendRaw: (s) => got.push(JSON.parse(s)) }; };
  for (let i = 1; i <= n; i++) room.add(conn(i), 0);
  room.handle(room.players.get(1)!.conn, { t: 'debug', op: 'level5' }, 0);
  return { room, inbox, conn };
}
function run(room: Room, seconds: number) { for (let i = 0; i < Math.round(seconds * 1000 / TICK_MS); i++) room.step(); }
function press(room: Room, player: number, id: number) {
  const p = room.players.get(player)!, s = L5.gym!.switches[id]; p.p = [s.x, s.y, s.z + 0.6];
  return room.act(p, 'gym-switch', id);
}
const gymMsgs = (list: ServerMsg[]) => list.filter((m) => m.t === 'gym');

describe('L5 region and identity', () => {
  it('is the genuine fifth campaign chapter after the existing L1–L4', () => {
    const lv = generateLevel(L5_INDEX, 42); expect(lv.index).toBe(4); expect(lv.def).toBe(L5);
    expect(LEVELS.slice(0, 5)).toEqual([L1, L2, L3, L4, L5]);
    expect(LEVELS).toHaveLength(8);
    expect(generateLevel(2, 42).def).toBe(L3); expect(generateLevel(3, 42).def).toBe(L4);
    expect(lv.def.monitor?.count).toBe(2);
    for (const s of [...L5.spawns, ...L5.gym!.switches, ...lv.items, L5.exit]) expect(inArea(lv, s.x, s.y ?? 0, s.z)).toBe(true);
    expect(exitOpen(lv, 99, { stair_key: 1 })).toBe(false); expect(exitOpen(lv, 0, {}, true)).toBe(true);
  });
  it('capsule walks from every spawn to all switches, equipment, batteries, raised stands and exit', () => {
    const lv = generateLevel(4, 42), nav = gymAreaNav(lv);
    const at = (p: { x: number; y?: number; z: number }) => nav.nearest(p.x, p.y ?? 0, p.z);
    const targets = [...L5.gym!.switches, ...L5.items.flatMap((g) => g.spots), ...L5.monitor!.spawns!, L5.exit];
    const w = new CollisionWorld([...(campusData.colliders as AABB[]), ...levelSolids(L5), ...(campusData.doors as DoorSpot[]).filter((d) => d.id !== 182).map((d) => campusDoorSlab(d, false))]);
    for (const sp of L5.spawns) {
      const reach = nav.reachable(at(sp));
      for (const t of targets) {
        const dest = at(t), nd = nav.nodes[dest]; expect(reach.has(dest), JSON.stringify({ t, nd, near: nav.nodes.flatMap((n, i) => Math.abs(n.x - t.x) < 0.1 && n.z > 70 ? [{ n, adj: nav.adj[i], connected: reach.has(i) }] : []) })).toBe(true);
        expect(Math.hypot(nd.x - t.x, nd.z - t.z), JSON.stringify(t)).toBeLessThan(1.3);
      }
    }
    for (const pin of L5.monitor!.spawns!) expect(nav.nodes[at(pin)].y).toBeCloseTo(0.72);
    // Walk every actual route edge with the production capsule, including up and down the bleachers.
    for (const t of targets) {
      const route = nav.astar(at(L5.spawns[0]), at(t))!; expect(route.length).toBeGreaterThan(0);
      const first = nav.nodes[route[0]], body = { ...first, vy: 0, grounded: true };
      for (const id of route.slice(1)) {
        const n = nav.nodes[id];
        for (let i = 0; i < 30 && Math.hypot(n.x - body.x, n.z - body.z) > 0.02; i++) {
          const d = Math.hypot(n.x - body.x, n.z - body.z), k = Math.min(0.1, d) / d;
          moveCapsule(w, body, (n.x - body.x) * k, (n.z - body.z) * k, 0.03, NAV_CAPSULE);
        }
        expect(Math.hypot(body.x - n.x, body.z - n.z), JSON.stringify(n)).toBeLessThan(0.05);
        expect(overlaps(w, body, NAV_CAPSULE)).toBe(false);
      }
    }
  });
});

describe('L5 room authority', () => {
  it('a long preview lobby starts a fresh puzzle and schedules its first basketball six simulation seconds after the shared opening', () => {
    const room = new RoomManager(() => 0.25).create(true, L5_INDEX);
    const received: ServerMsg[] = [];
    const conn: Conn = { id: 1, name: 'waiting host', send: m => received.push(m), sendRaw: s => received.push(JSON.parse(s)) };
    room.add(conn, 0); run(room, 12);
    expect(room.started).toBe(false); expect(room.gym!.balls).toHaveLength(0);
    room.gym!.switches.press(0, room.tick * TICK_MS / 1000);
    room.handle(conn, { t: 'start' }, 12_000);
    expect(room.gym!.switches.until).toEqual([0, 0, 0, 0]);
    const intro = received.findLast(m => m.t === 'event' && m.kind === 'intro');
    if (intro?.t !== 'event' || intro.kind !== 'intro') throw new Error('Missing shared opening');
    run(room, 2); expect(room.gym!.balls).toHaveLength(0);
    room.handle(conn, { t: 'intro-skip', id: intro.id }, 14_000);
    room.handle(conn, { t: 'ready', incarnation: room.incarnation }, 14_000);
    run(room, 5.95); expect(room.gym!.balls).toHaveLength(0);
    room.step(); expect(room.gym!.balls).toHaveLength(1);
  });
  it('validates protocol and only the host can open the isolated entry', () => {
    expect(parseClientMsg('{"t":"act","kind":"gym-switch","id":3}')).toEqual({ t: 'act', kind: 'gym-switch', id: 3 });
    expect(parseClientMsg('{"t":"gym","complete":true}')).toBeNull();
    for (const id of [-1, 0.5, '1', null]) expect(parseClientMsg(JSON.stringify({ t: 'act', kind: 'gym-switch', id }))).toBeNull();
    const room = new Room('HOST', 42);
    const c = (id: number): Conn => ({ id, name: '', send: () => {}, sendRaw: () => {} });
    room.add(c(1), 0); room.add(c(2), 0);
    room.handle(room.players.get(2)!.conn, { t: 'debug', op: 'level5' }, 0);
    expect(room.levelIndex).toBe(0);
    vi.stubEnv('NODE_ENV', 'production');
    try { room.handle(room.players.get(1)!.conn, { t: 'debug', op: 'level5' }, 0); expect(room.levelIndex).toBe(0); expect(room.badMsgs).toBe(1); }
    finally { vi.unstubAllEnvs(); }
    room.handle(room.players.get(1)!.conn, { t: 'debug', op: 'level5' }, 0); expect(room.levelIndex).toBe(4);
  });
  it('rejects remote, invalid, downed, spectator, hidden, other-storey and through-wall presses', () => {
    const { room } = setup(); const p = room.players.get(1)!;
    expect(room.act(p, 'gym-switch', 0)).toBe(false); expect(room.act(p, 'gym-switch', 99)).toBe(false);
    press(room, 1, 0); room.gym!.switches.until.fill(0);
    p.st = ST_DOWN; expect(room.act(p, 'gym-switch', 0)).toBe(false); p.st = 0;
    p.st = ST_SPECTATE; expect(room.act(p, 'gym-switch', 0)).toBe(false); p.st = 0;
    p.hide = { id: 0, out: [...p.p], crouch: false }; expect(room.act(p, 'gym-switch', 0)).toBe(false); p.hide = undefined;
    p.p = [-111.76, 3.6, 49.6]; expect(room.act(p, 'gym-switch', 0)).toBe(false);
    // Standing outside the equipment room above its north wall cannot press through the wall.
    p.p = [-112.7, 0, 51.6]; const b = boxAt([-111.76, 0, 49.6], 0.4, 1.9);
    expect(inReach(p.p, b.min, b.max)).toBe(true); expect(room.act(p, 'gym-switch', 0)).toBe(false);
  });
  it('accepts a switch at the visible client prompt boundary', () => {
    const { room } = setup(); const p = room.players.get(1)!, s = L5.gym!.switches[1];
    p.p = [s.x + 2.43, s.y, s.z];
    const candidate = { kind: 'gym-switch' as const, id: 1, ...boxAt([s.x, s.y, s.z], 0.44, 1.9) };
    expect(rayTarget([p.p[0], p.p[1] + 1.6, p.p[2]], Math.PI / 2, 0, [candidate])).toBe(candidate);
    expect(room.act(p, 'gym-switch', 1)).toBe(true);
    room.gym!.switches.until.fill(0);
    p.p[0] = s.x + 2.45;
    expect(room.act(p, 'gym-switch', 1)).toBe(false);
  });
  it('accepts real capsule movement up and down every bleacher tier without server corrections', () => {
    const { room, inbox } = setup(), p = room.players.get(1)!, stand = L5.gym!.stands[0];
    const world = new CollisionWorld([...(campusData.colliders as AABB[]), ...levelSolids(L5)]);
    const body = { x: stand.x + stand.w / 2, y: 0, z: stand.z - 0.5, vy: 0, grounded: true };
    p.p = [body.x, body.y, body.z];
    inbox.get(1)!.length = 0;
    let seq = 0;
    for (const direction of [1, -1]) {
      for (let i = 0; i < 42; i++) {
        moveCapsule(world, body, 0, direction * 0.1, 0.05, NAV_CAPSULE);
        const next: Vec3 = [body.x, body.y, body.z];
        seq++;
        room.applyInput(p, { t: 'input', seq, p: next, yaw: 0, pitch: 0, f: 0 }, seq * 50);
        expect(p.p, `tier movement ${seq}: ${next.join(',')}`).toEqual(next);
      }
      expect(body.y).toBeCloseTo(direction > 0 ? 0.72 : 0);
    }
    expect(inbox.get(1)!.filter((m) => m.t === 'correct')).toEqual([]);
  });
  it('a campaign ending at L5 completes without keys, freezes state and resets puzzle on a fresh load', () => {
    withCampaignEndingAt(4, () => {
      const { room, inbox } = setup(); const p = room.players.get(1)!;
      p.p = [L5.exit.x, L5.exit.y, L5.exit.z]; run(room, 0.1);
      expect(inbox.get(1)!.some((m) => m.t === 'fade')).toBe(false);
      for (let i = 0; i < 4; i++) { expect(press(room, 1, i)).toBe(true); if (i < 3) { p.p = [-90, 0.035, 60]; run(room, 4); } }
      expect(room.gym!.switches.complete).toBe(true); expect(room.bag.stair_key).toBeUndefined();
      p.p = [L5.exit.x, L5.exit.y, L5.exit.z]; room.step();
      expect(inbox.get(1)!.find((m) => m.t === 'fade')).toMatchObject({ restart: false });
      run(room, LEVEL_FADE_S); expect(room.levelIndex).toBe(4); expect(room.completed).toBe(true);
      expect(inbox.get(1)!.filter((m) => m.t === 'complete')).toEqual([{ t: 'complete', level: 4 }]);
      expect(room.gym!.switches.complete).toBe(true);
      const fresh = setup().room; expect(fresh.completed).toBe(false); expect(fresh.gym!.switches.complete).toBe(false); expect(fresh.gym!.balls).toHaveLength(0);
    });
  });
  it('multiplayer deadlines and full late-join state match on every connection', () => {
    const { room, inbox, conn } = setup(2);
    press(room, 1, 0); run(room, 5); press(room, 2, 1); press(room, 1, 2); press(room, 2, 3);
    expect(room.gym!.switches.complete).toBe(false); expect(room.gym!.switches.until[0]).toBe(0);
    press(room, 1, 0); expect(room.gym!.switches.complete).toBe(true);
    expect(gymMsgs(inbox.get(1)!).at(-1)).toEqual(gymMsgs(inbox.get(2)!).at(-1));
    room.add(conn(3), 0); expect(gymMsgs(inbox.get(3)!).at(-1)).toMatchObject({ complete: true, solo: false });
    for (const p of room.players.values()) p.p = [L5.exit.x, L5.exit.y, L5.exit.z];
    room.players.get(3)!.p = [-100, 0, 60]; room.step(); expect(inbox.get(1)!.some((m) => m.t === 'fade')).toBe(false);
    room.players.get(3)!.st = ST_SPECTATE; room.step(); expect(inbox.get(1)!.some((m) => m.t === 'fade')).toBe(true);
  });
  it('ball stun blocks forged movement and actions on the server, then releases after 1.5s', () => {
    const { room, inbox } = setup(); run(room, 6); const p = room.players.get(1)!;
    room.gym!.balls[0].p = [-110, 0.035, 56]; p.p = [-111, 0.035, 56];
    room.applyInput(p, { t: 'input', seq: 1, p: [-109.7, 0.035, 56], yaw: 0, pitch: 0, f: 0 }, 1000);
    expect(room.gym!.tripped(1, room.tick * TICK_MS / 1000)).toBe(true);
    const frozen: Vec3 = [...p.p]; room.applyInput(p, { t: 'input', seq: 2, p: [-110.5, 0.035, 56], yaw: 1, pitch: 0, f: 0 }, 1050);
    expect(p.p).toEqual(frozen); expect(press(room, 1, 1)).toBe(false);
    expect(inbox.get(1)!.some((m) => m.t === 'gym-sound' && m.kind === 'trip')).toBe(true);
    p.p = [-90, 0.035, 60]; run(room, 1.5); expect(room.gym!.tripped(1, room.tick * TICK_MS / 1000)).toBe(false);
    room.applyInput(p, { t: 'input', seq: 3, p: [-89.9, 0.035, 60], yaw: 0, pitch: 0, f: 0 }, 3000);
    expect(p.p).toEqual([-89.9, 0.035, 60]);
  });
  it('real geometry lets balls roll out of equipment; a closed door reflects them; noise reaches AI subscribers', () => {
    const { room } = setup(); const noises: { r: number; x: number; z: number }[] = [];
    room.noiseListeners.push((x, z, r) => noises.push({ r, x, z }));
    run(room, 8); expect(room.gym!.balls[0].p[2]).toBeGreaterThan(54);
    expect(noises.some((e) => e.r === 10 && e.z > 52)).toBe(true);
    const p = room.players.get(1)!; p.p = [-111.76, 0, 51.8];
    room.handle(p.conn, { t: 'door', id: 182 }, 0); expect(room.doorOpen[182]).toBe(false);
    run(room, 8); const b = room.gym!.balls.find((b) => b.id === 2)!;
    expect(b.p[2]).toBeLessThan(51.24); expect(b.v[1]).toBeLessThan(0);
  });
  it('spawns two authoritative monitors on reachable raised stands', () => {
    const nav = new NavGraph(); nav.chain([{ x: -40, y: 0, z: 73 }, { x: -60, y: 0, z: 73 }]);
    const room = new Room('MOBS', 42, nav), got: ServerMsg[] = [];
    const c: Conn = { id: 1, name: '', send: (m) => got.push(m), sendRaw: (s) => got.push(JSON.parse(s)) }; room.add(c, 0);
    room.handle(c, { t: 'debug', op: 'level5' }, 0); room.step();
    const snap = got.filter((m) => m.t === 'snap').at(-1)!;
    const monitors = snap.mobs.filter((m) => m.kind === 'monitor'); expect(monitors).toHaveLength(2);
    for (const m of monitors) expect(m.p[1]).toBeCloseTo(0.72);
  });
  it('objective names each switch and uses server deadlines instead of keys or fuses', () => {
    const { room } = setup(2); press(room, 1, 0);
    const s = room.gym!.snapshot(0), o = objective(L5, { stair_key: 1, fuse: 9 }, 3, s);
    expect(o.steps[0]).toContain('多人5秒'); expect(o.got).toContain('1器材室：亮 5.0秒'); expect(o.got).toContain('2西侧篮架：待按'); expect(o.cur).toBe(0);
    for (let i = 1; i < 4; i++) press(room, 1, i);
    expect(objective(L5, {}, 0, room.gym!.snapshot(0)).cur).toBe(1);
  });
});
