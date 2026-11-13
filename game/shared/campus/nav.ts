/**
 * Campus navigation: a waypoint graph over corridor centrelines, doors, stairs and entrances
 * (built by client/src/campus/world/navgraph.ts from the interior routes), A* over it, and
 * collider queries for NPCs: line of sight (segment vs boxes) and walkability (a capsule walked
 * along the segment with the same moveCapsule the players use). Pure, no three.js.
 */
import { CollisionWorld, moveCapsule, overlaps, type AABB, type Body, type Capsule } from './collision.ts';

export interface NavNode { x: number; y: number; z: number; /** `building:level` for a room's spot, 'out' outdoors */ tag?: string; room?: string }

/** The walker the graph is checked with (players use the same: shared/constants PLAYER_R). */
export const NAV_CAPSULE: Capsule = { radius: 0.3, height: 1.7, stepHeight: 0.35 };

export class NavGraph {
  readonly nodes: NavNode[] = [];
  readonly adj: number[][] = [];

  /** A node at p, or the existing one within 5 cm (and 0.3 m in y). */
  addNode(p: NavNode): number {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const n = this.nodes[i];
      if (Math.abs(n.x - p.x) < 0.05 && Math.abs(n.z - p.z) < 0.05 && Math.abs(n.y - p.y) < 0.3) {
        if (p.tag && !n.tag) n.tag = p.tag;
        return i;
      }
    }
    this.adj.push([]);
    return this.nodes.push({ ...p }) - 1;
  }

  link(a: number, b: number): void {
    if (a === b || this.adj[a].includes(b)) return;
    this.adj[a].push(b); this.adj[b].push(a);
  }

  /** Add the points as a path; returns their node ids. */
  chain(points: NavNode[]): number[] {
    const ids = points.map(p => this.addNode(p));
    for (let i = 1; i < ids.length; i++) this.link(ids[i - 1], ids[i]);
    return ids;
  }

  dist(a: number, b: number): number {
    const p = this.nodes[a], q = this.nodes[b];
    return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
  }

  /** Nearest node to (x, y, z); y counts triple so another storey is never "near". */
  nearest(x: number, y: number, z: number, filter?: (n: NavNode, i: number) => boolean): number {
    let best = -1, bd = Infinity;
    this.nodes.forEach((n, i) => {
      if (filter && !filter(n, i)) return;
      const d = (n.x - x) ** 2 + (3 * (n.y - y)) ** 2 + (n.z - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  /** Shortest node path a → b (inclusive), or null when they aren't connected. */
  astar(a: number, b: number): number[] | null {
    const g = new Map<number, number>([[a, 0]]), from = new Map<number, number>();
    const open = new Set([a]), f = new Map<number, number>([[a, this.dist(a, b)]]);
    while (open.size) {
      let cur = -1, cf = Infinity;
      for (const i of open) if (f.get(i)! < cf) { cf = f.get(i)!; cur = i; }
      if (cur === b) {
        const path = [b];
        while (from.has(path[0])) path.unshift(from.get(path[0])!);
        return path;
      }
      open.delete(cur);
      for (const n of this.adj[cur]) {
        const t = g.get(cur)! + this.dist(cur, n);
        if (t >= (g.get(n) ?? Infinity)) continue;
        from.set(n, cur); g.set(n, t); f.set(n, t + this.dist(n, b)); open.add(n);
      }
    }
    return null;
  }

  /** Every node id reachable from a. */
  reachable(a: number): Set<number> {
    const seen = new Set([a]), stack = [a];
    while (stack.length) for (const n of this.adj[stack.pop()!]) if (!seen.has(n)) { seen.add(n); stack.push(n); }
    return seen;
  }

  /**
   * The nodes passing `keep` and the links between them (renumbered): e.g. one level's area of the campus graph.
   * Two kept nodes that were only joined through a dropped one (an entrance node just outside the area) get a
   * direct link when `bridge` allows it, so cutting the area doesn't split its corridors apart.
   */
  subgraph(keep: (n: NavNode) => boolean, bridge?: (a: NavNode, b: NavNode) => boolean): NavGraph {
    const g = new NavGraph(), id = new Map<number, number>();
    this.nodes.forEach((n, i) => { if (keep(n)) { id.set(i, g.nodes.push({ ...n }) - 1); g.adj.push([]); } });
    for (const [i, j] of id) g.adj[j] = this.adj[i].flatMap((k) => (id.has(k) ? [id.get(k)!] : []));
    if (bridge) this.nodes.forEach((_, i) => {
      if (id.has(i)) return;
      const ks = this.adj[i].filter((k) => id.has(k));
      for (const a of ks) for (const b of ks) if (a < b && bridge(this.nodes[a], this.nodes[b])) g.link(id.get(a)!, id.get(b)!);
    });
    return g;
  }
}

/** Segment a → b passes no box (slab test): eyes at a can see b. */
export function lineOfSight(world: CollisionWorld, a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): boolean {
  const d = [b.x - a.x, b.y - a.y, b.z - a.z], o = [a.x, a.y, a.z];
  for (const bx of world.query(Math.min(a.x, b.x), Math.min(a.z, b.z), Math.max(a.x, b.x), Math.max(a.z, b.z))) {
    if (hits(bx, o, d)) return false;
  }
  return true;
}

export interface BeamHit { t: number; nx: number; ny: number; nz: number }

/**
 * First thing a ray from `o` along unit `d` meets within `maxT` m: a box face or the ground plane (y = 0 outside
 * the holes). `t` is the distance, n the face normal (towards the ray). For a teammate's torch spot (client game.ts).
 */
export function beamHit(world: CollisionWorld, o: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }, maxT: number, out: BeamHit = { t: 0, nx: 0, ny: 0, nz: 0 }): BeamHit | null {
  let best = maxT, axis = -1;
  const oo = [o.x, o.y, o.z], dd = [d.x, d.y, d.z];
  if (d.y < -1e-9 && o.y > 0) {
    const t = -o.y / d.y;
    if (t < best && world.floorAt(o.x + d.x * t, o.z + d.z * t) === 0) { best = t; axis = 1; }
  }
  const ex = o.x + d.x * maxT, ez = o.z + d.z * maxT;
  for (const b of world.query(Math.min(o.x, ex), Math.min(o.z, ez), Math.max(o.x, ex), Math.max(o.z, ez), scratch)) {
    const lo = [b.minX, b.minY, b.minZ], hi = [b.maxX, b.maxY, b.maxZ];
    let t0 = 0, t1 = best, k0 = -1, miss = false;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(dd[k]) < 1e-9) { if (oo[k] <= lo[k] || oo[k] >= hi[k]) { miss = true; break; } continue; }
      let u = (lo[k] - oo[k]) / dd[k], v = (hi[k] - oo[k]) / dd[k];
      if (u > v) [u, v] = [v, u];
      if (u > t0) { t0 = u; k0 = k; }
      t1 = Math.min(t1, v);
      if (t0 >= t1) { miss = true; break; }
    }
    if (!miss && k0 >= 0 && t0 < best) { best = t0; axis = k0; } // k0 < 0: the ray starts inside the box, ignore it
  }
  if (axis < 0) return null;
  out.t = best; out.nx = out.ny = out.nz = 0;
  const s = -Math.sign(dd[axis]);
  if (axis === 0) out.nx = s; else if (axis === 1) out.ny = s; else out.nz = s;
  return out;
}
const scratch: AABB[] = [];

function hits(b: AABB, o: number[], d: number[]): boolean {
  const lo = [b.minX, b.minY, b.minZ], hi = [b.maxX, b.maxY, b.maxZ];
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]) < 1e-9) { if (o[k] <= lo[k] || o[k] >= hi[k]) return false; continue; }
    let u = (lo[k] - o[k]) / d[k], v = (hi[k] - o[k]) / d[k];
    if (u > v) [u, v] = [v, u];
    t0 = Math.max(t0, u); t1 = Math.min(t1, v);
    if (t0 >= t1) return false;
  }
  return true;
}

/**
 * Walk a capsule from `from` through the points (xz targets) and return the feet height at each,
 * or null where it gets stuck (a wall, a gap narrower than the capsule) or falls more than a step.
 */
export function walk(world: CollisionWorld, from: { x: number; y: number; z: number }, points: [number, number][], c: Capsule = NAV_CAPSULE): number[] | null {
  const p: Body = { x: from.x, y: from.y, z: from.z, vy: 0, grounded: true };
  if (overlaps(world, p, c)) return null;
  const ys: number[] = [];
  for (const [tx, tz] of points) {
    let stall = 0, best = Infinity;
    for (;;) {
      const dx = tx - p.x, dz = tz - p.z, d = Math.hypot(dx, dz);
      if (d < 0.1) break;
      if (d < best - 0.02) { best = d; stall = 0; } else if (++stall > 12) return null;
      const s = Math.min(0.2, d) / d, y0 = p.y;
      moveCapsule(world, p, dx * s, dz * s, 0.05, c);
      for (let i = 0; i < 20 && !p.grounded; i++) moveCapsule(world, p, 0, 0, 0.05, c);
      if (y0 - p.y > c.stepHeight + 0.05) return null;
    }
    ys.push(p.y);
  }
  return ys;
}
