/** The mirror puzzle lives inside the campaign Room; movement, membership and survival stay with that room. */
import { EYE_H } from '../shared/constants.ts';
import type { CampaignMirrorSnap } from '../shared/l7-campaign.ts';
import { MIRROR_DOORS, mirrorForPlayer } from '../shared/levels/l7.ts';
import { ST_OK, type Vec3 } from '../shared/protocol.ts';
import { MirrorAI, type MirrorEnv, type MirrorPlayer } from './ai/mirror.ts';
import { MirrorKey } from './l7-key.ts';

export const MIRROR_PUSH_REACH = 1.8;
export interface CampaignMirrorPlayer extends MirrorPlayer { pitch: number; st: number }

export class CampaignMirrors {
  readonly openDoors = new Set<number>();
  /** Looking into a mirror reveals the corresponding secret wall to the whole team. */
  private readonly observedDoors = new Set<number>();
  readonly key = new MirrorKey();
  readonly ai: MirrorAI;
  private readonly env: MirrorEnv & { los: (from: Vec3, to: Vec3) => boolean };

  constructor(env: MirrorEnv & { los: (from: Vec3, to: Vec3) => boolean }) {
    this.env = env;
    this.ai = new MirrorAI(env);
  }

  get progress() { return { keyTaken: this.key.taken, openDoors: [...this.openDoors] }; }

  snapshot(tick: number): CampaignMirrorSnap {
    const r = (n: number) => Math.round(n * 100) / 100;
    return {
      t: 'l7', tick, openDoors: [...this.openDoors], revealedDoors: [...this.observedDoors].sort((a, b) => a - b), key: this.key.snapshot(),
      mirrors: this.ai.snapshots().map(m => ({ ...m, p: m.p.map(r) as Vec3, yaw: r(m.yaw), pitch: r(m.pitch), stillFor: r(m.stillFor), chaseLeft: r(m.chaseLeft) })),
    };
  }

  step(dt: number, players: readonly CampaignMirrorPlayer[]) {
    const up = players.filter(p => p.st === ST_OK);
    for (const p of up) {
      const mirror = mirrorForPlayer(p.p, p.yaw, p.pitch);
      if (mirror && this.env.los([p.p[0], p.p[1] + EYE_H, p.p[2]], mirror.center)) {
        for (const d of MIRROR_DOORS) if (d.mirrorId === mirror.id) this.observedDoors.add(d.id);
      }
    }
    this.key.step(dt, up, this.env.los);
    this.ai.step(dt, up);
  }

  takeKey(p: CampaignMirrorPlayer): boolean { return this.key.take(p, this.env.los); }

  /** Push from the room side, facing the revealed wall, using the live world's visibility. */
  push(p: CampaignMirrorPlayer, id: number): boolean {
    const d = MIRROR_DOORS.find(q => q.id === id);
    if (!d || p.st !== ST_OK || this.openDoors.has(id) || !this.observedDoors.has(id) || (id === 2 && !this.key.taken)) return false;
    const dx = p.p[0] - d.wall[0], dz = p.p[2] - d.wall[2], distance = Math.hypot(dx, dz);
    if (Math.abs(p.p[1] - d.wall[1]) >= 1 || distance > MIRROR_PUSH_REACH) return false;
    const nx = d.normal[0], nz = d.normal[2];
    if (dx * nx + dz * nz < 0.1 || Math.abs(dx * -nz + dz * nx) > d.width / 2 + 0.15) return false;
    if (distance > 0.01 && (Math.sin(p.yaw) * dx + Math.cos(p.yaw) * dz) / distance < 0.75) return false;
    // The 2F cabinet moves with the wall. Its front is the accessible pushing surface.
    const eye: Vec3 = [p.p[0], p.p[1] + EYE_H, p.p[2]];
    const surface: Vec3 = [d.wall[0] + nx * 0.9, d.wall[1] + 1.3, d.wall[2] + nz * 0.9];
    if (!this.env.los(eye, surface)) return false;
    this.openDoors.add(id);
    return true;
  }

  forget(id: number) { this.ai.forget(id); }
}
