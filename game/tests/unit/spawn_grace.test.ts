import { describe, expect, it } from 'vitest';
import { campusNavCached } from '../../client/src/campus/world/navcache.ts';
import { TICK_MS } from '../../shared/constants.ts';
import type { ServerMsg } from '../../shared/protocol.ts';
import type { IntroEvent } from '../../shared/intro.ts';
import { mulberry32 } from '../../shared/rng.ts';
import { RoomManager, OPEN_GRACE_S, SPAWN_CLEAR_M, type Conn } from '../../server/room.ts';
import type { WardenAI } from '../../server/ai/warden.ts';
import type { MonitorAI } from '../../server/ai/monitor.ts';

// #206: three players standing still at the spawn went down 4–7.5 s after it with 「你被角色074抓住了」 — he patrolled onto the
// spawn row. Mobs now start ≥ SPAWN_CLEAR_M from every spawn, hunt nobody for OPEN_GRACE_S, and 'caught' says who did it.
const PER_S = 1000 / TICK_MS;
type R = { warden: WardenAI; monitors: MonitorAI[]; level: { spawns: { x: number; z: number }[] }; loadLevel(i: number): void };

function campusRoom(seed: number) {
  const graph = campusNavCached('.cache/campus-nav.json').graph;
  // a lobby room started by its host, as on the real server (an already-running test room skips start())
  const room = new RoomManager(mulberry32(seed), () => graph).create(true);
  const caught: { id: number; by: string }[] = [];
  let intro: IntroEvent | undefined;
  const receive = (id: number, m: ServerMsg) => {
    if (m.t === 'caught') caught.push({ id, by: m.by });
    if (m.t === 'event' && m.kind === 'intro') intro = m;
  };
  const conns: Conn[] = [1, 2, 3].map((id) => ({ id, name: `p${id}`, send: (m) => receive(id, m), sendRaw: (raw) => receive(id, JSON.parse(raw)) }));
  for (const c of conns) room.add(c, 0);
  room.handle(conns[0], { t: 'start' }, 0);
  const skipIntro = () => {
    expect(intro).toBeDefined();
    for (const conn of conns) room.handle(conn, { t: 'intro-skip', id: intro!.id }, intro!.now);
    expect(room.introFrozen).toBe(false);
  };
  skipIntro(); // measure the full opening grace after gameplay starts
  const r = room as unknown as R;
  // These are loaded, stationary clients: exercise AI opening safety after the finite personal grace, too.
  const ready = () => { for (const c of conns) room.handle(c, { t: 'ready', incarnation: room.incarnation }, room.tick * TICK_MS); };
  ready();
  const loadLevel = (index: number) => { r.loadLevel(index); ready(); };
  const run = (s: number) => { for (let i = 0; i < s * PER_S; i++) room.step(); };
  const clear = (p: readonly number[]) => Math.min(...r.level.spawns.map((q) => Math.hypot(p[0] - q.x, p[2] - q.z)));
  return { room, conns, caught, r, loadLevel, run, clear, skipIntro };
}

describe('spawn grace (#206)', () => {
  it('角色074 and the 无脸值日生 start ≥ SPAWN_CLEAR_M from every player spawn (L1 and L2, several seeds)', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const t = campusRoom(seed);
      expect(t.clear(t.r.warden.p)).toBeGreaterThanOrEqual(SPAWN_CLEAR_M);
      t.loadLevel(1);
      t.skipIntro();
      expect(t.r.monitors.length).toBeGreaterThan(0);
      for (const m of t.r.monitors) expect(t.clear(m.p)).toBeGreaterThanOrEqual(SPAWN_CLEAR_M);
      expect(t.clear(t.r.warden.p)).toBeGreaterThanOrEqual(SPAWN_CLEAR_M);
    }
  }, 120000);

  it('three players standing still at the spawn: nobody caught for 20 s on L1; on L2 nobody during the grace, never 角色074', () => {
    expect(OPEN_GRACE_S).toBeGreaterThanOrEqual(15);
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const t = campusRoom(seed);
      t.run(20);
      expect(t.caught).toEqual([]);
      // L2: the 值日生 rushes whoever doesn't look at it once the grace is over (its design), so: nobody during the
      // grace, and never 角色074 in those 20 s
      t.loadLevel(1);
      t.skipIntro();
      t.run(OPEN_GRACE_S);
      expect(t.caught).toEqual([]);
      t.run(20 - OPEN_GRACE_S);
      expect(t.caught.filter((c) => c.by === 'warden')).toEqual([]);
      // he never came onto the spawn row meanwhile
      expect(t.clear(t.r.warden.p)).toBeGreaterThan(10);
    }
  }, 300000);

  it("'caught' names the mob: by 'monitor' for the 值日生, by 'warden' for 角色074", () => {
    const t = campusRoom(3);
    t.loadLevel(1);
    t.skipIntro();
    t.room.handle(t.conns[0], { t: 'debug', op: 'safe', s: 600, mob: 1 }, 0);
    t.run(1);
    t.room.handle(t.conns[0], { t: 'debug', op: 'monitor', d: 2 }, 0);
    // everyone looks away from it (a seen 值日生 freezes)
    const pls = t.room.players as unknown as Map<number, { yaw: number }>, yaw = pls.get(1)!.yaw + Math.PI;
    for (const p of pls.values()) p.yaw = yaw;
    for (let i = 0; i < 20 * PER_S && !t.caught.length; i++) t.run(1 / PER_S);
    expect(t.caught[0]?.by).toBe('monitor');

    const w = campusRoom(5);
    w.run(1);
    w.room.handle(w.conns[0], { t: 'debug', op: 'warden', d: 3 }, 0);
    for (let i = 0; i < 20 * PER_S && !w.caught.length; i++) w.run(1 / PER_S);
    expect(w.caught[0]?.by).toBe('warden');
  }, 120000);
});
