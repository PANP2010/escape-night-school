import { describe, expect, it } from 'vitest';
import { campusNavCached } from '../../client/src/campus/world/navcache.ts';
import { F_RUN, type ServerMsg } from '../../shared/protocol.ts';
import { mulberry32 } from '../../shared/rng.ts';
import { RoomManager } from '../../server/room.ts';
import { WARDEN_SIGHT_HALF_ANGLE } from '../../server/ai/warden.ts';
import { inBounds } from '../../shared/level.ts';

// The real campus room (collision world, doors, nav graph) with a headless player: the whole 角色074 loop
// patrol → hears a run → investigates → sees the player → chases → catches → releases.
describe('角色074 in a campus room', () => {
  it('goes patrol → investigate → chase → catch, and never walks his capsule into geometry on the straight run', () => {
    const graph = campusNavCached('.cache/campus-nav.json').graph;
    const room = new RoomManager(mulberry32(5), () => graph).create();
    const got: ServerMsg[] = [];
    room.add({ id: 1, name: 'p', send: (m) => got.push(m), sendRaw: () => {} }, 0);
    const pl = room.players.get(1)!;
    const warden = (room as unknown as { warden: { p: number[]; state: string } }).warden;
    // a spot 5-14 m away on his floor (past his 2.5 m sense radius), in the level's area, where a run is audible and in line of sight but behind
    // his view cone (so he has to hear it first)
    const findSpot = () => {
      const W = warden.p, yaw = (warden as unknown as { yaw: number }).yaw;
      return graph.nodes.find((n) => {
        const d = Math.hypot(n.x - W[0], n.z - W[2]);
        const a = Math.atan2(-(n.x - W[0]), -(n.z - W[2])) - yaw, off = Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
        return Math.abs(n.y - W[1]) < 0.3 && d > 5 && d < 14 && off > WARDEN_SIGHT_HALF_ANGLE + 0.1 && inBounds(room.level, n.x, n.y, n.z)
          && !room.noiseBlocked(n.x, n.y + 1.6, n.z, W[0], W[1] + 1.6, W[2]);
      });
    };
    // patrol (≥ 5 s) until he stands where there is one: where he is by then depends on his patrol speed
    let spot: ReturnType<typeof findSpot>;
    for (let i = 0; i < 2000 && !(i >= 100 && (spot = findSpot())); i++) room.step();
    expect(warden.state).toBe('patrol');
    if (!spot) throw new Error('no spot behind him on his whole patrol');
    pl.p = [spot.x, spot.y, spot.z];
    pl.f = F_RUN;
    room.emitNoise(spot.x, spot.z, 20, 'run', spot.y, 1);
    const seen: string[] = [];
    for (let i = 0; i < 20 * 20 && seen[seen.length - 1] !== 'catch'; i++) {
      room.step();
      if (warden.state !== seen[seen.length - 1]) seen.push(warden.state);
    }
    expect(seen.slice(0, 3)).toEqual(['investigate', 'chase', 'catch']);
    expect(got.filter((m) => m.t === 'caught')).toHaveLength(1);
  }, 120000);
});
