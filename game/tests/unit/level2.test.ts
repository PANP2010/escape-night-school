import { beforeAll, describe, expect, it } from 'vitest';
import { exitOpen, fusesNeeded, generateLevel, inArea, inExit, LEVELS, powered } from '../../shared/level.ts';
import type { NavGraph } from '../../shared/campus/nav.ts';
import { campusNavCached } from '../../client/src/campus/world/navcache.ts';
import { type ServerMsg } from '../../shared/protocol.ts';
import { LEVEL_FADE_S, pickWardenStart, RoomManager, type Conn } from '../../server/room.ts';
import { mulberry32 } from '../../shared/rng.ts';
import { TICK_MS } from '../../shared/constants.ts';

const L2 = LEVELS[1];

describe('第 2 关「二楼·停电」参数表', () => {
  it('教学楼B 2F, blackout with 3 fuses', () => {
    expect(L2.name).toBe('二楼·停电');
    expect(L2.building).toBe('B');
    expect(L2.floors).toEqual([2]);
    expect(L2.blackout?.fuses).toBe(3);
    expect(L2.blackout?.emergency.length).toBeGreaterThanOrEqual(2);
    expect(L2.spawns).toHaveLength(4);
  });

  it('draws 3 fuses (one per lectern) + four candidate batteries, all inside the region, deterministic per seed', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const lv = generateLevel(1, seed);
      expect(lv.items.filter((i) => i.kind === 'fuse')).toHaveLength(3);
      expect(lv.items.filter((i) => i.kind === 'battery')).toHaveLength(4);
      expect(lv.items.filter((i) => i.kind === 'stair_key' || i.kind === 'door_key')).toHaveLength(0);
      expect(new Set(lv.items.map((i) => i.spot)).size).toBe(lv.items.length);
      for (const it of lv.items) expect(inArea(lv, it.x, it.y, it.z), `${seed} ${it.spot}`).toBe(true);
    }
    expect(generateLevel(1, 7)).toEqual(generateLevel(1, 7));
  });

  it('spawns, fuse box and emergency lamps lie in the region; the exit is on 2F', () => {
    const lv = generateLevel(1, 1), bo = L2.blackout!;
    for (const s of lv.spawns) expect(inArea(lv, s.x, s.y!, s.z)).toBe(true);
    expect(inArea(lv, bo.fuseBox.x, bo.fuseBox.y, bo.fuseBox.z)).toBe(true);
    for (const e of bo.emergency) expect(inArea(lv, e.x, e.y, e.z)).toBe(true);
    expect(inExit(lv, L2.exit.x, 3.6, L2.exit.z)).toBe(true);
    expect(inExit(lv, L2.exit.x, 0, L2.exit.z)).toBe(false); // the 1F below is not the exit
  });
});

describe('出口条件', () => {
  const lv = generateLevel(1, 1), l1 = generateLevel(0, 1);
  it('the exit needs all fuses in (the stair key does not matter); level 1 still needs the stair key', () => {
    expect(fusesNeeded(lv)).toBe(3);
    expect([0, 1, 2, 3].map((n) => powered(lv, n))).toEqual([false, false, false, true]);
    expect(exitOpen(lv, 2, { stair_key: 1 })).toBe(false);
    expect(exitOpen(lv, 3, {})).toBe(true);
    expect(fusesNeeded(l1)).toBe(0);
    expect(exitOpen(l1, 0, {})).toBe(false);
    expect(exitOpen(l1, 0, { stair_key: 1 })).toBe(true);
  });
});

describe('nav', () => {
  let nav: NavGraph;
  beforeAll(() => { nav = campusNavCached('.cache/campus-nav.json').graph; }, 120_000);
  it('every spawn reaches the exit, the fuse box and every item spot on 2F', () => {
    const at = (p: { x: number; z: number }) => nav.nearest(p.x, 3.6, p.z);
    const exit = at(L2.exit);
    for (const sp of L2.spawns) {
      const reach = new Set(nav.reachable(at(sp)));
      expect(reach.has(exit)).toBe(true);
      expect(reach.has(at(L2.blackout!.fuseBox))).toBe(true);
      for (const g of L2.items) for (const s of g.spots) expect(reach.has(at(s)), s.label).toBe(true);
    }
  });
  it('hiding places lie in the region on the 2F nav, and 角色074 starts on 2F, connected to the spawns', () => {
    const at = (p: { x: number; z: number }) => nav.nearest(p.x, 3.6, p.z);
    expect(L2.hides.length).toBeGreaterThan(100);
    expect(L2.hides.some((h) => h.kind === 'locker')).toBe(true);
    for (const h of L2.hides) expect(h.x >= L2.area.x0 && h.x <= L2.area.x1 && h.z >= L2.area.z0 && h.z <= L2.area.z1, `${h.x},${h.z}`).toBe(true);
    const sp = L2.spawns[0], reach = [...nav.reachable(at(sp))];
    for (const seed of [1, 2, 3, 4, 5]) {
      const w = nav.nodes[pickWardenStart(nav, sp, reach, mulberry32(seed))];
      expect(Math.abs(w.y - 3.6), `seed ${seed}`).toBeLessThan(1.5);
    }
  });
});

describe('room: fuse box', () => {
  const setup = () => {
    const room = new RoomManager(mulberry32(3)).create();
    const got: ServerMsg[] = [];
    const mk = (id: number): Conn => ({ id, name: `p${id}`, send: (m) => got.push(m), sendRaw: (s) => got.push(JSON.parse(s)) });
    room.add(mk(1), 0);
    (room as any).loadLevel(1);
    return { room, got, p1: room.players.get(1)! };
  };
  const run = (room: { step(): void }, s: number) => { for (let i = 0; i < Math.ceil((s * 1000) / TICK_MS) + 2; i++) room.step(); };
  const atBox = (room: ReturnType<typeof setup>['room'], p: { p: number[] }) => { const b = L2.blackout!.fuseBox; p.p = [b.x, b.y, b.z - 0.5]; };

  it('spawns on 2F; fuses go in one by one near the box; the exit opens only when all 3 are in', () => {
    const { room, got, p1 } = setup();
    expect(p1.p[1]).toBeGreaterThan(3);
    room.bag = { fuse: 3 };
    p1.p = [L2.spawns[0].x, 3.6, L2.spawns[0].z];
    room.act(p1, 'fuse', 0);
    expect(room.fusesIn).toBe(0); // too far from the box
    atBox(room, p1);
    room.act(p1, 'fuse', 0);
    room.act(p1, 'fuse', 0);
    expect(room.fusesIn).toBe(2);
    expect(room.bag.fuse).toBe(1);
    p1.p = [L2.exit.x, 3.6, L2.exit.z];
    run(room, 0.5);
    expect(got.some((m) => m.t === 'fade')).toBe(false); // no power yet
    atBox(room, p1);
    room.act(p1, 'fuse', 0);
    expect(room.fusesIn).toBe(3);
    expect(got.filter((m) => m.t === 'power').pop()).toMatchObject({ n: 3 });
    room.act(p1, 'fuse', 0); // no fuse left / box full
    expect(room.fusesIn).toBe(3);
    p1.p = [L2.exit.x, 3.6, L2.exit.z];
    room.step();
    expect(got.find((m) => m.t === 'fade')).toMatchObject({ secs: LEVEL_FADE_S, restart: false });
  });

  it('a fresh load of the level puts the fuses back out', () => {
    const { room } = setup();
    room.bag = { fuse: 1 };
    atBox(room, room.players.get(1)!);
    room.act(room.players.get(1)!, 'fuse', 0);
    expect(room.fusesIn).toBe(1);
    (room as any).loadLevel(1);
    expect(room.fusesIn).toBe(0);
    expect(room.bag).toEqual({});
  });
});
