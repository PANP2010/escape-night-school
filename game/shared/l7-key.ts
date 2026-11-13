import { EYE_H } from './constants.ts';
import { MIRRORS, mirrorForPlayer, mirrorPoint } from './levels/l7.ts';
import { ST_OK, type Vec3 } from './protocol.ts';

/** The first-floor duty student's back pouch is visible in the darkroom mirror. */
export const L7_KEY_GUARD: Vec3 = [-79.35, 0, 144.05];
export const L7_KEY_TURN_S = 7;
export interface MirrorKeySnap {
  taken: boolean;
  guard: { p: Vec3; yaw: number; watched: boolean };
  open: boolean;
}
export interface KeyViewer { p: Vec3; yaw: number; pitch: number; st: number }
export type KeyLOS = (a: Vec3, b: Vec3) => boolean;
const eye = (p: Vec3): Vec3 => [p[0], p[1] + EYE_H, p[2]];
const looks = (p: Vec3, yaw: number, pitch: number, q: Vec3, dot: number) => {
  const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2], d = Math.hypot(dx, dy, dz);
  return d > .01 && (-Math.sin(yaw) * Math.cos(pitch) * dx + Math.sin(pitch) * dy - Math.cos(yaw) * Math.cos(pitch) * dz) / d >= dot;
};
export const mirrorKeyPoint = (s: MirrorKeySnap): Vec3 => [s.guard.p[0] + Math.sin(s.guard.yaw) * .3, s.guard.p[1] + 1.03, s.guard.p[2] + Math.cos(s.guard.yaw) * .3];
/** Direct sight freezes the guard; looking at its reflection leaves its inspection turn running. */
export function watchesKeyGuard(p: KeyViewer, los: KeyLOS): boolean {
  const target: Vec3 = [L7_KEY_GUARD[0], L7_KEY_GUARD[1] + 1.3, L7_KEY_GUARD[2]];
  return p.st === ST_OK && looks(eye(p.p), p.yaw, p.pitch, target, Math.cos(Math.PI / 3)) && los(eye(p.p), target);
}
export function mirrorKeyOpen(yaw: number): boolean {
  // The mirror lies west: the back pouch clears the coat only while the student faces east.
  return -Math.sin(yaw) > .78;
}
/** Same target used by the HUD/raycast and authority; the room also supplies real wall LOS. */
export function canTakeMirrorKey(p: KeyViewer, s: MirrorKeySnap, los: KeyLOS = () => true): boolean {
  const mirror = MIRRORS[0], key = mirrorKeyPoint(s), e = eye(p.p);
  if (s.taken || !s.open || !mirrorKeyOpen(s.guard.yaw) || p.st !== ST_OK || Math.abs(p.p[1] - s.guard.p[1]) > .3 ||
      Math.hypot(p.p[0] - mirror.center[0], p.p[2] - mirror.center[2]) > 2.15 ||
      Math.hypot(p.p[0] - key[0], p.p[2] - key[2]) > 2.6 || mirrorForPlayer(p.p, p.yaw, p.pitch)?.id !== mirror.id) return false;
  const reflected = mirrorPoint(mirror, key);
  if (!looks(e, p.yaw, p.pitch, reflected, Math.cos(Math.PI / 6))) return false;
  const t = (mirror.center[0] - e[0]) / (reflected[0] - e[0]);
  if (!(t > 0 && t < 1)) return false;
  const glass: Vec3 = [mirror.center[0] + .035, e[1] + (reflected[1] - e[1]) * t, e[2] + (reflected[2] - e[2]) * t];
  return Math.abs(glass[2] - mirror.center[2]) < mirror.width / 2 - .04 && Math.abs(glass[1] - mirror.center[1]) < mirror.height / 2 - .04 && los(e, glass) && los(key, glass);
}
