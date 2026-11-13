import { INTRO_S, type IntroEvent } from '../shared/intro.ts';
import type { Vec3 } from '../shared/protocol.ts';

/** One fixed deadline. Late observers receive this session but never extend its voting roster. */
export class IntroSession {
  readonly id: number;
  readonly level: number;
  readonly startedAt: number;
  readonly endsAt: number;
  readonly participants: Set<number>;
  readonly skipped = new Set<number>();
  readonly route: Vec3[];
  readonly silhouette?: Vec3;
  ended = false;

  constructor(id: number, level: number, now: number, participants: number[], route: Vec3[], silhouette?: Vec3) {
    this.id = id;
    this.level = level;
    this.startedAt = now;
    this.endsAt = now + INTRO_S * 1000;
    this.participants = new Set(participants);
    this.route = route;
    this.silhouette = silhouette;
    this.finishIfReady();
  }

  /** Returns whether the session changed, so repeated or old skip messages produce no traffic. */
  skip(player: number, id: number, now: number): boolean {
    if (id !== this.id || this.ended || !this.participants.has(player)) return false;
    if (this.expire(now)) return true;
    if (this.skipped.has(player)) return false;
    this.skipped.add(player);
    this.finishIfReady();
    return true;
  }

  leave(player: number): boolean {
    if (this.ended || !this.participants.delete(player)) return false;
    this.finishIfReady();
    return true;
  }

  expire(now: number): boolean {
    if (this.ended || now < this.endsAt) return false;
    this.ended = true;
    return true;
  }

  private finishIfReady() {
    if ([...this.participants].every(id => this.skipped.has(id))) this.ended = true;
  }

  event(now: number): IntroEvent {
    return {
      t: 'event', kind: 'intro', id: this.id, level: this.level,
      startedAt: this.startedAt, endsAt: this.endsAt, now,
      skipped: [...this.skipped], ended: this.ended, route: this.route,
      ...(this.silhouette ? { silhouette: this.silhouette } : {}),
    };
  }
}
