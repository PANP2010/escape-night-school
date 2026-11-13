import { randomBytes } from 'node:crypto';
import type { Conn } from './room.ts';

/** A dead socket keeps its player reserved (and keeps answering `resumePending` to the reconnecting phone) until it is
 *  reaped, so this must stay comfortably below the client's own recovery window. 2.5 s pings × 4 missed ≈ 10 s even
 *  with a phone radio's tail time. */
export const RESUME_MS = 15_000;
export const HEARTBEAT_MS = 2_500;
export const HEARTBEAT_TIMEOUT_MS = 10_000;
/** A campus / carrier NAT puts dozens of players behind one public address: at 4 per IP every player past the fourth
 *  was terminated on connect (and the client's 250 ms retry turned that into a storm). Per-connection abuse stays
 *  bounded by MessageGuard, and admission is only one of the room-size / payload limits. */
export const MAX_IP_CONNECTIONS = 256;
/** 20 inputs/s + a revive refresh is ~30 packets/s of legitimate traffic (revive used to sit exactly on the old
 *  cap of 30, so every revive hold dropped packets and could end in a kick). Abuse is still bounded, and one
 *  client cannot flood a room's broadcast loop. */
export const MESSAGES_PER_SECOND = 60;
export const MAX_BAD_MESSAGES = 8;
/** Brief bursts are dropped; repeated floods cannot reconnect with the revoked session. */
export const MAX_RATE_DROPS = 60;

interface Session { token: string; conn: Conn; until?: number }
type HelloResult = { token: string; resumed?: false; resumeFailed?: boolean }
  | { token: string; resumed: true; previous: Conn }
  | { resumePending: true };

/** Session secrets never encode a player id or room code, and are rotated before a reserved player is restored. */
export class ResumeSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly connections = new Map<Conn, Session>();

  hello(conn: Conn, resume: string | undefined, now: number): HelloResult {
    this.expire(now);
    const own = this.connections.get(conn);
    if (resume !== undefined) {
      const old = this.sessions.get(resume);
      if (old && old.conn !== conn && old.until === undefined) return { resumePending: true };
      if (old && old.conn === conn) return { token: old.token };
      if (old && old.until !== undefined && old.until > now && old.conn.room && !conn.room) {
        if (own) this.erase(own);
        const previous = old.conn;
        this.erase(old);
        conn.id = previous.id;
        conn.name = previous.name;
        const session = this.issue(conn);
        return { token: session.token, resumed: true, previous };
      }
    }
    return { token: (own ?? this.issue(conn)).token, ...(resume !== undefined ? { resumeFailed: true } : {}) };
  }

  disconnect(conn: Conn, now: number) {
    const s = this.connections.get(conn);
    if (s && conn.room) {
      conn.room.disconnect(conn);
      s.until = now + RESUME_MS;
    } else {
      if (s) this.erase(s);
      conn.room?.remove(conn, now);
    }
  }

  /** An explicit kick invalidates the secret and frees the slot immediately. */
  revoke(conn: Conn, now: number) {
    const s = this.connections.get(conn);
    if (s) this.erase(s);
    conn.room?.remove(conn, now);
  }

  expire(now: number) {
    for (const s of this.sessions.values()) if (s.until !== undefined && now >= s.until) {
      this.erase(s);
      s.conn.room?.remove(s.conn, now);
    }
  }

  private issue(conn: Conn): Session {
    const s = { token: randomBytes(32).toString('base64url'), conn };
    this.sessions.set(s.token, s);
    this.connections.set(conn, s);
    return s;
  }

  private erase(s: Session) {
    this.sessions.delete(s.token);
    if (this.connections.get(s.conn) === s) this.connections.delete(s.conn);
  }
}

/** Admission is keyed only by the actual peer address; forwarding headers are untrusted. */
export class IpConnections {
  private readonly counts = new Map<string, number>();
  acquire(address: string): boolean {
    const n = this.counts.get(address) ?? 0;
    if (n >= MAX_IP_CONNECTIONS) return false;
    this.counts.set(address, n + 1);
    return true;
  }
  release(address: string) {
    const n = this.counts.get(address) ?? 0;
    if (n <= 1) this.counts.delete(address);
    else this.counts.set(address, n - 1);
  }
}

/** A bounded queue in a rolling second avoids allowing two adjacent fixed-window bursts through. */
export class MessageGuard {
  private times: number[] = [];
  private bad = 0;
  private dropped = 0;
  private dropAt = 0;
  allow(now: number): boolean {
    while (this.times.length && this.times[0] <= now - 1000) this.times.shift();
    if (this.times.length >= MESSAGES_PER_SECOND) {
      if (now - this.dropAt >= 10_000) this.dropped = 0;
      this.dropAt = now;
      this.dropped++;
      return false;
    }
    this.times.push(now);
    return true;
  }
  invalid() { this.bad++; }
  get kicked() { return this.bad >= MAX_BAD_MESSAGES || this.dropped >= MAX_RATE_DROPS; }
}
