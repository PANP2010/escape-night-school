import type { LevelDef } from './levels/def.ts';
import type { Vec3 } from './protocol.ts';

export interface LoopProgress { step: number; loops: number; mistakes: number }
export interface LoopState extends LoopProgress {
  armed: boolean;
  /** A real corridor-to-classroom crossing, not yet far enough inside for the whole capsule to clear the door. */
  entering?: number;
}
export const freshLoop = (): LoopState => ({ step: 0, loops: 0, mistakes: 0, armed: true });
export const loopSolved = (def: LevelDef, p?: LoopProgress): boolean => !!def.loop && (p?.step ?? 0) >= def.loop.sequence.length;

/** Called only for validated movement. Remember the actual aperture crossed, then confirm 39 cm inside it.
 * This also counts diagonal entries whose later, fully-inside position is beside the aperture. Door toggles and
 * threshold jitter cannot count. Leave the classroom fully before another entry can count, via either door. */
export function enterLoopDoor(def: LevelDef, state: LoopState, from: Vec3, to: Vec3, open: readonly boolean[]): LoopState {
  const loop = def.loop;
  if (!loop || loopSolved(def, state)) return state;
  const corridorEdge = Math.max(...loop.doors.map((d) => d.z)) + 0.4;
  if (Math.abs(to[1] - def.exit.y) > 0.5) return state;
  if (to[2] >= corridorEdge) return state.armed && state.entering === undefined ? state : { ...state, armed: true, entering: undefined };
  if (!state.armed) return state;
  const crossed = loop.doors.find((d) => {
    if (!open[d.id] || Math.abs(to[1] - d.y) > 0.5 || Math.abs(from[1] - d.y) > 0.5 || from[2] < d.z || to[2] >= d.z) return false;
    const t = (d.z - from[2]) / (to[2] - from[2]);
    return Math.abs(from[0] + (to[0] - from[0]) * t - d.x) <= d.halfWidth;
  });
  const door = crossed ?? loop.doors.find((d) => d.id === state.entering);
  if (!door) return state;
  if (to[2] >= door.z) return state.entering === undefined ? state : { ...state, entering: undefined };
  if (to[2] > door.z - 0.39) return state.entering === door.id ? state : { ...state, entering: door.id };
  const right = door.label === loop.sequence[state.step];
  return { ...state, armed: false, entering: undefined, step: right ? state.step + 1 : 0, mistakes: state.mistakes + (right ? 0 : 1) };
}

/** Only a westward crossing of the corridor seam loops. Returning from 301's west door, standing behind
 * the seam or walking back east must not act like a respawn. Keep height/lane and earned progress. */
export function loopDestination(def: LevelDef, state: LoopProgress, from: Vec3, p: Vec3): Vec3 | null {
  const loop = def.loop;
  if (!loop || loopSolved(def, state) || Math.abs(p[1] - def.exit.y) > 0.5 || Math.abs(from[1] - def.exit.y) > 0.5
    || from[0] <= loop.endX || p[0] > loop.endX || from[2] < loop.corridorZ || p[2] < loop.corridorZ) return null;
  return [Math.max(p[0] + loop.shiftX, def.spawns[0].x), p[1], p[2]];
}
