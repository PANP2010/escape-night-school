import { withCampaignEndingAt } from './campaign-fixture.ts';
import { describe, expect, it, vi } from 'vitest';
import { RoomManager, LEVEL_FADE_S, REVIVE_S, CAUGHT_HOLD_S, mirrorAreaNav, type Conn } from '../../server/room.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { parseClientMsg, ST_DOWN, ST_OK, ST_SPECTATE, type ServerMsg, type Vec3 } from '../../shared/protocol.ts';
import { L7_INDEX, L7_CAMPUS_DOORS, MIRROR_DOORS, l7World } from '../../shared/levels/l7.ts';
import { NavGraph } from '../../shared/campus/nav.ts';
import { mulberry32 } from '../../shared/rng.ts';
import { groundHeight, overlaps, type Body } from '../../shared/campus/collision.ts';
import { NAV_CAPSULE } from '../../shared/campus/nav.ts';
import { LEVELS } from '../../shared/level.ts';
import { L1 } from '../../shared/levels/l1.ts';
import { L8 } from '../../shared/levels/l8.ts';
import { L2 } from '../../shared/levels/l2.ts';
import { CampaignMirrors } from '../../server/l7-campaign.ts';

const steps = (r: { step(): void }, ticks: number) => { for (let i = 0; i < ticks; i++) r.step(); };
const seconds = (r: { step(): void }, s: number) => steps(r, Math.ceil(s * 1000 / TICK_MS));
const body = (p: Vec3): Body => ({ x: p[0], y: p[1], z: p[2], vy: 0, grounded: true });

function setup(n = 2, preview = false, initialLevel = preview ? L7_INDEX : 0) {
  const manager = new RoomManager(mulberry32(71));
  const room = manager.create(true, initialLevel), received = new Map<number, ServerMsg[]>();
  const add = (id: number) => {
    const got: ServerMsg[] = []; received.set(id, got);
    const conn: Conn = { id, name: `同学${id}`, send: m => got.push(m), sendRaw: s => got.push(JSON.parse(s)) };
    room.add(conn, 0);
    return conn;
  };
  const conns = Array.from({ length: n }, (_, i) => add(i + 1));
  room.handle(conns[0], { t: 'start' }, 0);
  const original = { room, code: room.code, host: room.host, seed: room.seed, players: [...room.players.values()] };
  const finishOpening = () => {
    const intro = received.get(1)!.findLast(m => m.t === 'event' && m.kind === 'intro');
    if (intro?.t === 'event' && intro.kind === 'intro' && !intro.ended) {
      for (const player of room.players.values()) room.handle(player.conn, { t: 'intro-skip', id: intro.id }, 50);
    }
    for (const player of room.players.values()) room.handle(player.conn, { t: 'ready', incarnation: room.incarnation }, 50);
  };
  finishOpening(); // The production server correctly refuses debug level changes during a cinematic.
  if (!preview && initialLevel === 0) room.handle(conns[0], { t: 'debug', op: 'level', level: L7_INDEX }, 50);
  finishOpening();
  let seq = 0;
  const place = (id: number, p: Vec3, yaw = 0, pitch = 0) => {
    finishOpening();
    const pl = room.players.get(id)!;
    room.handle(pl.conn, { t: 'debug', op: 'tp', x: p[0], z: p[2], floor: Math.round(p[1] / 3.6) }, 100);
    expect(pl.p).toEqual(p);
    room.handle(pl.conn, { t: 'input', seq: ++seq, p: [...pl.p], yaw, pitch, f: 0, c: pl.c }, 150);
    return pl;
  };
  const take = () => {
    place(1, [-80.4, 0, 143.4], Math.PI / 2, -.1);
    // Natural, shared turn clock: mirror observation does not freeze the student's inspection.
    seconds(room, 3.5);
    expect(room.mirrorCampaign!.key.snapshot()).toMatchObject({ open: true, guard: { watched: false } });
    room.handle(conns[0], { t: 'act', kind: 'mirror-key', id: 0 }, 4000);
    expect(room.mirrorCampaign!.key.taken).toBe(true);
  };
  const open = () => {
    take();
    for (const d of MIRROR_DOORS) {
      place(1, [-80.4, d.wall[1], 143.4], Math.PI / 2, -.1);
      room.step(); // reveal this storey's corresponding wall in its mirror
      place(1, [-79, d.wall[1], 143.4], -Math.PI / 2);
      room.handle(conns[0], { t: 'act', kind: 'mirror-push', id: d.id }, 5000);
      expect(room.mirrorCampaign!.openDoors.has(d.id)).toBe(true);
    }
  };
  return { manager, room, conns, received, add, place, take, open, original };
}

describe('L7 in the campaign Room', () => {
  it('hands off L6 → L7 → L8 through test-only campus fixtures, preserving the room and reviving observers', () => {
    // These full existing campus definitions exercise registration/handoff only. Production still has no L5/L6/L8.
    const registered = LEVELS.slice();
    LEVELS[5] = { ...L1, name: '第六关接口夹具' };
    LEVELS[7] = { ...L2, name: '第八关接口夹具' };
    try {
      const { manager, room, conns, add, received, open, place, original } = setup(2, false, 5);
      const exitFeet = (): Vec3 => {
        const { x, y, z } = room.level.exit;
        // An exit region can include stair treads above its reference y. Use the actual campus floor.
        return [x, groundHeight(room.world, x, z, NAV_CAPSULE.radius, y + 2), z];
      };
      const expectIdentity = () => {
        expect(manager.get(original.code)).toBe(original.room);
        expect(room.host).toBe(original.host); expect(room.seed).toBe(original.seed);
        for (const c of conns) expect(c.room).toBe(room);
        for (const p of original.players) expect(room.players.get(p.conn.id)).toBe(p);
        expect([...room.players.values()].map(p => p.slot)).toEqual([0, 1, 2]);
      };
      const observer = add(3);
      expect(room.players.get(observer.id)!.st).toBe(ST_SPECTATE);
      room.bag = { stair_key: 1, battery: 2 };
      room.teamKeys.add(123);
      for (const id of [1, 2]) place(id, exitFeet());
      room.step(); seconds(room, LEVEL_FADE_S);
      expect(room.levelIndex).toBe(L7_INDEX); expectIdentity();
      expect(room.mirrorCampaign).toBeDefined();
      expect(room.bag).toEqual({}); expect(room.teamKeys.size).toBe(0);
      expect(room.players.get(observer.id)!.st).toBe(ST_OK);
      expect(received.get(observer.id)!.filter(m => m.t === 'room').at(-1)).toMatchObject({ level: L7_INDEX, code: original.code, seed: original.seed });

      open();
      room.players.get(observer.id)!.st = ST_SPECTATE;
      room.bag = { battery: 3 };
      const exit = exitFeet();
      place(1, exit); place(2, exit); room.step(); seconds(room, LEVEL_FADE_S);
      expect(room.levelIndex).toBe(7); expect(room.level.name).toBe('第八关接口夹具'); expectIdentity();
      expect(room.completed).toBe(false); expect(room.mirrorCampaign).toBeUndefined();
      expect(room.bag).toEqual({}); expect(room.teamKeys.size).toBe(0); expect(room.fusesIn).toBe(0);
      expect([...room.players.values()].every(p => p.st === ST_OK && p.heldUntil === undefined)).toBe(true);
      expect(received.get(observer.id)!.filter(m => m.t === 'room').at(-1)).toMatchObject({ level: 7, code: original.code, seed: original.seed });
      expect(received.get(1)!.some(m => m.t === 'complete')).toBe(false);
      place(1, exitFeet()); // The L8 campus fixture's landing also uses its actual current-world floor.
    } finally {
      LEVELS.length = 0;
      LEVELS.push(...registered);
    }
  });

  it('loads the seventh chapter without replacing connections, room, host, seed or player slots', () => {
    const { manager, room, original, conns } = setup();
    expect(manager.get(original.code)).toBe(original.room);
    expect(room.levelIndex).toBe(6);
    expect(room.level.name).toBe('镜廊');
    expect(room.host).toBe(original.host);
    expect(room.seed).toBe(original.seed);
    expect([...room.players.values()]).toEqual(original.players);
    expect(conns.every(c => c.room === room)).toBe(true);
    expect([...room.players.values()].map(p => p.slot)).toEqual([0, 1]);
    expect(room.world).not.toBe(new RoomManager(mulberry32(1)).create().world);
  });

  it('direct preview still uses the host-start lobby and main room protocol', () => {
    const manager = new RoomManager(mulberry32(7)), room = manager.create(true, L7_INDEX), got: ServerMsg[] = [];
    const a: Conn = { id: 1, name: '甲', send: m => got.push(m), sendRaw: s => got.push(JSON.parse(s)) };
    room.add(a, 0);
    room.step();
    expect(got.some(m => m.t === 'l7')).toBe(false);
    room.handle(a, { t: 'start' }, 1);
    expect(got.find(m => m.t === 'l7')).toMatchObject({ openDoors: [], revealedDoors: [], key: { taken: false } });
    expect(got.filter(m => m.t === 'room').at(-1)).toMatchObject({ level: 6, started: true });
  });

  it('shares revealed walls with teammates and late observers, even when the teammate never watched that mirror', () => {
    const { room, conns, received, place, add } = setup();
    const latest = (id: number) => received.get(id)!.filter(m => m.t === 'l7').at(-1)!;
    for (const id of [1, 2]) expect(latest(id)).toMatchObject({ revealedDoors: [], openDoors: [] });
    // Only player 1 watches the glass; player 2 faces away throughout discovery.
    place(2, [-79, 0, 143.4], -Math.PI / 2);
    place(1, [-80.4, 0, 143.4], Math.PI / 2); room.step();
    for (const id of [1, 2]) expect(latest(id)).toMatchObject({ revealedDoors: [1], openDoors: [] });
    room.handle(conns[1], { t: 'act', kind: 'mirror-push', id: 1 }, 1000);
    expect(room.mirrorCampaign!.openDoors.has(1)).toBe(true);
    for (const id of [1, 2]) expect(latest(id)).toMatchObject({ revealedDoors: [1], openDoors: [1] });
    place(1, [-80.4, 3.6, 143.4], Math.PI / 2); room.step();
    for (const id of [1, 2]) expect(latest(id)).toMatchObject({ revealedDoors: [1, 2], openDoors: [1] });
    const observer = add(3);
    expect(room.players.get(observer.id)!.st).toBe(ST_SPECTATE);
    expect(latest(observer.id)).toMatchObject({ revealedDoors: [1, 2], openDoors: [1] });
    room.remove(conns[0], 2000); room.step();
    expect(latest(2)).toMatchObject({ revealedDoors: [1, 2] }); // discovery belongs to the team after its discoverer leaves
  });

  it('starts ordinary LAB doors open, and preserves their authoritative close/open collision after pushing a secret wall', () => {
    const { room, conns, place, open } = setup();
    for (const d of L7_CAMPUS_DOORS) {
      expect(room.doorOpen[d.id]).toBe(true);
      expect(room.doorLocked[d.id]).toBe(false);
    }
    open();
    const d = L7_CAMPUS_DOORS.find(q => q.x === -81.25 && (q.y0 ?? 0) === 0)!;
    const start: Vec3 = [d.x, 0, d.z - 1.2], end: Vec3 = [d.x, 0, d.z + 1.2];
    const pl = place(1, start, Math.PI);
    room.handle(conns[0], { t: 'act', kind: 'use', id: d.id }, 6000);
    expect(room.doorOpen[d.id]).toBe(false);
    expect(room.mirrorCampaign!.openDoors.size).toBe(2);
    room.handle(conns[0], { t: 'input', seq: 201, p: end, yaw: Math.PI, pitch: 0, f: 0, c: pl.c }, 7000);
    expect(pl.p).toEqual(start);
    room.handle(conns[0], { t: 'act', kind: 'use', id: d.id }, 7100);
    expect(room.doorOpen[d.id]).toBe(true);
    room.handle(conns[0], { t: 'input', seq: 202, p: end, yaw: Math.PI, pitch: 0, f: 0, c: pl.c }, 7200);
    expect(pl.p).toEqual(end);
  });

  it('rejects legacy and direct LAB door toggles from another storey while allowing the same-floor action', () => {
    const { room, conns, place } = setup(1);
    const doors = [0, 3.6].map(y => L7_CAMPUS_DOORS.find(d => d.x === -81.25 && (d.y0 ?? 0) === y)!);
    for (const d of doors) {
      const y = d.y0 ?? 0, otherY = y === 0 ? 3.6 : 0;
      const pl = place(1, [d.x, otherY, d.z - 1.2], Math.PI);
      room.handle(conns[0], { t: 'door', id: d.id }, 1000);
      expect(room.toggleDoor(pl, d.id)).toBe(false);
      expect(room.doorOpen[d.id]).toBe(true);
      place(1, [d.x, y, d.z - 1.2], Math.PI);
      room.handle(conns[0], { t: 'door', id: d.id }, 1100);
      expect(room.doorOpen[d.id]).toBe(false);
      expect(room.toggleDoor(pl, d.id)).toBe(true);
      expect(room.doorOpen[d.id]).toBe(true);
    }
  });

  it('accepts an ordinary input and rejects a teleport, a skipped floor, and passage through an unopened secret wall', () => {
    const { room, conns, place } = setup(1);
    const p = room.players.get(1)!, start = [...p.p] as Vec3;
    const input = (to: Vec3, now: number) => room.handle(conns[0], { t: 'input', seq: now, p: to, yaw: 0, pitch: 0, f: 0, c: p.c }, now);
    input([start[0] + .1, start[1], start[2]], 100);
    expect(p.p[0]).toBeCloseTo(start[0] + .1);
    const at = [...p.p] as Vec3;
    input([at[0] + 10, at[1], at[2]], 150); expect(p.p).toEqual(at);
    input([at[0], 3.6, at[2]], 200); expect(p.p).toEqual(at);
    place(1, [-79, 0, 143.4], -Math.PI / 2);
    input([-76.5, 0, 143.4], 2000);
    expect(p.p).toEqual([-79, 0, 143.4]);
  });

  it('requires a revealed mirror wall, room side, correct storey, close reach and facing before a push opens its real geometry', () => {
    const { room, conns, place } = setup(1);
    const push = () => room.handle(conns[0], { t: 'act', kind: 'mirror-push', id: 1 }, 100);
    place(1, [-79, 0, 143.4], -Math.PI / 2); push();
    expect(room.mirrorCampaign!.openDoors.size).toBe(0); // not discovered in the mirror yet
    place(1, [-80.4, 0, 143.4], Math.PI / 2); room.step();
    for (const [p, yaw] of [
      [[-79, 0, 143.4], Math.PI / 2], [[-79, 0, 144.4], -Math.PI / 2],
      [[-76.5, 0, 143.4], Math.PI / 2], [[-79, 3.6, 143.4], -Math.PI / 2],
    ] as [Vec3, number][]) { place(1, p, yaw); push(); expect(room.mirrorCampaign!.openDoors.size).toBe(0); }
    const at: Vec3 = [-77.65, 0, 143.4];
    expect(overlaps(room.world, body(at), NAV_CAPSULE)).toBe(true);
    place(1, [-79, 0, 143.4], -Math.PI / 2); push();
    expect(room.mirrorCampaign!.openDoors.has(1)).toBe(true);
    expect(overlaps(room.world, body(at), NAV_CAPSULE)).toBe(false);
    // The same authoritative movement validator now accepts walking through the opening.
    const pl = room.players.get(1)!;
    room.handle(conns[0], { t: 'input', seq: 77, p: [-76.5, 0, 143.4], yaw: -Math.PI / 2, pitch: 0, f: 0, c: pl.c }, 2000);
    expect(pl.p).toEqual([-76.5, 0, 143.4]);
  });

  it('keeps the mirror key separate from ordinary keys and only takes it through the visible reflection in its turn window', () => {
    const { room, conns, place, take, received } = setup();
    room.handle(conns[0], { t: 'debug', op: 'key', door: -1 }, 100);
    place(1, [-79, 3.6, 143.4], -Math.PI / 2);
    room.handle(conns[0], { t: 'act', kind: 'mirror-push', id: 2 }, 100);
    expect(room.mirrorCampaign!.openDoors.size).toBe(0);
    place(1, [-80.4, 0, 143.4], Math.PI / 2, -.1);
    room.handle(conns[0], { t: 'act', kind: 'mirror-key', id: 0 }, 200);
    expect(room.mirrorCampaign!.key.taken).toBe(false);
    take();
    const a = received.get(1)!.filter(m => m.t === 'l7').at(-1), b = received.get(2)!.filter(m => m.t === 'l7').at(-1);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ key: { taken: true, open: false } });
    const count = received.get(1)!.length;
    room.handle(conns[1], { t: 'act', kind: 'mirror-key', id: 0 }, 5000);
    expect(received.get(1)!.length).toBe(count);
  });

  it('uses the connection’s accepted pose despite forged action fields, wrong storey or real occlusion', () => {
    const { room, conns, place } = setup(1);
    const valid: Vec3 = [-80.4, 0, 143.4];
    place(1, valid, Math.PI / 2, -.1); seconds(room, 3.5);
    expect(room.mirrorCampaign!.key.snapshot().open).toBe(true);
    const packet = parseClientMsg(JSON.stringify({
      t: 'act', kind: 'mirror-key', id: 0, p: valid, yaw: Math.PI / 2, pitch: -.1,
      taken: true, open: true, player: 999, room: 'FAKE',
    }))!;
    expect(packet).toEqual({ t: 'act', kind: 'mirror-key', id: 0 });
    for (const [position, yaw] of [
      [[-79, 0, 143.4], Math.PI / 2], // outside the glass's reach
      [[-80.4, 3.6, 143.4], Math.PI / 2], // the wrong storey
      [valid, -Math.PI / 2], // sees the real student's front
    ] as [Vec3, number][]) {
      place(1, position, yaw, -.1); room.handle(conns[0], packet, 4000);
      expect(room.mirrorCampaign!.key.taken).toBe(false);
    }
    place(1, valid, Math.PI / 2, -.1);
    expect(room.act(room.players.get(1)!, 'mirror-key', 1)).toBe(false);
    expect(room.act(room.players.get(1)!, 'mirror-push', 999)).toBe(false);
    // A real opaque slab between the player and the glass defeats both reflection rays.
    const slab = { minX: -81.35, maxX: -81.25, minY: 0, maxY: 2.4, minZ: 142.5, maxZ: 144.5 };
    const collider = room.world.add(slab);
    room.handle(conns[0], packet, 4100);
    expect(room.mirrorCampaign!.key.taken).toBe(false);
    room.world.move(collider, { ...slab, minY: -20, maxY: -19 });
    room.handle(conns[0], packet, 4200);
    expect(room.mirrorCampaign!.key.taken).toBe(true);
  });

  it('refuses a downed player’s key and wall actions even from valid interaction poses', () => {
    const { room, conns, place } = setup(1);
    place(1, [-80.4, 0, 143.4], Math.PI / 2, -.1); seconds(room, 3.5);
    expect(room.mirrorCampaign!.key.snapshot().open).toBe(true);
    room.handle(conns[0], { t: 'debug', op: 'down', s: 30 }, 4000);
    const player = place(1, [-80.4, 0, 143.4], Math.PI / 2, -.1);
    expect(player.st).toBe(ST_DOWN);
    room.handle(conns[0], { t: 'act', kind: 'mirror-key', id: 0 }, 4100);
    expect(room.mirrorCampaign!.key.taken).toBe(false);
    place(1, [-79, 0, 143.4], -Math.PI / 2);
    room.handle(conns[0], { t: 'act', kind: 'mirror-push', id: 1 }, 4200);
    expect(room.mirrorCampaign!.openDoors.size).toBe(0);
  });

  it('gives a late joiner full mirror state as an observer and refuses observer interactions', () => {
    const { room, add, received, open, place } = setup();
    open();
    const c = add(3), p = room.players.get(3)!;
    expect(p.st).toBe(ST_SPECTATE);
    expect(received.get(3)!.find(m => m.t === 'l7')).toMatchObject({ openDoors: [1, 2], key: { taken: true } });
    const key = room.mirrorCampaign!.key;
    key.reset();
    place(3, [-80.4, 0, 143.4], Math.PI / 2, -.1);
    room.handle(c, { t: 'act', kind: 'mirror-key', id: 0 }, 6000);
    expect(key.taken).toBe(false);
  });

  it('runs the real mirror catch into the common 30-second down timer and a sustained 3-second rescue', () => {
    const { room, conns, place, received } = setup();
    seconds(room, 10.1); // Respect the full slow-loader protection before arranging an actual encounter.
    const p = place(1, [-80, 0, 143.4], Math.PI / 2);
    place(2, [-79.5, 0, 142.6], -Math.PI / 2);
    seconds(room, 6.5);
    expect(p.st).toBe(ST_DOWN);
    expect(p.heldUntil! - room.tick).toBeGreaterThan(28 * 1000 / TICK_MS);
    expect(received.get(1)!.find(m => m.t === 'caught')).toMatchObject({ t: 'caught', hold: CAUGHT_HOLD_S, by: 'mirror', id: 1, seq: 1 });
    const contact = received.get(1)!.find(m => m.t === 'caught')!;
    if (contact.t !== 'caught') throw new Error('Missing real mirror contact');
    expect(Math.hypot(...contact.source.map((v, i) => v - contact.at[i]))).toBeLessThanOrEqual(.8);
    expect(contact.at).toEqual([-80, 0, 143.4]);
    expect(p.p).toEqual(contact.at); // rescue takes place at the real mirror contact, without a spawn teleport
    room.handle(conns[1], { t: 'act', kind: 'revive', id: 1 }, 7000);
    seconds(room, 1);
    expect(p.st).toBe(ST_DOWN); // one tap cannot rescue
    const ticks = REVIVE_S * 1000 / TICK_MS;
    for (let i = 0; i <= ticks; i++) { room.handle(conns[1], { t: 'act', kind: 'revive', id: 1 }, 8000 + i * TICK_MS); room.step(); }
    expect(p.st).toBe(ST_OK);
    expect(p.heldUntil).toBeUndefined();
    seconds(room, 2);
    expect(p.st).toBe(ST_OK);
  });

  it('waits for a downed teammate, needs both walls and the key, then clears with the whole team and revives observers', () => {
    const { room, place, open, add, received } = setup();
    const exit: Vec3 = [room.level.exit.x, room.level.exit.y, room.level.exit.z];
    place(1, exit); place(2, exit); room.bag = { stair_key: 1 }; room.step();
    expect(received.get(1)!.some(m => m.t === 'fade')).toBe(false);
    open();
    place(1, exit);
    const p2 = place(2, [-80, 0, 142.5]); p2.st = ST_DOWN; room.step();
    expect(received.get(1)!.some(m => m.t === 'fade')).toBe(false);
    p2.st = ST_OK; place(2, exit);
    add(3); room.step();
    expect(received.get(1)!.at(-1)).toMatchObject({ t: 'fade', restart: false, secs: LEVEL_FADE_S });
    seconds(room, LEVEL_FADE_S + .1);
    expect(room.completed).toBe(false);
    expect(room.levelIndex).toBe(7);
    expect(room.level.def).toBe(L8);
    expect(room.players.get(3)!.st).toBe(ST_OK);
    expect(received.get(1)!.some(m => m.t === 'complete')).toBe(false);
    expect(received.get(1)!.findLast(m => m.t === 'room')).toMatchObject({ level: 7 });
  });

  it('freezes mirror clocks and rejects direct or network puzzle actions throughout fade and completion', () => {
    withCampaignEndingAt(6, () => {
      const { room, conns, place, open } = setup();
      open();
      const puzzle = room.mirrorCampaign!, take = vi.spyOn(puzzle, 'takeKey'), push = vi.spyOn(puzzle, 'push');
      const exit: Vec3 = [room.level.exit.x, room.level.exit.y, room.level.exit.z];
      place(1, exit); place(2, exit); room.step();
      const before = puzzle.snapshot(room.tick);
      const refused = () => {
        expect(room.act(room.players.get(1)!, 'mirror-key', 0)).toBe(false);
        expect(room.act(room.players.get(1)!, 'mirror-push', 1)).toBe(false);
        room.handle(conns[0], { t: 'act', kind: 'mirror-key', id: 0 }, 8000);
        room.handle(conns[0], { t: 'act', kind: 'mirror-push', id: 1 }, 8000);
        expect(take).not.toHaveBeenCalled(); expect(push).not.toHaveBeenCalled();
      };
      refused(); seconds(room, LEVEL_FADE_S - .1);
      expect(puzzle.snapshot(before.tick)).toEqual(before);
      seconds(room, .1); expect(room.completed).toBe(true);
      refused(); seconds(room, 1);
      expect(puzzle.snapshot(before.tick)).toEqual(before);
    });
  });

  it('restarts a full wipe in this room with the same seed and reset mirror doors, key and reflection history', () => {
    const { room, original, open, received } = setup();
    open();
    expect(room.mirrorCampaign!.snapshot(room.tick).revealedDoors).toEqual([1, 2]);
    for (const p of room.players.values()) p.st = ST_SPECTATE;
    room.step();
    expect(received.get(1)!.at(-1)).toMatchObject({ t: 'fade', restart: true });
    seconds(room, LEVEL_FADE_S + .1);
    expect(room.levelIndex).toBe(L7_INDEX); expect(room.seed).toBe(original.seed);
    expect([...room.players.values()].every(p => p.st === ST_OK)).toBe(true);
    expect(room.mirrorCampaign!.snapshot(room.tick)).toMatchObject({ mirrors: [], openDoors: [], revealedDoors: [], key: { taken: false, open: false } });
  });

  it('forgets a disconnected player reflection and blocks the preview command in production', () => {
    const { room, conns, place } = setup();
    place(1, [-80.4, 0, 143.4], Math.PI / 2); room.step();
    expect(room.mirrorCampaign!.ai.snapshots().map(m => m.id)).toContain(1);
    room.remove(conns[0], 1000);
    expect(room.mirrorCampaign!.ai.snapshots()).toEqual([]);
    const previous = room.level;
    vi.stubEnv('NODE_ENV', 'production');
    try { room.handle(conns[1], { t: 'debug', op: 'level', level: L7_INDEX }, 1100); }
    finally { vi.unstubAllEnvs(); }
    expect(room.level).toBe(previous); expect(room.badMsgs).toBe(1);
  });
});

describe('CampaignMirrors revealed-door snapshots', () => {
  it('orders shared discoveries independently of observation order and returns a defensive array', () => {
    const puzzle = new CampaignMirrors({ walkable: () => false, los: () => true });
    const viewer = (floor: number) => ({ id: floor + 1, p: [-80.4, floor * 3.6, 143.4] as Vec3, yaw: Math.PI / 2, pitch: 0, st: ST_OK });
    expect(puzzle.snapshot(0).revealedDoors).toEqual([]);
    puzzle.step(.05, [viewer(1)]);
    expect(puzzle.snapshot(1).revealedDoors).toEqual([2]);
    puzzle.step(.05, [viewer(0)]);
    const snap = puzzle.snapshot(2);
    expect(snap.revealedDoors).toEqual([1, 2]);
    snap.revealedDoors.length = 0;
    expect(puzzle.snapshot(3).revealedDoors).toEqual([1, 2]);
  });
});

describe('L7 navigation uses the live geometry', () => {
  it('removes a preexisting edge through a closed wall and adds a capsule route after it opens', () => {
    const nav = new NavGraph();
    nav.chain([{ x: -79, y: 0, z: 143.4 }, { x: -76.5, y: 0, z: 143.4 }]);
    const { room } = setup(1);
    const shut = mirrorAreaNav(nav, room.level, l7World([])), open = mirrorAreaNav(nav, room.level, l7World([1]));
    const path = (g: NavGraph) => g.astar(g.nearest(-79, 0, 143.4), g.nearest(-76.5, 0, 143.4));
    expect(path(shut)).toBeNull(); expect(path(open)).not.toBeNull();
    for (const p of open.nodes) expect(overlaps(l7World([1]), body([p.x, p.y, p.z]), NAV_CAPSULE)).toBe(false);
    expect(groundHeight(room.world, -80.4, 143.4, .3, 4)).toBeCloseTo(3.6);
  });
});
