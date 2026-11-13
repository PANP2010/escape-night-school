import { L7_KEY_GUARD, L7_KEY_TURN_S, canTakeMirrorKey, mirrorKeyOpen, watchesKeyGuard, type KeyLOS, type KeyViewer, type MirrorKeySnap } from '../shared/l7-key.ts';

/** One shared key. The turn clock is independent of each player's delayed reflection. */
export class MirrorKey {
  private time = 0;
  taken = false;
  watched = false;
  get yaw() { return Math.PI / 2 + this.time * Math.PI * 2 / L7_KEY_TURN_S; }
  snapshot(): MirrorKeySnap {
    return { taken: this.taken, guard: { p: [...L7_KEY_GUARD], yaw: this.yaw, watched: this.watched }, open: !this.taken && mirrorKeyOpen(this.yaw) };
  }
  step(dt: number, players: readonly KeyViewer[], los: KeyLOS) {
    this.watched = players.some(p => watchesKeyGuard(p, los));
    if (!this.watched) this.time = (this.time + Math.max(0, dt)) % L7_KEY_TURN_S;
  }
  take(p: KeyViewer, los: KeyLOS): boolean {
    if (!canTakeMirrorKey(p, this.snapshot(), los)) return false;
    this.taken = true;
    return true;
  }
  reset() { this.time = 0; this.taken = false; this.watched = false; }
}
