import { describe, expect, it } from 'vitest';
import { campusNavCached } from '../../client/src/campus/world/navcache.ts';
import { F_LIGHT, F_RUN, type ServerMsg } from '../../shared/protocol.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { mulberry32 } from '../../shared/rng.ts';
import { RoomManager, type Conn } from '../../server/room.ts';

// Worst-case downlink: 4 players all moving and looking around every tick, 角色074 on the prowl.
describe('downlink bandwidth', () => {
  it('stays ≤ 6.5 KB/s per player with 4 players', () => {
    const graph = campusNavCached('.cache/campus-nav.json').graph;
    const room = new RoomManager(mulberry32(5), () => graph).create(true);
    const bytes = new Map<number, number>();
    let introId = 0;
    const observe = (m: ServerMsg) => { if (m.t === 'event' && m.kind === 'intro') introId = m.id; };
    const mk = (id: number): Conn => ({
      id, name: `p${id}`,
      send: (m) => { observe(m); bytes.set(id, (bytes.get(id) ?? 0) + Buffer.byteLength(JSON.stringify(m))); },
      sendRaw: (s) => { observe(JSON.parse(s)); bytes.set(id, (bytes.get(id) ?? 0) + Buffer.byteLength(s)); },
    });
    for (let id = 1; id <= 4; id++) room.add(mk(id), 0);
    room.handle(room.players.get(1)!.conn, { t: 'start' }, 0);
    expect(introId).toBeGreaterThan(0);
    for (const pl of room.players.values()) room.handle(pl.conn, { t: 'intro-skip', id: introId }, 0);
    expect(room.introFrozen).toBe(false);
    room.step();
    bytes.clear(); // join / level setup is one-off
    const ticks = 400, rnd = mulberry32(9);
    for (let k = 0; k < ticks; k++) {
      for (const pl of room.players.values()) { // bypass input validation: just churn every snapped field
        pl.p = [pl.p[0] + (rnd() - 0.5) * 0.3, pl.p[1], pl.p[2] + (rnd() - 0.5) * 0.3];
        pl.yaw = (rnd() - 0.5) * 6; pl.pitch = (rnd() - 0.5) * 2; pl.f = F_LIGHT | (k % 40 < 20 ? F_RUN : 0);
        pl.lastInput = k * TICK_MS;
      }
      room.step();
    }
    const secs = ticks * TICK_MS / 1000;
    const rates = [...bytes.values()].map((b) => b / secs / 1024);
    console.log(`4-player downlink KB/s per player: ${rates.map((r) => r.toFixed(2)).join(', ')}`);
    expect(rates).toHaveLength(4);
    for (const r of rates) expect(r).toBeLessThanOrEqual(6.5);
  });
});
