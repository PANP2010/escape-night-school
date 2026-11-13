// Crosshair interaction: what the player's view ray hits (client) and whether an act is in reach (server).
import type { Vec3 } from './protocol.ts';

/** Server-checked max distance (m, flat, to the nearest point of the target's box) for an `act` to work. */
export const ACT_REACH = 2;
/** Client ray length (m): a hit's flat distance never exceeds its 3-D distance, so a prompt the player sees is never refused by ACT_REACH. */
export const RAY_LEN = ACT_REACH;
/** Max feet-to-target-base height difference for an act (m): keeps it on one storey. */
export const ACT_DY = 1.5;

/** Half-width and height (m) of a key item's pick box. */
export const KEY_R = 0.35;
export const KEY_H = 1.2;

/** The wall cabinet is centred 1.5 m above its floor, with a 0.9 m tall door/body. */
export const FUSE_BOX_CENTER_H = 1.5;
export const FUSE_BOX_H = 0.9;
export const FUSE_BOX_R = 0.6;

export type ActKind = 'use' | 'pick' | 'revive' | 'hide' | 'unhide' | 'fuse' | 'sticker' | 'keypad' | 'mirror-push' | 'mirror-key' | 'rollcall' | 'gym-switch' | 'exam' | 'clue';

/** An interactable: `id` is a door id (use), key item id (pick) or player id (revive). With `frame`, min/max are in that
 *  thing's own frame (origin `p`, turned by `yaw` about +Y like a three.js rotation.y: x = right, z = back); else world. */
export interface Cand { kind: ActKind; id: number; min: Vec3; max: Vec3; frame?: Frame }
export interface Frame { p: Vec3; yaw: number }

/** World point → `f`'s own frame (undo the translation, then the yaw). */
export function toFrame(f: Frame, w: Vec3): Vec3 {
  const c = Math.cos(f.yaw), s = Math.sin(f.yaw), dx = w[0] - f.p[0], dz = w[2] - f.p[2];
  return [dx * c - dz * s, w[1] - f.p[1], dx * s + dz * c];
}
/** World direction → `f`'s own frame (yaw only). */
export function dirToFrame(f: Frame, d: Vec3): Vec3 {
  const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
  return [d[0] * c - d[2] * s, d[1], d[0] * s + d[2] * c];
}

/** Where an eye at yaw/pitch looks (yaw 0, pitch 0 faces -Z; positive pitch looks up). */
export function lookDir(yaw: number, pitch: number): Vec3 {
  const c = Math.cos(pitch);
  return [-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c];
}

/** Distance along ray o + t·d (t ≥ 0) to the box, or null on a miss (slab method). */
export function rayBox(o: Vec3, d: Vec3, min: Vec3, max: Vec3): number | null {
  let t0 = 0, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < min[i] || o[i] > max[i]) return null;
      continue;
    }
    let a = (min[i] - o[i]) / d[i], b = (max[i] - o[i]) / d[i];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  return t0;
}

/** The nearest candidate the view ray hits within `len` m, or null. */
export function rayTarget(eye: Vec3, yaw: number, pitch: number, cands: readonly Cand[], len = RAY_LEN): Cand | null {
  const d = lookDir(yaw, pitch);
  let best: Cand | null = null, bestT = len;
  for (const c of cands) {
    const t = c.frame ? rayBox(toFrame(c.frame, eye), dirToFrame(c.frame, d), c.min, c.max) : rayBox(eye, d, c.min, c.max); // a rigid move keeps t
    if (t !== null && t <= bestT) { best = c; bestT = t; }
  }
  return best;
}

/** Is a player with feet at `p` within `reach` (flat distance to the box) and on the box's storey? */
export function inReach(p: Vec3, min: Vec3, max: Vec3, reach = ACT_REACH): boolean {
  const dx = Math.max(min[0] - p[0], 0, p[0] - max[0]);
  const dz = Math.max(min[2] - p[2], 0, p[2] - max[2]);
  return Math.hypot(dx, dz) <= reach && Math.abs(p[1] - min[1]) < ACT_DY;
}

/** Box around a standing thing (key, player) with feet/base at `p`. */
export const boxAt = (p: Vec3, r: number, h: number): { min: Vec3; max: Vec3 } =>
  ({ min: [p[0] - r, p[1], p[2] - r], max: [p[0] + r, p[1] + h, p[2] + r] });

/** Include the visible cabinet up to its top; keep the original floor base and footprint for act reach/storey checks. */
export const fuseBoxBounds = (floor: Vec3): { min: Vec3; max: Vec3 } =>
  boxAt(floor, FUSE_BOX_R, FUSE_BOX_CENTER_H + FUSE_BOX_H / 2);

/** A downed player's lying body in their own frame (m), measured off the Student's downed pose: head / hands ≈ 0.8 ahead
 *  (forward = (−sin yaw, −cos yaw)), feet ≈ 0.9 behind and splayed to the left (right = (cos yaw, −sin yaw)), ≈ 0.55 high. */
export const DOWN_FWD: readonly [number, number] = [-0.9, 0.85];
export const DOWN_SIDE: readonly [number, number] = [-0.9, 0.75];
export const DOWN_H = 0.8;

/** A downed player's lying body as a box in their own frame (root at `p`, facing `yaw`; x = right, z = back = −forward), so
 *  the crosshair and the server's reach follow the body itself at any facing, not a world AABB around it (≈ 1.4× wider at 45°). */
export function downCand(p: Vec3, yaw: number): { min: Vec3; max: Vec3; frame: Frame } {
  return { min: [DOWN_SIDE[0], 0, -DOWN_FWD[1]], max: [DOWN_SIDE[1], DOWN_H, -DOWN_FWD[0]], frame: { p, yaw } };
}

/** Is a player with feet at `at` within reach of the lying body of a downed player rooted at `p`, facing `yaw`? */
export function inReachDown(at: Vec3, p: Vec3, yaw: number, reach = ACT_REACH): boolean {
  const b = downCand(p, yaw);
  return inReach(toFrame(b.frame, at), b.min, b.max, reach);
}

export const PROMPT: Record<ActKind, string> = { use: 'E 打开', pick: 'E 拾取', revive: 'E 搀扶', hide: 'E 躲藏', unhide: 'E 出来', fuse: 'E 插入保险丝', sticker: 'E 揭开贴纸', keypad: 'E 输入停播密码', 'gym-switch': 'E 按下记分牌开关', exam: 'E 查看试卷', clue: 'E 阅读线索', rollcall: 'E 划掉姓名', 'mirror-push': 'E 推开镜中门对应的墙', 'mirror-key': 'E 取下镜中钥匙' };

/** Max flat distance (m) from a locker / desk centre to enter it (server-checked). */
export const HIDE_REACH = 1.2;

/** Index of the hiding place a player at (x, z) facing `yaw` would enter: the nearest within `reach` that is roughly in front (or underfoot), or -1. */
export function hideTarget(hides: readonly { x: number; z: number; y?: number }[], x: number, z: number, yaw: number, reach = HIDE_REACH, y?: number): number {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  let best = -1, bestD = reach;
  for (let i = 0; i < hides.length; i++) {
    if (y !== undefined && hides[i].y !== undefined && Math.abs(hides[i].y! - y) >= ACT_DY) continue;
    const dx = hides[i].x - x, dz = hides[i].z - z, d = Math.hypot(dx, dz);
    if (d > bestD) continue;
    if (d > 0.3 && (dx * fx + dz * fz) / d < 0.5) continue; // within ~60° of the view direction
    best = i; bestD = d;
  }
  return best;
}

/** The key item a player with feet at `at` facing `yaw` picks when the crosshair misses everything: the nearest in reach
 *  (the server's check) and roughly in front, or -1. Picking beats hiding: a key on a desk by a locker must not say 「E 躲藏」. */
export function pickNear(items: readonly { p: Vec3 }[], at: Vec3, yaw: number): number {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  let best = -1, bestD = Infinity;
  for (let i = 0; i < items.length; i++) {
    const { min, max } = boxAt(items[i].p, KEY_R, KEY_H);
    if (!inReach(at, min, max)) continue;
    const dx = items[i].p[0] - at[0], dz = items[i].p[2] - at[2], d = Math.hypot(dx, dz);
    if (d > KEY_R && (dx * fx + dz * fz) / d < 0.5) continue; // within ~60° of the view direction
    if (d < bestD) { best = i; bestD = d; }
  }
  return best;
}

/** How far (m) a ping (Q, "look here") reaches. */
export const PING_LEN = 25;

/** Where a ping lands: the first box the view ray hits, else the floor plane y = `floorY`, else the ray's end `len` m out. */
export function pingPoint(eye: Vec3, yaw: number, pitch: number, boxes: readonly { min: Vec3; max: Vec3 }[], floorY: number, len = PING_LEN): Vec3 {
  const d = lookDir(yaw, pitch);
  let t = len;
  for (const b of boxes) {
    if (eye[0] >= b.min[0] && eye[0] <= b.max[0] && eye[1] >= b.min[1] && eye[1] <= b.max[1] && eye[2] >= b.min[2] && eye[2] <= b.max[2]) continue;
    const h = rayBox(eye, d, b.min, b.max);
    if (h !== null && h < t) t = h;
  }
  if (d[1] < -1e-6) t = Math.min(t, (floorY - eye[1]) / d[1]);
  t = Math.max(t, 0);
  return [eye[0] + d[0] * t, eye[1] + d[1] * t, eye[2] + d[2] * t];
}
