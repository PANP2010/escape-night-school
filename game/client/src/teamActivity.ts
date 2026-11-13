import { EXTRAP_MAX_SPEED, TICK_MS } from '../../shared/constants.ts';
import { F_CROUCH, F_HIDE, ST_DOWN, ST_OK, ST_SPECTATE, type PlayerSnap, type TeamActivityEvent, type Vec3 } from '../../shared/protocol.ts';

/** Recent successes are brief; pose and movement come from authoritative snapshots, never from being alive. */
export const TEAM_ACTIVITY_MS = 5000;
const MOVING_MS = 650;
const ITEM_NAMES = { door_key: '钥匙', stair_key: '楼梯钥匙', drawer_key: '抽屉钥匙', battery: '电池', fuse: '保险丝' } as const;
interface Peer { p: Vec3; f: number; st: number; tick: number; movedAt: number; relocated?: boolean }

export class TeamActivity {
  private peers = new Map<number, Peer>();
  private recent = new Map<number, { text: string; at: number }>();

  clear() { this.peers.clear(); this.recent.clear(); }

  record(event: TeamActivityEvent, now: number) {
    const text = event.kind === 'pick' ? `刚拾取${ITEM_NAMES[event.item] ?? '物品'}`
      : event.kind === 'open' ? '刚开门' : event.kind === 'close' ? '刚关门' : '刚扶起队友';
    this.recent.set(event.from, { text, at: now });
  }

  /** A warp / forced correction changes position without proving that the player walked. */
  relocate(id: number) {
    const peer = this.peers.get(id);
    if (peer) { peer.movedAt = -Infinity; peer.relocated = true; }
  }

  observe(players: readonly PlayerSnap[], tick: number, now: number) {
    const seen = new Set<number>();
    for (const p of players) {
      seen.add(p.id);
      const before = this.peers.get(p.id);
      const f = p.f ?? before?.f ?? 0, st = p.st ?? ST_OK;
      let movedAt = before?.movedAt ?? -Infinity;
      if (before) {
        const distance = Math.hypot(p.p[0] - before.p[0], p.p[2] - before.p[2]);
        const elapsed = (tick - before.tick) * TICK_MS / 1000;
        // Hiding moves players to / from a fixed spot; a state transition also ends the previous walk.
        // Large jumps / a level seam are not activity. A flag alone also never proves movement.
        if (before.relocated || before.st !== st || ((before.f ^ f) & F_HIDE) || elapsed <= 0 || distance > EXTRAP_MAX_SPEED * elapsed + 0.1 || Math.abs(p.p[1] - before.p[1]) > 1.5) movedAt = -Infinity;
        else if (distance > 0.015 && st === ST_OK && !(f & F_HIDE)) movedAt = now;
      }
      this.peers.set(p.id, { p: [...p.p], f, st, tick, movedAt });
    }
    for (const id of this.peers.keys()) if (!seen.has(id)) { this.peers.delete(id); this.recent.delete(id); }
  }

  hidden(id: number) { return !!((this.peers.get(id)?.f ?? 0) & F_HIDE); }

  status(id: number, now: number): string {
    const peer = this.peers.get(id);
    if (peer?.st === ST_DOWN) return '倒地待救';
    if (peer?.st === ST_SPECTATE) return '已出局';
    if (this.hidden(id)) return '躲藏中';
    const recent = this.recent.get(id);
    if (recent && now - recent.at >= 0 && now - recent.at < TEAM_ACTIVITY_MS) return recent.text;
    if (recent) this.recent.delete(id);
    if (peer && now - peer.movedAt >= 0 && now - peer.movedAt < MOVING_MS) return peer.f & F_CROUCH ? '蹲行中' : '移动中';
    return peer && (peer.f & F_CROUCH) ? '蹲伏中' : '暂未行动';
  }
}
