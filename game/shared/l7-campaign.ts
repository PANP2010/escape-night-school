/** L7 state and interactions use the campaign's ordinary room and WebSocket. */
import type { MirrorKeySnap } from './l7-key.ts';
import { MIRROR_DOORS } from './levels/l7.ts';
import type { Vec3 } from './protocol.ts';

export interface MirrorActorSnap {
  /** The player whose delayed reflection this is. */
  id: number;
  mirrorId: number;
  phase: 'follow' | 'still' | 'chase';
  /** Delayed real-space pose; reflect across mirrorId until the figure emerges. */
  p: Vec3;
  yaw: number;
  pitch: number;
  stillFor: number;
  chaseLeft: number;
}

export interface CampaignMirrorSnap {
  t: 'l7';
  tick: number;
  mirrors: MirrorActorSnap[];
  /** Secret walls the team has discovered through a visible mirror this round. */
  revealedDoors: number[];
  openDoors: number[];
  key: MirrorKeySnap;
}

export type CampaignMirrorClientMsg =
  | { t: 'act'; kind: 'mirror-push'; id: number }
  | { t: 'act'; kind: 'mirror-key'; id: 0 };

/** Puzzle progress stays separate from the ordinary item bag and other chapters. */
export interface MirrorProgress { keyTaken: boolean; openDoors: readonly number[] }

export function parseCampaignMirrorAct(o: Record<string, unknown>): CampaignMirrorClientMsg | null {
  if (o.t !== 'act') return null;
  if (o.kind === 'mirror-key') return o.id === 0 ? { t: 'act', kind: 'mirror-key', id: 0 } : null;
  if (o.kind === 'mirror-push' && typeof o.id === 'number' && MIRROR_DOORS.some(d => d.id === o.id))
    return { t: 'act', kind: 'mirror-push', id: o.id };
  return null;
}
