import { describe, expect, it } from 'vitest';
import { Room, type Conn } from '../../server/room.ts';
import { NavGraph } from '../../shared/campus/nav.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { ST_OK, ST_SPECTATE, type ServerMsg } from '../../shared/protocol.ts';
import { monitorDisplayName } from '../../shared/studentNames.ts';

describe('L5 real room monitor movement', () => {
  it('keeps 值周代号025 on his casting stand while the ordinary monitor descends and catches a court target', () => {
    // The supplied campus graph enables the real room AI; L5 builds its own gym graph.
    const campus = new NavGraph();
    campus.chain([{ x: -40, y: 0, z: 73 }, { x: -60, y: 0, z: 73 }]);
    // Seed 21 genuinely draws 值周代号025 in the first slot; ordinary seeds no longer force a boss.
    expect(monitorDisplayName(21, 4, 2)).toBe('值周代号025');
    const room = new Room('STAND', 21, campus, 0, 'standard', { namedMonitors: true }), messages: ServerMsg[] = [];
    const conn: Conn = { id: 1, name: 'court target', send: (m) => messages.push(m), sendRaw: (s) => messages.push(JSON.parse(s)) };
    room.add(conn, 0);
    room.handle(conn, { t: 'debug', op: 'level5' }, 0);
    // Isolate the monitor behavior while preserving the room's real sight and movement checks.
    room.handle(conn, { t: 'debug', op: 'safe', s: 60, mob: 1 }, 0);
    const player = room.players.get(1)!;
    player.p = [-100, 0, 62]; player.yaw = 0; player.pitch = 0; player.f = 0;
    const latest = () => messages.filter((m) => m.t === 'snap').at(-1)!;
    room.step();
    const initial = latest().mobs.filter((m) => m.id === 2 || m.id === 3);
    expect(initial).toHaveLength(2);
    for (const monitor of initial) expect(monitor.p[1]).toBeCloseTo(0.72);
    while (room.tick < 16 * 1000 / TICK_MS) room.step();
    expect(latest().boss).toMatchObject({ name: '值周代号025', origin: [-106, 0.72, 73.65] });
    const chasing = latest().mobs.filter((m) => m.id === 3);
    expect(chasing).toHaveLength(1);
    for (const monitor of chasing) {
      expect(monitor.p[2]).toBeLessThan(70.5);
      expect(monitor.p[1]).toBeLessThan(0.4);
    }
    expect(player.st).toBe(ST_OK);
    const contact = [...player.p];
    while (room.tick < 19 * 1000 / TICK_MS && player.st === ST_OK) room.step();
    // This is a solo chase: the genuine catch has no possible rescuer and ends the attempt immediately.
    expect(player.st).toBe(ST_SPECTATE);
    expect(player.heldUntil).toBeUndefined();
    expect(player.p).toEqual(contact);
    expect(messages.filter((m) => m.t === 'caught')).toEqual([
      expect.objectContaining({ t: 'caught', id: 1, by: 'monitor', at: contact }),
    ]);
    expect(messages.filter((m) => m.t === 'fade')).toEqual([{ t: 'fade', secs: 3, restart: true }]);
  });
});
