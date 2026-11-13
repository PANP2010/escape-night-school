import { CROUCH_EYE_H, EYE_H } from './constants.ts';
import { F_CROUCH, F_HIDE, type Vec3 } from './protocol.ts';

/** Snapshot variants share one skeleton; level indexes are zero based. */
export type WardenForm = 'normal' | 'changed' | 'night' | 'rollcall' | 'finale';

export const WARDEN_STARE_S = 2;
export const WARDEN_STARE_HALF_ANGLE = 18 * Math.PI / 180;
export const WARDEN_STARE_RANGE = 20;
/** Head / upper chest for the baseline 1.75 m model; update the head sample with a model-height migration. */
export const WARDEN_GAZE_HEIGHTS = [1.65, 1.3] as const;
export const WARDEN_NIGHT_HEARING_MULTIPLIER = 1.5;
/** Only ordinary patrol movement slows at night; sensing, pursuit and catch timers keep real time. */
export const WARDEN_NIGHT_PATROL_MULTIPLIER = .75;

export function wardenBaseForm(levelIndex: number): WardenForm {
  if (levelIndex === 7) return 'finale';
  if (levelIndex === 3) return 'rollcall';
  return levelIndex === 1 ? 'night' : 'normal';
}

export function wardenForm(levelIndex: number, changed: boolean): WardenForm {
  const base = wardenBaseForm(levelIndex);
  return changed && base !== 'rollcall' && base !== 'finale' ? 'changed' : base;
}

interface GazeViewer { p: Vec3; yaw: number; pitch?: number; f: number }
type Point = { x: number; y: number; z: number };

/** A deliberate look at his head / upper chest, within the camera's vertical FOV too. */
export function wardenGazeOn(viewer: GazeViewer, at: Vec3, los: (a: Point, b: Point) => boolean): boolean {
  if (viewer.f & F_HIDE) return false;
  const eye = { x: viewer.p[0], y: viewer.p[1] + (viewer.f & F_CROUCH ? CROUCH_EYE_H : EYE_H), z: viewer.p[2] };
  const pitch = viewer.pitch ?? 0, cp = Math.cos(pitch);
  const forward = [-Math.sin(viewer.yaw) * cp, Math.sin(pitch), -Math.cos(viewer.yaw) * cp];
  for (const height of WARDEN_GAZE_HEIGHTS) {
    const point = { x: at[0], y: at[1] + height, z: at[2] };
    const dx = point.x - eye.x, dy = point.y - eye.y, dz = point.z - eye.z, d = Math.hypot(dx, dy, dz);
    if (d > WARDEN_STARE_RANGE) continue;
    if (d > 1e-6 && (dx * forward[0] + dy * forward[1] + dz * forward[2]) / d < Math.cos(WARDEN_STARE_HALF_ANGLE)) continue;
    if (los(eye, point)) return true;
  }
  return false;
}

/** Every viewer must hold their own uninterrupted gaze. Several short looks never add up. */
export class WardenStare {
  changed = false;
  private seconds = new Map<number, number>();

  step(dt: number, watching: readonly number[]): number | undefined {
    if (this.changed) return;
    const active = new Set(watching);
    for (const id of this.seconds.keys()) if (!active.has(id)) this.seconds.delete(id);
    for (const id of active) {
      const elapsed = (this.seconds.get(id) ?? 0) + Math.max(0, dt);
      this.seconds.set(id, elapsed);
      if (elapsed + 1e-9 >= WARDEN_STARE_S) {
        this.changed = true;
        this.seconds.clear();
        return id;
      }
    }
  }

  forget(id: number): void { this.seconds.delete(id); }
  reset(): void { this.changed = false; this.seconds.clear(); }
}
