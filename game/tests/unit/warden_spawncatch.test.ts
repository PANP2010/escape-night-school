import { describe, expect, it } from 'vitest';
import { campusNavCached } from '../../client/src/campus/world/navcache.ts';
import { TICK_MS } from '../../shared/constants.ts';
import type { ServerMsg } from '../../shared/protocol.ts';
import { mulberry32 } from '../../shared/rng.ts';
import { RoomManager, SAFE_S, type Conn } from '../../server/room.ts';
import { WARDEN_RETREAT_M, type WardenAI } from '../../server/ai/warden.ts';

// Review #188 / #193: three players at the spawn were caught one after another (0.6 / 4.9 / 8.6 s), a revived player was
// prey again at once, and a team-wipe restart left 角色074 wherever he was (6.9 m from the spawn → caught again at +0.4 s).
const PER_S = 1000 / TICK_MS;
type P = { p: number[]; yaw: number; st: number };

function campusRoom(seed: number) {
  const graph = campusNavCached('.cache/campus-nav.json').graph;
  const room = new RoomManager(mulberry32(seed), () => graph).create();
  const caught: { id: number; tick: number }[] = [];
  let tick = 0;
  const conns: Conn[] = [1, 2, 3].map((id) => ({ id, name: `p${id}`, send: (m: ServerMsg) => { if (m.t === 'caught') caught.push({ id, tick }); }, sendRaw: () => {} }));
  for (const c of conns) room.add(c, 0);
  room.handle(conns[0], { t: 'start' }, 0);
  const pl = (id: number) => room.players.get(id) as unknown as P;
  const warden = (room as unknown as { warden: WardenAI }).warden;
  const level = (room as unknown as { level: { spawns: { x: number; z: number }[] } }).level;
  const run = (s: number) => { for (let i = 0; i < s * PER_S; i++) { room.step(); tick++; } };
  // everyone within 1.2 m of player 1, looking the same way
  const huddle = () => { const a = pl(1); for (const id of [2, 3]) { pl(id).p = [a.p[0] + (id - 1) * 0.6, a.p[1], a.p[2]]; pl(id).yaw = a.yaw; } };
  return { room, conns, caught, pl, warden, level, run, huddle, now: () => tick };
}

const flat = (a: readonly number[], b: { x: number; z: number } | readonly number[]) =>
  Array.isArray(b) ? Math.hypot(a[0] - b[0], a[2] - b[2]) : Math.hypot(a[0] - (b as { x: number }).x, a[2] - (b as { z: number }).z);

describe('角色074 at the spawn: no chain catches', () => {
  it('three players standing together: one catch, then he walks ≥ 15 m off and nobody else is caught within 5 s', () => {
    const r = campusRoom(5);
    r.run(1);
    r.huddle();
    r.room.handle(r.conns[0], { t: 'debug', op: 'warden', d: 7 }, 0);
    let spot: number[] | undefined, farthest = 0;
    for (let s = 0; s < 25 * PER_S; s++) {
      r.run(1 / PER_S);
      if (r.caught.length && !spot) spot = [...r.warden.p];
      if (spot) farthest = Math.max(farthest, flat(r.warden.p, spot));
    }
    expect(r.caught.length).toBeGreaterThan(0);
    const first = r.caught[0].tick;
    expect(r.caught.filter((c) => c.tick > first && c.tick - first < 5 * PER_S)).toEqual([]);
    expect(r.warden.retreating).toBe(false);
    expect(farthest).toBeGreaterThanOrEqual(WARDEN_RETREAT_M);
    // the huddle is still up and nobody but the first was caught in those 25 s
    expect(new Set(r.caught.map((c) => c.id)).size).toBe(r.caught.length);
  }, 120000);

  it('a revived player is not caught for SAFE_S (≥ 4 s), even with 角色074 forced onto them; afterwards they are', () => {
    const r = campusRoom(7);
    r.run(1);
    r.huddle();
    r.room.handle(r.conns[1], { t: 'debug', op: 'down', s: 30 }, 0);
    expect(r.pl(2).st).toBe(1);
    // player 3 holds E on player 2 for REVIVE_S
    const a = r.pl(2).p;
    r.pl(3).p = [a[0] + 0.4, a[1], a[2]];
    for (let i = 0; i < 4 * PER_S && r.pl(2).st !== 0; i++) { expect(r.room.act(r.room.players.get(3)!, 'revive', 2)).toBe(true); r.run(1 / PER_S); }
    expect(r.pl(2).st).toBe(0);
    const t0 = r.now();
    // 角色074 right in front of the revived player, chasing them
    const b = r.pl(2), fx = -Math.sin(b.yaw), fz = -Math.cos(b.yaw);
    r.warden.forceChase([b.p[0] + fx * 1.5, b.p[1], b.p[2] + fz * 1.5], b.yaw + Math.PI, 2, b.p as [number, number, number]);
    r.run(SAFE_S - 0.1);
    expect(SAFE_S).toBeGreaterThanOrEqual(4);
    expect(r.caught.filter((c) => c.id === 2 && c.tick >= t0)).toEqual([]);
    expect(r.pl(2).st).toBe(0);
    // grace over: the same forced chase catches them
    r.run(0.2);
    const c = r.pl(2), gx = -Math.sin(c.yaw), gz = -Math.cos(c.yaw);
    r.warden.forceChase([c.p[0] + gx * 1.5, c.p[1], c.p[2] + gz * 1.5], c.yaw + Math.PI, 2, c.p as [number, number, number]);
    r.run(5);
    expect(r.caught.filter((c) => c.id === 2 && c.tick >= t0).length).toBe(1);
  }, 120000);

  it('team wipe → restart: 角色074 starts ≥ 15 m from every spawn and nobody is caught in the first 5 s', () => {
    const r = campusRoom(9);
    r.run(1);
    r.huddle();
    // he is chasing right at the spawn when everyone goes down (1 s) → spectate → LEVEL_FADE_S → loadLevel
    r.room.handle(r.conns[0], { t: 'debug', op: 'warden', d: 3 }, 0);
    r.run(0.1);
    for (const c of r.conns) r.room.handle(c, { t: 'debug', op: 'down', s: 1 }, 0);
    let back = -1;
    for (let i = 0; i < 10 * PER_S && back < 0; i++) { r.run(1 / PER_S); if (i > PER_S && [1, 2, 3].every((id) => r.pl(id).st === 0)) back = r.now(); }
    expect(back).toBeGreaterThan(0);
    const start = r.warden.p;
    for (const sp of r.level.spawns) expect(flat(start, sp)).toBeGreaterThanOrEqual(WARDEN_RETREAT_M);
    expect(r.warden.state).toBe('patrol');
    r.run(5);
    expect(r.caught.filter((c) => c.tick >= back)).toEqual([]);
  }, 120000);
});
