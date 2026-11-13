import { describe, expect, it } from 'vitest';
import { campusNavCached } from '../../client/src/campus/world/navcache.ts';
import { Room } from '../../server/room.ts';
import { inBounds } from '../../shared/level.ts';
import { MONITOR_SPAWN_CLEAR_M } from '../../shared/difficulty.ts';
import type { MonitorAI } from '../../server/ai/monitor.ts';
import { roomIntroReady } from './room-intro-fixture.ts';

const graph = campusNavCached('.cache/campus-nav.json').graph;

describe('L1 encounters on the real campus nav', () => {
  it.each([1, 4, 7])('seed %i: activation, safe reachable starts and a same-seed retry for 1–4 players', seed => {
    for (const count of [1, 2, 3, 4]) {
      const room = new Room('CAMP', seed, graph); room.started = false;
      for (let id = 1; id <= count; id++) room.add({ id, name: `p${id}`, send: () => {}, sendRaw: () => {} }, 0);
      const players = [...room.players.values()], host = players[0];
      const ready = roomIntroReady(players.map(p => p.conn));
      room.handle(host.conn, { t: 'start' }, 0);
      ready(room);
      const originalItems = structuredClone(room.items), internals = room as unknown as { monitors: MonitorAI[]; areaNav(): typeof graph; loadLevel(i: number): void };
      expect(internals.monitors).toHaveLength(0);
      const key = room.items.find(i => i.kind === 'drawer_key' && !i.decoy)!;
      host.p = [key.p[0] + .8, 0, key.p[2]];
      expect(room.act(host, 'pick', key.id)).toBe(true);
      const check = () => {
        const nav = internals.areaNav(), sp = room.level.spawns[0], reach = new Set(nav.reachable(nav.nearest(sp.x, sp.y ?? 0, sp.z)));
        for (const monitor of internals.monitors) {
          const [x, y, z] = monitor.p;
          expect(inBounds(room.level, x, y, z)).toBe(true);
          expect(reach.has(nav.nearest(x, y, z))).toBe(true);
          for (const p of [...room.level.spawns, ...players.map(p => ({ x: p.p[0], z: p.p[2] }))]) expect(Math.hypot(x - p.x, z - p.z)).toBeGreaterThanOrEqual(MONITOR_SPAWN_CLEAR_M);
        }
      };
      check(); // Immediate spawns are optional when the looting player covers a safe candidate.
      // Regrouping creates a real safe place in the closed campus region; deferred slots must then appear.
      for (const [i, p] of players.entries()) { const sp = room.level.spawns[i]; p.p = [sp.x, sp.y ?? 0, sp.z]; }
      for (let i = 0; i < 12; i++) room.step();
      expect(internals.monitors).toHaveLength(count === 1 ? 1 : 2); check();
      internals.loadLevel(0);
      expect(room.level.seed).toBe(seed); expect(room.items).toEqual(originalItems);
      expect(room.bag).toEqual({}); expect(internals.monitors).toHaveLength(0);
    }
  });
});
