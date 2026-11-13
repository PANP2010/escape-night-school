import { describe, expect, it } from 'vitest';
import { ST_DOWN, ST_OK, ST_SPECTATE, type ServerMsg } from '../../shared/protocol.ts';
import { CAUGHT_HOLD_S, LEVEL_FADE_S, REVIVE_S, RoomManager, type Conn } from '../../server/room.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { mulberry32 } from '../../shared/rng.ts';
import { moveCapsule, overlaps, type Body } from '../../shared/campus/collision.ts';
import { NAV_CAPSULE } from '../../shared/campus/nav.ts';
import { CAMPUS } from '../../client/src/campus/world/campus.ts';
import { stairRoute } from '../../client/src/campus/world/interior.ts';

function setup() {
  const room = new RoomManager(mulberry32(3)).create();
  const got: ServerMsg[] = [];
  const c: Conn = { id: 1, name: 'p1', send: (m) => got.push(m), sendRaw: (s) => got.push(JSON.parse(s)) };
  room.add(c, 0);
  return { room, c, got, pl: room.players.get(1)! };
}

describe('campus room (server-authoritative capsule collision)', () => {
  it('announces campus and spawns on the ground inside 教学楼A', () => {
    const { got, pl } = setup();
    expect(got.find(m => m.t === 'room')).toMatchObject({ level: 0 });
    const [x, y, z] = pl.p;
    expect(Math.abs(y)).toBeLessThan(0.5);
    const a = CAMPUS.buildings.find(b => b.id === 'A')!;
    expect(Math.abs(x - a.x) < a.w / 2 && Math.abs(z - a.z) < a.d / 2).toBe(true);
  });

  it('corrects a step through a wall and a claim of floating in the air', () => {
    const { room, c, got, pl } = setup();
    const w = room.world!;
    const [x, y, z] = pl.p;
    const body = (bx: number, bz: number, by = y): Body => ({ x: bx, y: by, z: bz, vy: 0, grounded: true });
    // a wall near the spawn: walk a ray until the capsule hits, stand just before it, aim at the first clear spot past it
    let near: [number, number] | undefined, target: [number, number] | undefined;
    for (let k = 0; k < 64 && !target; k++) {
      const a = (k / 64) * Math.PI * 2, ux = Math.cos(a), uz = Math.sin(a);
      let d = 0.1;
      while (d < 8 && !overlaps(w, body(x + ux * d, z + uz * d), NAV_CAPSULE)) d += 0.05;
      if (d >= 8) continue;
      for (let e = d; e < d + 1.5; e += 0.05) {
        if (!overlaps(w, body(x + ux * e, z + uz * e), NAV_CAPSULE)) {
          near = [x + ux * (d - 0.1), z + uz * (d - 0.1)];
          target = [x + ux * e, z + uz * e];
          break;
        }
      }
    }
    expect(target, 'a wall near the spawn').toBeDefined();
    pl.p = [near![0], y, near![1]];
    const start = [...pl.p];
    // 0.5 s since the join: the distance budget is ≥ 4.4 m (≤ 1.6 m needed), so only the wall can reject it
    room.handle(c, { t: 'input', seq: 1, p: [target![0], y, target![1]], yaw: 0, pitch: 0, f: 0 }, 500);
    expect(got.at(-1)).toEqual({ t: 'correct', p: start, c: 1, ack: 1 });
    room.handle(c, { t: 'input', seq: 2, p: [start[0], y + 1.5, start[2]], yaw: 0, pitch: 0, f: 0, c: 1 }, 600);
    expect(got.at(-1)).toEqual({ t: 'correct', p: start, c: 2, ack: 2 });
    room.handle(c, { t: 'input', seq: 3, p: [(start[0] + x) / 2, y, (start[2] + z) / 2], yaw: 0, pitch: 0, f: 0 }, 700);
    expect(pl.p[0]).toBeCloseTo((start[0] + x) / 2);
  });

  it('accepts a capsule walking up 教学楼A to 2F', () => {
    const { room, c, got, pl } = setup();
    // the route starts outdoors and ends on 2F, out of L1's area: lift the soft boundary, this checks the colliders
    room.level = { ...room.level, def: { ...room.level.def, barriers: [], area: { x0: -1e4, x1: 1e4, z0: -1e4, z1: 1e4, y0: -1, y1: 99 } } };
    room.resetDoors();
    const w = room.world!;
    const route = stairRoute(CAMPUS.buildings.find(b => b.id === 'A')!, 2);
    // start where the client would: on the route's first point outside the entrance, already accepted by the server
    const p: Body = { x: route[0][0], y: 0, z: route[0][1], vy: 0, grounded: true };
    pl.p = [p.x, p.y, p.z];
    let now = 0, seq = 0;
    for (const [tx, tz] of route.slice(1)) {
      for (let guard = 0; guard < 400; guard++) {
        const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
        if (d < 0.1) break;
        const s = Math.min(0.26, d) / d; // walk speed for 0.1 s
        moveCapsule(w, p, dx * s, dz * s, 0.1, NAV_CAPSULE);
        for (let i = 0; i < 20 && !p.grounded; i++) moveCapsule(w, p, 0, 0, 0.05, NAV_CAPSULE);
        now += 100;
        room.handle(c, { t: 'input', seq: ++seq, p: [p.x, p.y, p.z], yaw: 0, pitch: 0, f: 0 }, now);
      }
    }
    expect(got.filter(m => m.t === 'correct')).toEqual([]);
    expect(pl.p[1]).toBeGreaterThan(2.5);
  });

  it('corrects a step out of the level area (the soft boundary behind the barriers)', () => {
    const { room, c, got, pl } = setup();
    // the main gate's grate taken away: walking out of the doorway is still refused at the area's edge (z0 - margin)
    room.level = { ...room.level, def: { ...room.level.def, barriers: [] } };
    room.resetDoors();
    const z0 = room.level.def.area.z0;
    pl.p = [-40, 0, z0 + 0.2];
    room.handle(c, { t: 'input', seq: 1, p: [-40, 0, z0 - 0.05], yaw: 0, pitch: 0, f: 0 }, 100);
    expect(got.filter(m => m.t === 'correct')).toEqual([]);
    room.handle(c, { t: 'input', seq: 2, p: [-40, 0, z0 - 0.4], yaw: 0, pitch: 0, f: 0 }, 200);
    expect(got.at(-1)).toMatchObject({ t: 'correct', ack: 2 });
    expect(pl.p[2]).toBeCloseTo(z0 - 0.05);
  });

  it('closed campus doors block the capsule until opened by E; a keyed door starts locked', () => {
    const { room, c, got, pl } = setup();
    const d = room.doors.find(q => q.y0 === 0 && !q.locked)!;
    expect(room.doorLocked.some(Boolean)).toBe(true);
    // stand 1 m in front of the door, then step through it
    const n = d.alongX ? [0, 1] : [1, 0];
    pl.p = [d.x - n[0], 0, d.z - n[1]];
    const through: [number, number, number] = [d.x + n[0], 0, d.z + n[1]];
    room.handle(c, { t: 'input', seq: 1, p: through, yaw: 0, pitch: 0, f: 0 }, 1000);
    expect(got.filter(m => m.t === 'correct')).toHaveLength(1);
    expect(room.world!.floorAt(d.x, d.z)).toBe(0);
    room.handle(c, { t: 'door', id: d.id }, 1100);
    expect(room.doorOpen[d.id]).toBe(true);
    pl.lastInput = 1000;
    room.handle(c, { t: 'input', seq: 2, p: through, yaw: 0, pitch: 0, f: 0 }, 1500);
    expect(got.filter(m => m.t === 'correct')).toHaveLength(1);
    expect(pl.p[0]).toBeCloseTo(through[0]);
    // standing in the doorway: it can't be shut
    pl.p = [d.x, 0, d.z];
    room.handle(c, { t: 'door', id: d.id }, 1600);
    expect(room.doorOpen[d.id]).toBe(true);
  });
});

describe('locked doors', () => {
  it('open only for a player holding the key', () => {
    const { room, pl } = setup();
    const id = room.doorLocked.findIndex((l, i) => l && !room.regionLocked.has(i));
    expect(id).toBeGreaterThanOrEqual(0);
    const d = room.doors[id];
    pl.p = [d.x, pl.p[1], d.z];
    expect(room.toggleDoor(pl, id)).toBe(false);
    room.giveKey(1, id);
    expect(room.toggleDoor(pl, id)).toBe(true);
    expect(room.doorLocked[id]).toBe(false);
    expect(room.doorOpen[id]).toBe(true);
  });

  it('doors out of the level area stay locked for good, even with their key', () => {
    const { room, pl } = setup();
    expect(room.regionLocked.size).toBeGreaterThan(100);
    for (const id of [173, 180, 182, 104]) { // the campus's keyed doors, a 2F door of 教学楼A (第 2 关)
      expect(room.regionLocked.has(id)).toBe(true);
      expect(room.doorLocked[id]).toBe(true);
      const d = room.doors[id];
      pl.p = [d.x, d.y0 ?? 0, d.z];
      room.giveKey(1, id);
      expect(room.toggleDoor(pl, id)).toBe(false);
      expect(room.doorOpen[id]).toBe(false);
    }
    for (let id = 0; id < 18; id++) expect(room.regionLocked.has(id)).toBe(false); // 教学楼A 1F: all of them in the area
  });
});

describe('key items', () => {
  it('an E-pick on a key picks it up, removes it for everyone and unlocks its door', () => {
    const { room, got, pl } = setup();
    const key = room.items.find(k => k.kind === 'door_key')!;
    expect(room.items.length).toBeGreaterThan(0);
    expect(got.find(m => m.t === 'items')).toMatchObject({ items: room.items });
    const d = room.doors[key.door!];
    pl.p = [d.x, pl.p[1], d.z];
    expect(room.toggleDoor(pl, key.door!)).toBe(false); // no key yet
    pl.p = [key.p[0], key.p[1], key.p[2]];
    room.act(pl, 'pick', key.id);
    expect(room.items.find(k => k.id === key.id)).toBeUndefined();
    expect(got.filter(m => m.t === 'keys').pop()).toMatchObject({ keys: [key.door] });
    expect(room.items.find(k => k.id === key.id)).toBeUndefined();
    pl.p = [d.x, pl.p[1], d.z];
    expect(room.toggleDoor(pl, key.door!)).toBe(true);
    expect(room.doorOpen[key.door!]).toBe(true);
  });

  it('other doors stay locked and a far-away player picks nothing up', () => {
    const { room, pl } = setup();
    const n = room.items.length;
    const [a, b] = room.items.filter(k => k.kind === 'door_key');
    pl.p = [a.p[0] + 5, a.p[1], a.p[2]];
    expect(room.act(pl, 'pick', a.id)).toBe(false);
    expect(room.items.length).toBe(n);
    pl.p = [a.p[0], a.p[1], a.p[2]];
    expect(room.act(pl, 'pick', a.id)).toBe(true);
    const d = room.doors[b.door!];
    pl.p = [d.x, pl.p[1], d.z];
    expect(room.toggleDoor(pl, b.door!)).toBe(false);
  });
});

describe('shared bag', () => {
  it('a pick-up is removed for everyone (snap.gone), unlocks for the team and goes into the bag', () => {
    const { room, got, pl } = setup();
    const c2: Conn = { id: 2, name: 'p2', send: (m) => got2.push(m), sendRaw: (s) => got2.push(JSON.parse(s)) };
    const got2: ServerMsg[] = [];
    room.add(c2, 0);
    const bat = room.items.find(i => i.kind === 'battery')!;
    const key = room.items.find(i => i.kind === 'door_key')!;
    for (const k of [bat, key]) { pl.p = [k.p[0], k.p[1], k.p[2]]; expect(room.act(pl, 'pick', k.id)).toBe(true); }
    // the second player no longer sees them: not in the item list, announced as gone, and can't pick them
    expect(room.items.some(i => i.id === bat.id || i.id === key.id)).toBe(false);
    const p2 = room.players.get(2)!;
    p2.p = [bat.p[0], bat.p[1], bat.p[2]];
    expect(room.act(p2, 'pick', bat.id)).toBe(false);
    room.step();
    expect(got2.filter(m => m.t === 'snap').pop()).toMatchObject({ gone: [bat.id, key.id] });
    room.step();
    expect((got2.filter(m => m.t === 'snap').pop() as { gone?: number[] }).gone).toBeUndefined();
    // the team shares the bag: player 2 got the update and a late joiner is told the full state
    expect(got2.filter(m => m.t === 'bag').pop()).toMatchObject({ bag: { battery: 1 } });
    expect(got2.filter(m => m.t === 'keys').pop()).toMatchObject({ keys: [key.door] });
    const got3: ServerMsg[] = [];
    room.add({ id: 3, name: 'p3', send: (m) => got3.push(m), sendRaw: () => {} }, 0);
    expect(got3.find(m => m.t === 'items')).toMatchObject({ items: room.items });
    expect(got3.find(m => m.t === 'bag')).toMatchObject({ bag: { battery: 1 } });
    expect(got3.find(m => m.t === 'keys')).toMatchObject({ keys: [key.door] });
    // player 2 may open the door with the team's key
    const d = room.doors[key.door!];
    p2.p = [d.x, p2.p[1], d.z];
    expect(room.toggleDoor(p2, key.door!)).toBe(true);
  });

  it('draws one door key per locked door inside the area, each on its own spot', () => {
    const { room } = setup();
    const keys = room.items.filter(i => i.kind === 'door_key');
    expect(keys.map(k => k.door).sort()).toEqual([5, 6, 7]);
    expect(room.items.filter(i => i.kind === 'stair_key' && !i.decoy)).toHaveLength(1);
    expect(room.items.filter(i => i.kind === 'drawer_key' && !i.decoy)).toHaveLength(1);
    expect(new Set(room.items.map(i => i.p.join())).size).toBe(room.items.length);
  });
});

describe('act (E at the crosshair): server-side reach 2 m', () => {
  it('pick: refused beyond 2 m, accepted within, and walking onto a key no longer picks it', () => {
    const { room, pl, c } = setup();
    const k = room.items.find(i => i.kind === 'door_key')!;
    pl.p = [k.p[0] + 2.6, k.p[1], k.p[2]];
    expect(room.act(pl, 'pick', k.id)).toBe(false);
    pl.p = [k.p[0] + 0.3, k.p[1], k.p[2]];
    pl.lastInput = 0;
    room.handle(c, { t: 'input', seq: 1, p: [k.p[0], k.p[1], k.p[2]], yaw: 0, pitch: 0, f: 0 }, 100);
    expect(room.items).toContain(k);
    pl.p = [k.p[0] + 1.7, k.p[1], k.p[2]];
    expect(room.act(pl, 'pick', k.id)).toBe(true);
    expect(room.act(pl, 'pick', k.id)).toBe(false); // already gone
  });

  it('use: a door needs the player within 2 m of it', () => {
    const { room, pl, c } = setup();
    const id = room.doorLocked.findIndex((l) => !l);
    const d = room.doors[id];
    const y = d.y0 ?? 0;
    pl.p = [d.box.x1 + 2.5, y, d.box.z1 + 2.5];
    room.handle(c, { t: 'act', kind: 'use', id }, 0);
    expect(room.doorOpen[id]).toBe(false);
    pl.p = [d.x, y, d.z];
    room.handle(c, { t: 'act', kind: 'use', id }, 0);
    expect(room.doorOpen[id]).toBe(true);
    pl.p = [d.x + 2.2, y, d.z + 2.2];
    room.handle(c, { t: 'act', kind: 'use', id }, 0);
    expect(room.doorOpen[id]).toBe(true); // too far to shut it
  });

  it('revive: needs a teammate within reach holding E for REVIVE_S', () => {
    const { room, pl } = setup();
    const c2: Conn = { id: 2, name: 'p2', send: () => {}, sendRaw: () => {} };
    room.add(c2, 0);
    const o = room.players.get(2)!;
    o.st = 1; o.heldUntil = 999;
    o.p = [pl.p[0] + 3, pl.p[1], pl.p[2]];
    expect(room.act(pl, 'revive', 2)).toBe(false);
    o.p = [pl.p[0] + 1.2, pl.p[1], pl.p[2]];
    expect(room.act(pl, 'revive', 1)).toBe(false); // not yourself
    const n = Math.ceil((REVIVE_S * 1000) / TICK_MS);
    for (let i = 0; i < n - 2; i++) { expect(room.act(pl, 'revive', 2)).toBe(true); room.step(); }
    expect(o.st).toBe(1); // still holding
    for (let i = 0; i < 3; i++) { room.act(pl, 'revive', 2); room.step(); }
    expect(o.st).toBe(0);
    expect(o.heldUntil).toBeUndefined();
    expect(room.act(pl, 'revive', 2)).toBe(false); // already up
  });

  it('revive: reaches the downed body where it lies, head end included, turned with its facing', () => {
    const { room, pl } = setup();
    room.add({ id: 2, name: 'p2', send: () => {}, sendRaw: () => {} }, 0);
    const o = room.players.get(2)!;
    o.st = 1; o.heldUntil = 9999;
    o.yaw = Math.PI / 2; // lying with the head towards -X, i.e. at pl
    o.p = [pl.p[0] + 3.0, pl.p[1], pl.p[2]];
    expect(room.act(pl, 'revive', 2)).toBe(false); // 3 − 0.85 > 2
    o.p = [pl.p[0] + 2.8, pl.p[1], pl.p[2]]; // ≈ 1.95 m from the head (the old 0.5 m box at the root: 2.3 → refused)
    o.yaw = Math.PI; // turned: its right side (0.75 m) towards pl
    expect(room.act(pl, 'revive', 2)).toBe(false);
    o.yaw = Math.PI / 2;
    const n = Math.ceil((REVIVE_S * 1000) / TICK_MS);
    for (let i = 0; i < n - 2; i++) { expect(room.act(pl, 'revive', 2)).toBe(true); room.step(); }
    expect(o.st).toBe(1);
    for (let i = 0; i < 3; i++) { room.act(pl, 'revive', 2); room.step(); }
    expect(o.st).toBe(0); // held the whole REVIVE_S from the head end
  });

  it('revive: releasing E resets the progress', () => {
    const { room, pl } = setup();
    room.add({ id: 2, name: 'p2', send: () => {}, sendRaw: () => {} }, 0);
    const o = room.players.get(2)!;
    o.st = 1; o.heldUntil = 9999;
    o.p = [pl.p[0] + 1, pl.p[1], pl.p[2]];
    const n = Math.ceil((REVIVE_S * 1000) / TICK_MS);
    for (let i = 0; i < n - 20; i++) { room.act(pl, 'revive', 2); room.step(); }
    for (let i = 0; i < 16; i++) room.step(); // let go
    expect(pl.reviving).toBeUndefined();
    for (let i = 0; i < 11; i++) { room.act(pl, 'revive', 2); room.step(); }
    expect(o.st).toBe(1);
  });

  it('downed: retains the whole 30-second rescue window while a standing teammate remains', () => {
    const { room, got, pl } = setup();
    room.add({ id: 2, name: 'standing rescuer', send: () => {}, sendRaw: () => {} }, 0);
    const rescuer = room.players.get(2)!;
    rescuer.safeUntil = 100_000;
    const ticks = Math.ceil((CAUGHT_HOLD_S * 1000) / TICK_MS), at = [...pl.p];
    pl.st = ST_DOWN; pl.heldUntil = room.tick + ticks;
    for (let i = 0; i < ticks - 1; i++) room.step();
    expect(pl.st).toBe(ST_DOWN);
    expect(pl.p).toEqual(at);
    expect(got.filter(m => m.t === 'fade')).toEqual([]);
    room.step();
    expect(pl.st).toBe(ST_SPECTATE);
    expect(pl.heldUntil).toBeUndefined();
    expect(rescuer.st).toBe(ST_OK);
    expect(got.filter(m => m.t === 'fade')).toEqual([]);
  });

  it('a lone downed player ends the attempt in one tick and returns to spawn only after the restart fade', () => {
    const { room, got, pl } = setup();
    const spawn = [...pl.p];
    room.handle(pl.conn, { t: 'debug', op: 'tp', x: -30, z: 73.36 }, 0);
    const at = [...pl.p];
    expect(at).not.toEqual(spawn);
    pl.st = ST_DOWN; pl.heldUntil = room.tick + Math.ceil((CAUGHT_HOLD_S * 1000) / TICK_MS);
    room.step();
    expect(pl.st).toBe(ST_SPECTATE);
    expect(pl.heldUntil).toBeUndefined();
    expect(pl.p).toEqual(at);
    expect(got.filter(m => m.t === 'fade')).toEqual([{ t: 'fade', secs: LEVEL_FADE_S, restart: true }]);
    for (let i = 0; i < LEVEL_FADE_S * 1000 / TICK_MS - 1; i++) room.step();
    expect(pl.st).toBe(ST_SPECTATE);
    expect(pl.p).toEqual(at);
    room.step();
    expect(pl.st).toBe(ST_OK);
    expect(pl.p).toEqual(spawn);
  });

  it('downed players cannot use doors or items', () => {
    const { room, c, pl } = setup();
    pl.st = 1; pl.heldUntil = 999;
    room.handle(c, { t: 'use', item: 'battery' }, 0);
    expect(pl.battery).toBe(1);
  });
});
