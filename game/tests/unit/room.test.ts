import { describe, expect, it } from 'vitest';
import type { ServerMsg } from '../../shared/protocol.ts';
import { RoomManager, type Conn } from '../../server/room.ts';
import { mulberry32 } from '../../shared/rng.ts';

function fakeConn(id: number) {
  const got: ServerMsg[] = [];
  const c: Conn = { id, name: `p${id}`, send: (m) => got.push(m), sendRaw: (s) => got.push(JSON.parse(s)) };
  return { c, got };
}

describe('room', () => {
  it('creates unique codes, migrates host, rejects teleports', () => {
    const rm = new RoomManager(mulberry32(1));
    const room = rm.create();
    expect(room.code).toMatch(/^[A-Z2-9]{4}$/);
    expect(rm.create().code).not.toBe(room.code);
    const a = fakeConn(1), b = fakeConn(2);
    room.add(a.c, 0);
    room.add(b.c, 0);
    expect(room.host).toBe(1);

    const pa = room.players.get(1)!;
    const start = [...pa.p];
    room.handle(a.c, { t: 'input', seq: 1, p: [start[0] + 30, 0, start[2]], yaw: 0, pitch: 0, f: 0 }, 50);
    expect(a.got.at(-1)).toEqual({ t: 'correct', p: start, c: 1, ack: 1 }); // a rejected prediction is not `forced`: it counts as a client correction
    room.handle(a.c, { t: 'input', seq: 2, p: [start[0] + 0.1, 0, start[2]], yaw: 1, pitch: 0, f: 0 }, 100);
    expect(pa.p[0]).toBeCloseTo(start[0] + 0.1);

    room.step();
    const snap = b.got.at(-1);
    expect(snap?.t === 'snap' && snap.players.length).toBe(2);

    room.remove(a.c, 200);
    expect(room.host).toBe(2);
  });
});
