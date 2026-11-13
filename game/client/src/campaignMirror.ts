import { lineOfSight } from '../../shared/campus/nav.ts';
import type { CollisionWorld } from '../../shared/campus/collision.ts';
import { canTakeMirrorKey, type KeyViewer } from '../../shared/l7-key.ts';
import type { CampaignMirrorSnap } from '../../shared/l7-campaign.ts';
import { MIRRORS, MIRROR_DOORS } from '../../shared/levels/l7.ts';
import type { Cand } from '../../shared/interact.ts';
import type { Goal } from './guide.ts';

/** Shared key authority is also the client prompt gate: watching the real guard freezes its turn. */
export function mirrorKeyReady(viewer: KeyViewer, state: CampaignMirrorSnap, world: CollisionWorld): boolean {
  return canTakeMirrorKey(viewer, state.key, (a, b) => lineOfSight(world,
    { x: a[0], y: a[1], z: a[2] }, { x: b[0], y: b[1], z: b[2] }));
}

/** The interaction box sits on the glass; the reflected key remains the actual touch selection. */
export function mirrorKeyCandidate(): Cand {
  const m = MIRRORS[0], [x, y, z] = m.center;
  return { kind: 'mirror-key', id: 0, min: [x + .01, y - m.height / 2, z - m.width / 2], max: [x + .09, y + m.height / 2, z + m.width / 2] };
}

export function mirrorWallCandidates(state: CampaignMirrorSnap): Cand[] {
  return MIRROR_DOORS.filter(d => state.revealedDoors.includes(d.id) && !state.openDoors.includes(d.id)
    && (d.id !== 2 || state.key.taken)).map(d => ({ kind: 'mirror-push', id: d.id,
    min: [d.wall[0] - .85, d.wall[1], d.wall[2] - d.width / 2],
    max: [d.wall[0] + .17, d.wall[1] + d.height, d.wall[2] + d.width / 2] }));
}

/** Visit each mirror before its matching wall; the final goal uses the campaign's ordinary exit path. */
export function mirrorGuideGoal(state: CampaignMirrorSnap | undefined): Goal {
  // The first wall can be opened before taking the key. Its pouch still belongs to the first-floor mirror.
  const id = !state?.key.taken || !state.openDoors.includes(1) ? 1 : 2;
  if (!state?.key.taken || !state.revealedDoors.includes(id)) {
    const m = MIRRORS[id - 1];
    return { x: m.center[0] + 1.5, y: MIRROR_DOORS[id - 1].wall[1], z: m.center[2], exact: true };
  }
  const d = MIRROR_DOORS[id - 1];
  return { x: d.wall[0] - .8, y: d.wall[1], z: d.wall[2], exact: true };
}
