// Evidence-based search. Only the room's real sight samples enter this memory; hidden/live positions never update it.
import { CROUCH_EYE_H, EYE_H, SPEED } from '../../shared/constants.ts';
import { NavGraph } from '../../shared/campus/nav.ts';
import { F_CROUCH, F_HIDE, type Vec3 } from '../../shared/protocol.ts';
import { WARDEN_EYE_H, WARDEN_SENSE_RADIUS, WARDEN_SIGHT_HALF_ANGLE, WARDEN_SIGHT_RANGE, type WardenEnv, type WardenTarget } from './warden.ts';

export interface SearchDifficulty {
  hearingMultiplier: number;
  searchSeconds: number;
  predictionSeconds: number;
  checkSeconds: number;
}

/** Extra players increase hearing, prediction lead and inspection pressure; the memory TTL stays fixed. */
export function difficultyForPlayers(count: number): SearchDifficulty {
  const extra = Math.max(0, Math.min(3, Math.floor(count) - 1));
  return { hearingMultiplier: 1 + extra * .15, searchSeconds: 8, predictionSeconds: .65 + extra * .2, checkSeconds: 1.5 - extra * .15 };
}

export function searchCanSee(from: Vec3, yaw: number, t: WardenTarget, los: WardenEnv['los']): boolean {
  if (t.f & F_HIDE) return false;
  const dx = t.p[0] - from[0], dz = t.p[2] - from[2], distance = Math.hypot(dx, dz);
  if (distance > WARDEN_SIGHT_RANGE || Math.abs(t.p[1] - from[1]) > 2.5) return false;
  if (distance > WARDEN_SENSE_RADIUS) {
    const angle = Math.atan2(-dx, -dz) - yaw;
    if (Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle))) > WARDEN_SIGHT_HALF_ANGLE) return false;
  }
  return los({ x: from[0], y: from[1] + WARDEN_EYE_H, z: from[2] },
    { x: t.p[0], y: t.p[1] + (t.f & F_CROUCH ? CROUCH_EYE_H : EYE_H), z: t.p[2] });
}

interface Sighting { p: Vec3; at: number; velocity: Vec3 }
interface HideEvidence { hiding: Vec3; approach: Vec3; at: number; checking: number }
const copy = (p: Vec3): Vec3 => [...p];
/** Preserve native route indices throughout a hunt while bounding retained evidence and refresh work. */
export const SEARCH_ANCHOR_LIMIT = 64;

export class SearchPolicy {
  private sightings = new Map<number, Sighting>();
  private hides = new Map<number, HideEvidence>();
  private count = 1;

  get difficulty(): SearchDifficulty { return difficultyForPlayers(this.count); }
  setPlayerCount(count: number): void { this.count = count; }

  observe(now: number, targets: readonly WardenTarget[], visible: (t: WardenTarget) => boolean): void {
    const eligible = new Set(targets.map((t) => t.id));
    for (const id of this.sightings.keys()) if (!eligible.has(id)) this.forget(id);
    for (const t of targets) {
      if (t.f & F_HIDE || !visible(t)) continue;
      const previous = this.sightings.get(t.id), dt = previous ? now - previous.at : 0;
      let velocity: Vec3 = [0, 0, 0];
      if (previous && dt > 0 && dt <= .3 && Math.abs(t.p[1] - previous.p[1]) < .5) {
        const dx = t.p[0] - previous.p[0], dz = t.p[2] - previous.p[2];
        // Loop warps, forced corrections and hiding transitions are discontinuities, never velocity observations.
        if (Math.hypot(dx, dz) / dt <= SPEED.run * 1.3) velocity = [dx / dt, 0, dz / dt];
      }
      this.sightings.set(t.id, { p: copy(t.p), at: now, velocity });
      this.hides.delete(t.id);
    }
    for (const [id, sight] of this.sightings) if (now - sight.at > this.difficulty.searchSeconds) this.forget(id);
  }

  witnessHide(id: number, hiding: Vec3, approach: Vec3, now: number): boolean {
    const seen = this.sightings.get(id);
    if (!seen || now - seen.at > .3 || Math.abs(seen.p[1] - approach[1]) > .5 || Math.hypot(seen.p[0] - approach[0], seen.p[2] - approach[2]) > 2) return false;
    this.hides.set(id, { hiding: copy(hiding), approach: copy(approach), at: now, checking: 0 });
    return true;
  }

  hidingGoal(id: number, now: number): Vec3 | null {
    const hide = this.hides.get(id);
    return hide && now - hide.at <= this.difficulty.searchSeconds ? copy(hide.approach) : null;
  }

  lastSeen(id: number, now: number): Vec3 | null {
    const seen = this.sightings.get(id);
    return seen && now - seen.at <= this.difficulty.searchSeconds ? copy(seen.p) : null;
  }

  predict(id: number, now: number, graph: NavGraph, from: Vec3, allowed: (p: Vec3) => boolean = () => true): Vec3 | null {
    const seen = this.sightings.get(id);
    if (!seen || now - seen.at > this.difficulty.searchSeconds || !graph.nodes.length) return null;
    const hide = this.hidingGoal(id, now);
    const horizon = this.difficulty.predictionSeconds;
    const desired: Vec3 = hide ?? [seen.p[0] + seen.velocity[0] * horizon, seen.p[1], seen.p[2] + seen.velocity[2] * horizon];
    const fromNode = graph.nearest(...from);
    if (fromNode < 0) return null;
    const reachable = graph.reachable(fromNode);
    let best: Vec3 | null = null, score = Infinity;
    for (const id of reachable) {
      const n = graph.nodes[id], p: Vec3 = [n.x, n.y, n.z];
      if (Math.abs(n.y - desired[1]) > .5 || !allowed(p)) continue;
      const d = Math.hypot(n.x - desired[0], n.z - desired[2]);
      if (d < score) { score = d; best = p; }
    }
    // A disconnected graph component must not replace the last real goal with the monster's own parking spot.
    return score >= Math.hypot(from[0] - desired[0], from[2] - desired[2]) - .05 ? null : best;
  }

  /** Stay near the remembered entrance and visibly inspect it. Losing reach/LOS/protection restarts the hold. */
  check(now: number, dt: number, from: Vec3, eligible: ReadonlySet<number>, clear: (a: Vec3, b: Vec3) => boolean): number[] {
    const caught: number[] = [];
    for (const [id, hide] of this.hides) {
      if (now - hide.at > this.difficulty.searchSeconds) { this.hides.delete(id); continue; }
      const near = Math.abs(from[1] - hide.approach[1]) < .6 && Math.hypot(from[0] - hide.approach[0], from[2] - hide.approach[2]) <= 1.8;
      if (!eligible.has(id) || !near || !clear(from, hide.approach) || !clear(from, hide.hiding)) { hide.checking = 0; continue; }
      hide.checking += dt;
      if (hide.checking + 1e-7 >= this.difficulty.checkSeconds) { caught.push(id); this.forget(id); }
    }
    return caught;
  }

  forget(id: number): void { this.sightings.delete(id); this.hides.delete(id); }
  reset(): void { this.sightings.clear(); this.hides.clear(); }
}

/** A room-local graph with stable node indices. Door/world changes never mutate the cached graph used by guide arrows. */
export class SearchNavGraph extends NavGraph {
  private source: NavGraph;
  private passable: (a: Vec3, b: Vec3) => boolean;
  private origin?: () => Vec3 | undefined;
  private connection: (a: Vec3, b: Vec3) => boolean;

  get anchorCount(): number { return this.nodes.length - this.source.nodes.length; }

  constructor(source: NavGraph, passable: (a: Vec3, b: Vec3) => boolean, origin?: () => Vec3 | undefined, connection = passable) {
    super();
    this.source = source;
    this.passable = passable;
    this.origin = origin;
    this.connection = connection;
    this.nodes.push(...source.nodes.map((n) => ({ ...n })));
    this.refresh();
  }

  override nearest(x: number, y: number, z: number, filter?: Parameters<NavGraph['nearest']>[3]): number {
    const from = this.origin?.();
    if (!from || Math.hypot(from[0] - x, from[1] - y, from[2] - z) >= 1e-6) return super.nearest(x, y, z, filter);
    const candidates = this.nodes.map((n, i) => ({ n, i, d: (n.x - x) ** 2 + (3 * (n.y - y)) ** 2 + (n.z - z) ** 2 }))
      .filter(({ n, i }) => !filter || filter(n, i)).sort((a, b) => a.d - b.d);
    // Most positions connect to the first node. Do not capsule-sample every far-away node just to find the nearest.
    for (const { n, i } of candidates) if (this.connection(from, [n.x, n.y, n.z])) return i;
    if (filter) return -1;
    const anchor = this.anchor(from);
    // At capacity, keep all in-flight route ids intact. Room's full capsule check rejects any unreachable
    // fallback proposal before publication, and recovery rebuilds at the exact old position if necessary.
    return anchor >= 0 ? anchor : super.nearest(x, y, z);
  }

  /** Exact evidence anchor, or -1 at capacity. Never evict/reassign a node referenced by the native walker. */
  anchor(p: Vec3): number {
    const existing = this.nodes.findIndex((n, i) => i >= this.source.nodes.length && n.x === p[0] && n.y === p[1] && n.z === p[2]);
    if (existing >= 0) return existing;
    if (this.anchorCount >= SEARCH_ANCHOR_LIMIT) return -1;
    const id = this.nodes.push({ x: p[0], y: p[1], z: p[2] }) - 1;
    this.adj.push([]);
    const candidates = this.nodes.slice(0, id).map((n, i) => ({ n, i, d: Math.hypot(n.x - p[0], n.y - p[1], n.z - p[2]) }))
      .filter(({ n, d }) => d <= WARDEN_SIGHT_RANGE && Math.abs(n.y - p[1]) < .5).sort((a, b) => a.d - b.d);
    let connected = 0;
    for (const { n, i } of candidates.slice(0, 32)) if (this.connection(p, [n.x, n.y, n.z])) {
      this.link(id, i);
      if (++connected >= 4) break;
    }
    // Two genuine evidence anchors may share a clear local aisle even when all cached room nodes are at its door.
    for (let i = this.source.nodes.length; i < id; i++) {
      const n = this.nodes[i];
      if (Math.abs(n.y - p[1]) < .5 && this.connection(p, [n.x, n.y, n.z])) this.link(id, i);
    }
    return id;
  }

  refresh(): void {
    const anchors = this.nodes.slice(this.source.nodes.length).map((n): Vec3 => [n.x, n.y, n.z]);
    this.nodes.length = this.source.nodes.length;
    this.adj.length = 0;
    for (let i = 0; i < this.source.nodes.length; i++) {
      const a = this.nodes[i];
      this.adj.push(this.source.adj[i].filter((j) => {
        const b = this.nodes[j];
        return this.passable([a.x, a.y, a.z], [b.x, b.y, b.z]);
      }));
    }
    for (const p of anchors) this.anchor(p);
  }
}
