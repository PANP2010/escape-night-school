import { describe, expect, it } from 'vitest';
import { type ServerMsg, ST_SPECTATE } from '../../shared/protocol.ts';
import { LEVEL_FADE_S, RoomManager, type Conn } from '../../server/room.ts';
import { mulberry32 } from '../../shared/rng.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { NavGraph } from '../../shared/campus/nav.ts';

const setup = () => {
  const room = new RoomManager(mulberry32(3)).create();
  const got: ServerMsg[] = [];
  const mk = (id: number): Conn => ({ id, name: `p${id}`, send: (m) => got.push(m), sendRaw: (s) => got.push(JSON.parse(s)) });
  room.add(mk(1), 0); room.add(mk(2), 0);
  return { room, got, p1: room.players.get(1)!, p2: room.players.get(2)! };
};
const run = (room: { step(): void }, s: number) => { for (let i = 0; i < Math.ceil((s * 1000) / TICK_MS) + 2; i++) room.step(); };
const toExit = (room: ReturnType<typeof setup>['room'], ...pls: { p: number[] }[]) => { for (const p of pls) p.p = [room.level.exit.x, room.level.exit.y, room.level.exit.z]; };

describe('room level state machine', () => {
  it('needs the stair key and every survivor in the exit; then fades LEVEL_FADE_S and loads the next level', () => {
    const { room, got, p1, p2 } = setup();
    toExit(room, p1, p2);
    run(room, 0.5);
    expect(got.some((m) => m.t === 'fade')).toBe(false); // no key yet
    room.bag = { stair_key: 1 };
    toExit(room, p1);
    p2.p = [...room.level.spawns.map((s) => [s.x, 0, s.z])[0]] as [number, number, number];
    run(room, 0.5);
    expect(got.some((m) => m.t === 'fade')).toBe(false); // p2 is not in the exit
    toExit(room, p2);
    room.step();
    expect(got.find((m) => m.t === 'fade')).toMatchObject({ secs: LEVEL_FADE_S, restart: false });
    expect(room.levelIndex).toBe(0);
    run(room, LEVEL_FADE_S);
    expect(room.levelIndex).toBe(1);
    expect(room.bag).toEqual({});
    expect(room.level.seed).toBe(room.seed);
    expect(got.filter((m) => m.t === 'room').pop()).toMatchObject({ level: 1 });
  });

  it('everyone out restarts the same level; a spectator-only survivor set does not count as out', () => {
    const { room, got, p1, p2 } = setup();
    p1.st = ST_SPECTATE;
    run(room, 0.5);
    expect(got.some((m) => m.t === 'fade')).toBe(false);
    p2.st = ST_SPECTATE;
    room.step();
    expect(got.find((m) => m.t === 'fade')).toMatchObject({ restart: true });
    run(room, LEVEL_FADE_S);
    expect(room.levelIndex).toBe(0);
    expect(p1.st).toBe(0);
  });
  it("sends the level's nav graph (cm) on join and again with each new level", () => {
    const nav = new NavGraph();
    nav.chain([{ x: 0, y: 0, z: 0 }, { x: 1.234, y: 0, z: 5 }, { x: 1.234, y: 3.6, z: 9 }]);
    const room = new RoomManager(mulberry32(3), () => nav).create();
    const got: ServerMsg[] = [];
    for (const id of [1, 2]) room.add({ id, name: `p${id}`, send: (m) => got.push(m), sendRaw: (s) => got.push(JSON.parse(s)) }, 0);
    const [p1, p2] = [room.players.get(1)!, room.players.get(2)!];
    const navs = () => got.filter((m): m is Extract<ServerMsg, { t: 'nav' }> => m.t === 'nav');
    expect(navs().length).toBe(2); // one per joiner
    const n0 = navs()[0];
    expect(n0.n.length).toBe(n0.adj.length * 3);
    expect(n0).toEqual({ t: 'nav', n: [0, 0, 0, 123, 0, 500, 123, 360, 900], adj: [[1], [0, 2], [1]] });
    room.bag = { stair_key: 1 };
    toExit(room, p1, p2);
    run(room, LEVEL_FADE_S + 0.5);
    expect(room.levelIndex).toBe(1);
    expect(navs().length).toBe(4); // broadcast to both
    expect(navs()[2]).toEqual(n0); // a test graph has no node in either area → all of it
  });
});
