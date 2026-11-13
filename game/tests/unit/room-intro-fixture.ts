import type { Conn, Room } from '../../server/room.ts';
import { TICK_MS } from '../../shared/constants.ts';
import type { IntroEvent } from '../../shared/intro.ts';
import type { ServerMsg } from '../../shared/protocol.ts';

/** Observe the actual server event; the intro id is independent of the spawn incarnation. */
export function roomIntroReady(conns: readonly Conn[]) {
  let intro: IntroEvent | undefined;
  const observe = (m: ServerMsg) => { if (m.t === 'event' && m.kind === 'intro') intro = m; };
  for (const conn of conns) {
    const send = conn.send.bind(conn), raw = conn.sendRaw.bind(conn);
    conn.send = m => { observe(m); send(m); };
    conn.sendRaw = s => { observe(JSON.parse(s)); raw(s); };
  }
  return (room: Room, now = room.tick * TICK_MS) => {
    if (room.introFrozen) {
      if (!intro || intro.ended) throw new Error('Missing the current authoritative intro event');
      const id = intro.id;
      for (const conn of conns) room.handle(conn, { t: 'intro-skip', id }, now);
      if (room.introFrozen) throw new Error('Not all current intro participants skipped');
    }
    for (const conn of conns) room.handle(conn, { t: 'ready', incarnation: room.incarnation }, now);
  };
}
