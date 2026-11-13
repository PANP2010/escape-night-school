// Safe staging only. The room owns the shared scare cooldown and walks the returned route without perception/catches.
import type { NavGraph } from '../../shared/campus/nav.ts';
import { CROUCH_EYE_H, EYE_H } from '../../shared/constants.ts';
import { F_CROUCH, F_HIDE, type Vec3 } from '../../shared/protocol.ts';
import { L1_SIGHTING_POINTS, type SightingPoint } from './sighting-points.ts';

export type { SightingPoint } from './sighting-points.ts';

export const SIGHTING = {
  openingFrom: 30,
  /** Target for the first reveal; never overrides a visibility/collision veto after 60 s. */
  openingDeadline: 60,
  cooldown: 45,
  minDistance: 6,
  /** Existing monster snapshots collapse interpolation above 3 m; keep a margin for position rounding. */
  minRelocation: 3.1,
  /** A 1.75 m figure at 20 m projects above 40 px at 720p / 75° vertical FOV. */
  maxDistance: 20,
  /** Fog and camera far planes cannot prove a source hidden; do not authorize relocation by distance alone. */
  viewRange: Infinity,
  horizontalHalfAngle: 75 * Math.PI / 180,
  verticalHalfAngle: 50 * Math.PI / 180,
  /** Keep witnesses inside the 75° camera at 16:9 or wider, with a screen-edge margin. */
  witnessHorizontalHalfAngle: 50 * Math.PI / 180,
  witnessVerticalHalfAngle: 35 * Math.PI / 180,
  sameFloor: .35,
  sampleStep: .5,
} as const;

type Point = { x: number; y: number; z: number };
type Los = (a: Point, b: Point) => boolean;

export interface SightingViewer {
  id: number;
  p: Vec3;
  yaw: number;
  pitch?: number;
  f: number;
  /** Actual camera height: down=.55, desk=.4, locker=1.45. Missing hidden height checks all of these. */
  eyeHeight?: number;
  /** Downed/hidden players still veto relocation; only eligible witnesses count toward the reveal. */
  canWitness?: boolean;
}

export interface SightingEnv {
  graph: NavGraph;
  /** Include walls, furniture, closed doors and current level barriers. */
  los: Los;
  /** Mandatory capsule test, including the starting position, ground support and level boundaries. */
  walkable: (from: Vec3, to: Vec3) => boolean;
}

export interface SightingContext {
  /** Displayed level number (L1 = 1). Other levels retain their existing controllers. */
  level: number;
  elapsed: number;
  /** All authoritative viewpoints, including downed and hidden teammates, never just eligible prey. */
  players: readonly SightingViewer[];
  warden: { p: Vec3; state: 'patrol' | 'investigate' | 'chase' | 'catch'; retreating: boolean };
  ready: boolean;
  /** From the room's shared 45 s scare cooldown; consume it only after accepting this plan. */
  scareReady: boolean;
  protected: boolean;
  /** Intro/fade/debug hold/broadcast/finale, or an observer whose actual camera is unknown. */
  controlBusy: boolean;
}

export interface SightingPlan {
  id: string;
  kind: SightingPoint['kind'];
  path: Vec3[];
  speed: number;
  holdSeconds: number;
  yaw: number;
  witness: number;
}

const finite = (p: Vec3) => p.every(Number.isFinite);
const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const sameFloor = (a: Vec3, b: Vec3) => Math.abs(a[1] - b[1]) <= SIGHTING.sameFloor;
const BODY_HEIGHTS = [.1, .45, .8, 1.1, 1.45, 1.65, 1.8, 1.95, 2.05, 2.2, 2.3];
const BODY_OFFSETS = [[0, 0], [-.5, 0], [.5, 0], [0, -.5], [0, .5], [-.5, -.5], [-.5, .5], [.5, -.5], [.5, .5]];
const WITNESS_HEIGHTS = [.35, 1, 1.65];
const WITNESS_OFFSETS = [[0, 0]];

/**
 * Conservative rectangular widescreen frustum, checking a 2.3 m tall, 1 m wide silhouette.
 * Looking out through a locker slit is still looking: F_HIDE never disables this veto.
 * Invalid camera data fails closed, so it cannot authorize a teleport.
 */
export function sightingVisible(viewer: SightingViewer, feet: Vec3, los: Los): boolean {
  return visible(viewer, feet, los, false);
}

/** The wide safety envelope may veto relocation, but only real body points inside the screen count as a reveal. */
function visible(viewer: SightingViewer, feet: Vec3, los: Los, witness: boolean): boolean {
  if (!finite(viewer.p) || !finite(feet) || !Number.isFinite(viewer.yaw) || !Number.isFinite(viewer.pitch ?? 0)
    || (viewer.eyeHeight !== undefined && !Number.isFinite(viewer.eyeHeight))) return true;
  const heights = viewer.eyeHeight !== undefined ? [viewer.eyeHeight]
    : viewer.f & F_HIDE ? [.4, .55, 1, 1.45, EYE_H]
      : [viewer.f & F_CROUCH ? CROUCH_EYE_H : EYE_H];
  const sy = Math.sin(viewer.yaw), cy = Math.cos(viewer.yaw);
  const sp = Math.sin(viewer.pitch ?? 0), cp = Math.cos(viewer.pitch ?? 0);
  const tanX = Math.tan(witness ? SIGHTING.witnessHorizontalHalfAngle : SIGHTING.horizontalHalfAngle);
  const tanY = Math.tan(witness ? SIGHTING.witnessVerticalHalfAngle : SIGHTING.verticalHalfAngle);
  for (const h of heights) {
    const eye = { x: viewer.p[0], y: viewer.p[1] + h, z: viewer.p[2] };
    for (const bodyY of witness ? WITNESS_HEIGHTS : BODY_HEIGHTS) for (const [ox, oz] of witness ? WITNESS_OFFSETS : BODY_OFFSETS) {
      const at = { x: feet[0] + ox, y: feet[1] + bodyY, z: feet[2] + oz };
      const dx = at.x - eye.x, dy = at.y - eye.y, dz = at.z - eye.z;
      const horizontal = -dx * sy - dz * cy;
      const depth = horizontal * cp + dy * sp;
      if (depth <= 0 || Math.hypot(dx, dy, dz) > SIGHTING.viewRange) continue;
      if (Math.abs(dx * cy - dz * sy) > depth * tanX || Math.abs(dy * cp - horizontal * sp) > depth * tanY) continue;
      if (los(eye, at)) return true;
    }
  }
  return false;
}

/** True at every instant of a segment, including between the samples used for reveal/occlusion. */
function staysDistant(a: Vec3, b: Vec3, viewers: readonly SightingViewer[]): boolean {
  const dx = b[0] - a[0], dz = b[2] - a[2], dd = dx * dx + dz * dz;
  return viewers.every(v => {
    const u = dd ? Math.max(0, Math.min(1, ((v.p[0] - a[0]) * dx + (v.p[2] - a[2]) * dz) / dd)) : 0;
    return Math.hypot(a[0] + dx * u - v.p[0], a[2] + dz * u - v.p[2]) >= SIGHTING.minDistance;
  });
}

/** Connect only to nodes reached by a real capsule segment; nearest() alone can select through a wall. */
function attachment(env: SightingEnv, p: Vec3): number | undefined {
  const nearby = env.graph.nodes.flatMap((n, id) => {
    const q: Vec3 = [n.x, n.y, n.z];
    return sameFloor(p, q) && distance(p, q) <= 6 ? [{ id, q, d: distance(p, q) }] : [];
  }).sort((a, b) => a.d - b.d);
  return nearby.find(n => env.walkable(p, n.q))?.id;
}

/** A dynamic-door-aware, same-floor route exists. Never infer connectivity from a thin sight ray. */
function connected(env: SightingEnv, start: number, goal: number, y: number, edgeCache: Map<string, boolean>): boolean {
  const visited = new Set([start]), stack = [start];
  while (stack.length) {
    const i = stack.pop()!;
    if (i === goal) return true;
    const a = env.graph.nodes[i];
    for (const j of env.graph.adj[i]) {
      const b = env.graph.nodes[j];
      if (visited.has(j) || Math.abs(b.y - y) > SIGHTING.sameFloor) continue;
      const key = i < j ? `${i}:${j}` : `${j}:${i}`;
      let clear = edgeCache.get(key);
      if (clear === undefined) {
        clear = env.walkable([a.x, a.y, a.z], [b.x, b.y, b.z]);
        edgeCache.set(key, clear);
      }
      if (clear) { visited.add(j); stack.push(j); }
    }
  }
  return false;
}

/**
 * Select only; no timers, randomness, AI mutation or cooldown consumption. No safe plan means defer and try later.
 * The room must recheck live distance/capsule movement while playing it, suppress attacks, and retain the final feet
 * position when releasing Warden. Never reset him to a nearest nav node or teleport him back when the performance ends.
 */
export function selectSighting(env: SightingEnv, ctx: SightingContext, candidates: readonly SightingPoint[] = L1_SIGHTING_POINTS): SightingPlan | undefined {
  if (ctx.level !== 1 || !Number.isFinite(ctx.elapsed) || ctx.elapsed < SIGHTING.openingFrom || !ctx.ready || !ctx.scareReady || ctx.protected || ctx.controlBusy
    || ctx.warden.state === 'chase' || ctx.warden.state === 'catch' || ctx.warden.retreating || !ctx.players.length) return;
  const viewers = ctx.players;
  if (viewers.some(v => sightingVisible(v, ctx.warden.p, env.los))) return;
  if (!finite(ctx.warden.p) || !env.walkable(ctx.warden.p, ctx.warden.p)) return;
  const source = attachment(env, ctx.warden.p);
  if (source === undefined) return;
  const edgeCache = new Map<string, boolean>();
  let best: SightingPlan | undefined, score = Infinity;
  for (const c of candidates) {
    if (c.level !== ctx.level || c.path.length < 2 || c.path.some(p => !finite(p) || !sameFloor(ctx.warden.p, p))) continue;
    const path = c.path.map(p => [...p] as Vec3), first = path[0], last = path[path.length - 1];
    if (distance(ctx.warden.p, first) < SIGHTING.minRelocation) continue;
    if (viewers.some(v => sightingVisible(v, first, env.los) || sightingVisible(v, last, env.los))) continue;
    let length = 0, safe = true;
    for (let i = 0; i < path.length; i++) {
      const a = path[Math.max(0, i - 1)], b = path[i];
      if (!env.walkable(a, b) || !staysDistant(a, b, viewers)) { safe = false; break; }
      length += distance(a, b);
    }
    if (!safe || length < 1 || length > 30) continue;
    const entry = attachment(env, first);
    if (entry === undefined || !connected(env, source, entry, first[1], edgeCache)) continue;
    let witness: number | undefined, revealDistance = Infinity;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i], count = Math.max(1, Math.ceil(distance(a, b) / SIGHTING.sampleStep));
      for (let k = 1; k <= count; k++) {
        const t = k / count, p: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        for (const v of viewers) {
          const d = distance(p, v.p);
          if (v.canWitness === false || !sameFloor(v.p, p) || d > SIGHTING.maxDistance || d >= revealDistance) continue;
          if (visible(v, p, env.los, true)) { witness = v.id; revealDistance = d; }
        }
      }
    }
    if (witness === undefined) continue;
    const cost = revealDistance + length * .05;
    if (cost >= score) continue;
    const next = path[1];
    best = { id: c.id, kind: c.kind, path, witness, speed: c.speed ?? 2, holdSeconds: c.holdSeconds ?? 1.2,
      yaw: c.yaw ?? Math.atan2(first[0] - next[0], first[2] - next[2]) };
    score = cost;
  }
  return best;
}
