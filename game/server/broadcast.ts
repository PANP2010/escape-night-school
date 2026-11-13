import { mulberry32 } from '../shared/rng.ts';
import type { BroadcastSnap } from '../shared/broadcast.ts';
import type { LevelDef } from '../shared/levels/def.ts';
import { boxAt, inReach } from '../shared/interact.ts';
import { ST_OK, type Vec3 } from '../shared/protocol.ts';

type Def = NonNullable<LevelDef['broadcast']>;
export interface BroadcastPlayer { id: number; p: Vec3; st: number; hidden: boolean }

/** The room is the sole clock and authority. `now` is level elapsed seconds, never wall time or client input. */
export class MidnightBroadcast {
  readonly digits: string[];
  readonly clues: (string | null)[] = [null, null, null, null];
  off = false;
  nextAt: number;
  call: { id: number; until: number } | null = null;
  private rng: () => number;
  private attempts = new Map<number, number>();
  readonly def: Def;
  constructor(def: Def, seed: number) {
    this.def = def;
    const codeRng = mulberry32(seed ^ 0x4c34434f);
    this.digits = Array.from({ length: 4 }, () => String(Math.floor(codeRng() * 10)));
    this.rng = mulberry32(seed ^ 0x4c344341);
    this.nextAt = this.interval();
  }
  private interval() { return this.def.interval[0] + this.rng() * (this.def.interval[1] - this.def.interval[0]); }
  private near(p: BroadcastPlayer, at: { x: number; y: number; z: number }) {
    const b = boxAt([at.x, at.y, at.z], 0.35, 1.8);
    return p.st === ST_OK && !p.hidden && inReach(p.p, b.min, b.max);
  }
  read(p: BroadcastPlayer, id: number): boolean {
    const s = this.def.stickers[id];
    if (!s || !this.near(p, s)) return false;
    this.clues[id] = this.digits[id];
    return true;
  }
  submit(p: BroadcastPlayer, code: string, now: number): 'off' | 'wrong' | 'missing' | 'refused' {
    if (this.off || !this.near(p, this.def.console) || now < (this.attempts.get(p.id) ?? -Infinity)) return 'refused';
    this.attempts.set(p.id, now + 1);
    if (this.clues.some(c => c === null)) return 'missing';
    if (!/^\d{4}$/.test(code) || code !== this.digits.join('')) return 'wrong';
    this.off = true; this.call = null;
    return 'off';
  }
  /** An active call tracks the target's latest location; authoritative hiding immediately suppresses it. */
  step(now: number, players: readonly BroadcastPlayer[]): void {
    if (this.off) return;
    if (this.call && (now >= this.call.until || !players.some(p => p.id === this.call!.id && p.st === ST_OK))) this.call = null;
    if (now < this.nextAt) return;
    this.nextAt = now + this.interval();
    const live = players.filter(p => p.st === ST_OK);
    if (live.length) this.call = { id: live[Math.floor(this.rng() * live.length)].id, until: now + this.def.reveal };
  }
  snapshot(now: number, players: readonly BroadcastPlayer[]): BroadcastSnap {
    const p = this.call && now < this.call.until ? players.find(p => p.id === this.call!.id && p.st === ST_OK) : undefined;
    return { t: 'broadcast', off: this.off, clues: [...this.clues], nextIn: this.off ? 0 : Math.max(0, Math.ceil(this.nextAt - now)),
      call: p ? { id: p.id, left: Math.max(0, Math.ceil(this.call!.until - now)), shielded: p.hidden, ...(!p.hidden && { p: [...p.p] as Vec3 }) } : null };
  }
}
