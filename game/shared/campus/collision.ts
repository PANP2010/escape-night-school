/**
 * Static collision: axis-aligned boxes + a vertical capsule walker.
 *
 * The capsule is resolved as a circle (radius r) against box footprints in XZ
 * for every box that overlaps its vertical span [feet + stepHeight, feet + height].
 * Boxes whose top is within stepHeight of the feet are "floor", not wall: the walker
 * snaps up onto them (stairs = a run of low boxes; ramps are authored as fine steps).
 * Penetration is pushed out along the contact normal, so walking into a wall at an
 * angle keeps the tangential part of the motion (wall sliding) for free.
 * Pure functions, no three.js: unit-testable and reusable by NPCs.
 */

export interface AABB {
  minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number;
  /** a vertical cylinder inscribed in the XZ footprint (radius = half its width) instead of the box: a tree trunk */
  round?: true;
}

export interface Capsule { radius: number; height: number; stepHeight: number }

/** Feet position + vertical state. Mutated in place by moveCapsule. */
export interface Body { x: number; y: number; z: number; vy: number; grounded: boolean }

export const GRAVITY = 18; // m/s², a bit heavier than real so falls feel grounded
export const MAX_FALL = 30;
const SKIN = 1e-4;
const ITERATIONS = 4;

export const box = (x: number, z: number, w: number, d: number, h: number, y = 0): AABB =>
  ({ minX: x - w / 2, minY: y, minZ: z - d / 2, maxX: x + w / 2, maxY: y + h, maxZ: z + d / 2 });

/** A vertical cylinder of radius r standing at (x, z), from y to y + h (still an AABB to the broadphase). */
export const cylinder = (x: number, z: number, r: number, h: number, y = 0): AABB => ({ ...box(x, z, r * 2, r * 2, h, y), round: true });

/**
 * A straight flight of steps as boxes. Starts at (x, z) going along `dir`
 * ('+z' | '-z' | '+x' | '-x'), each step `rise` tall and `run` deep, `width` wide.
 * Step i is solid from `y` up to its tread, so there is nothing to fall through.
 */
export function stairs(x: number, z: number, dir: '+x' | '-x' | '+z' | '-z', width: number, steps: number, rise: number, run: number, y = 0): AABB[] {
  const out: AABB[] = [];
  const s = dir[0] === '+' ? 1 : -1;
  for (let i = 0; i < steps; i++) {
    const along = s * (i + 0.5) * run;
    const h = (i + 1) * rise;
    out.push(dir[1] === 'z' ? box(x, z + along, width, run, h, y) : box(x + along, z, run, width, h, y));
  }
  return out;
}

/** Uniform-grid broadphase over static boxes. */
export class CollisionWorld {
  readonly boxes: AABB[] = [];
  private cells = new Map<string, number[]>();
  private stamp = 0;
  private seen: number[] = [];
  /** footprints (x0, x1, z0, z1) with no ground plane under them: a building over a basement (its slabs carry the walker) */
  readonly holes: [number, number, number, number][] = [];
  readonly cellSize: number;

  constructor(boxes: AABB[] = [], cellSize = 8) { this.cellSize = cellSize; for (const b of boxes) this.add(b); }

  /** Take the ground plane away over a footprint. */
  addHole(x0: number, x1: number, z0: number, z1: number): void { this.holes.push([x0, x1, z0, z1]); }
  /** The ground plane's height under (x, z): 0, or far below in a hole. */
  floorAt(x: number, z: number): number {
    for (const h of this.holes) if (x > h[0] && x < h[1] && z > h[2] && z < h[3]) return NO_GROUND;
    return 0;
  }

  /** Add a box; returns its id (for move). */
  add(b: AABB): number {
    const id = this.boxes.push(b) - 1;
    this.seen.push(0);
    this.forCells(b.minX, b.minZ, b.maxX, b.maxZ, k => {
      let c = this.cells.get(k);
      if (!c) this.cells.set(k, c = []);
      c.push(id);
    });
    return id;
  }

  /** Move box `id` to `to` (a 密集架 carriage on its rails, world/compact.ts): re-filed in the cells it now covers. */
  move(id: number, to: AABB): void {
    const b = this.boxes[id];
    this.forCells(b.minX, b.minZ, b.maxX, b.maxZ, k => {
      const c = this.cells.get(k)!, i = c.indexOf(id);
      if (i >= 0) c.splice(i, 1);
    });
    Object.assign(b, to);
    this.forCells(b.minX, b.minZ, b.maxX, b.maxZ, k => {
      let c = this.cells.get(k);
      if (!c) this.cells.set(k, c = []);
      c.push(id);
    });
  }

  /** Boxes whose XZ footprint may intersect the given rectangle (each at most once). */
  query(minX: number, minZ: number, maxX: number, maxZ: number, out: AABB[] = []): AABB[] {
    out.length = 0;
    const st = ++this.stamp;
    this.forCells(minX, minZ, maxX, maxZ, k => {
      const c = this.cells.get(k);
      if (!c) return;
      for (const id of c) {
        if (this.seen[id] === st) continue;
        this.seen[id] = st;
        out.push(this.boxes[id]);
      }
    });
    return out;
  }

  private forCells(minX: number, minZ: number, maxX: number, maxZ: number, fn: (k: string) => void): void {
    const s = this.cellSize;
    const x0 = Math.floor(minX / s), x1 = Math.floor(maxX / s);
    const z0 = Math.floor(minZ / s), z1 = Math.floor(maxZ / s);
    for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) fn(i + ',' + j);
  }
}
/** Result of the last moveCapsule call (reused object, no per-step allocation). */
export const moveResult = { hitWall: false, stepped: 0 };
const cand: AABB[] = [];

/** Point of the box's footprint nearest (x, z) (on the circle for a round one; (x, z) itself when inside). */
const near = { x: 0, z: 0 };
function nearest(b: AABB, x: number, z: number): typeof near {
  if (b.round) {
    const R = (b.maxX - b.minX) / 2, ox = (b.minX + b.maxX) / 2, oz = (b.minZ + b.maxZ) / 2;
    const dx = x - ox, dz = z - oz, d = Math.hypot(dx, dz);
    if (d <= R) { near.x = x; near.z = z; } else { near.x = ox + (dx * R) / d; near.z = oz + (dz * R) / d; }
  } else {
    near.x = Math.max(b.minX, Math.min(x, b.maxX)); near.z = Math.max(b.minZ, Math.min(z, b.maxZ));
  }
  return near;
}

/** Circle footprint (x, z, r) strictly overlaps the box's XZ footprint. */
function overlapsXZ(b: AABB, x: number, z: number, r: number): boolean {
  const c = nearest(b, x, z);
  const dx = x - c.x, dz = z - c.z;
  return dx * dx + dz * dz < r * r - SKIN;
}

/** Ground plane height inside a CollisionWorld hole (nothing to stand on but boxes). */
export const NO_GROUND = -1e6;

/** Highest walkable top under the footprint at or below `maxY` (ground plane y=0, except over holes). */
export function groundHeight(world: CollisionWorld, x: number, z: number, r: number, maxY: number): number {
  let g = world.floorAt(x, z);
  for (const b of world.query(x - r, z - r, x + r, z + r, cand)) {
    if (b.maxY <= maxY + SKIN && b.maxY > g && overlapsXZ(b, x, z, r)) g = b.maxY;
  }
  return g;
}

/** True if the capsule at p intersects any box above its step span (e.g. can't stand up under a desk). */
export function overlaps(world: CollisionWorld, p: Body, c: Capsule): boolean {
  const r = c.radius;
  for (const b of world.query(p.x - r, p.z - r, p.x + r, p.z + r, cand)) {
    if (b.maxY <= p.y + c.stepHeight + SKIN || b.minY >= p.y + c.height) continue;
    if (overlapsXZ(b, p.x, p.z, r)) return true;
  }
  return false;
}

/** Push the circle out of every box that intersects the capsule's non-step span. Returns true on contact. */
function resolveWalls(world: CollisionWorld, p: Body, c: Capsule): boolean {
  const r = c.radius;
  let hit = false;
  for (let it = 0; it < ITERATIONS; it++) {
    let moved = false;
    for (const b of world.query(p.x - r, p.z - r, p.x + r, p.z + r, cand)) {
      if (b.maxY <= p.y + c.stepHeight + SKIN || b.minY >= p.y + c.height) continue; // steppable or overhead
      const q = nearest(b, p.x, p.z);
      const dx = p.x - q.x, dz = p.z - q.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-12) {
        const d = Math.sqrt(d2), k = (r - d + SKIN) / d;
        p.x += dx * k; p.z += dz * k;
      } else if (b.round) {
        // centre inside the trunk: out radially (+x if dead centre)
        const R = (b.maxX - b.minX) / 2, ox = (b.minX + b.maxX) / 2, oz = (b.minZ + b.maxZ) / 2;
        const ex = p.x - ox, ez = p.z - oz, e = Math.hypot(ex, ez), k = (R + r + SKIN) / (e || 1);
        p.x = ox + (e ? ex * k : R + r + SKIN); p.z = oz + ez * k;
      } else {
        // centre inside the footprint: leave through the nearest face
        const l = p.x - b.minX, rr = b.maxX - p.x, n = p.z - b.minZ, f = b.maxZ - p.z;
        const m = Math.min(l, rr, n, f);
        if (m === l) p.x = b.minX - r - SKIN; else if (m === rr) p.x = b.maxX + r + SKIN;
        else if (m === n) p.z = b.minZ - r - SKIN; else p.z = b.maxZ + r + SKIN;
      }
      moved = hit = true;
    }
    if (!moved) break;
  }
  return hit;
}

/** One sub-step: move, step up onto low ledges, push out of walls. Returns true on wall contact. */
function subStep(world: CollisionWorld, p: Body, dx: number, dz: number, c: Capsule): boolean {
  p.x += dx; p.z += dz;
  if (p.grounded) {
    // step up first so a stair riser isn't treated as a wall
    const g = groundHeight(world, p.x, p.z, c.radius, p.y + c.stepHeight);
    if (g > p.y) { moveResult.stepped += g - p.y; p.y = g; }
  }
  const hit = resolveWalls(world, p, c);
  if (hit) moveResult.hitWall = true;
  return hit;
}

/**
 * Move a capsule body by a horizontal displacement (dx, dz) over dt seconds.
 * Handles wall sliding, stepping up/down ledges ≤ stepHeight, and gravity when
 * walking off anything taller. Long moves are sub-stepped so thin walls can't be tunnelled.
 */
export function moveCapsule(world: CollisionWorld, p: Body, dx: number, dz: number, dt: number, c: Capsule): Body {
  moveResult.hitWall = false;
  moveResult.stepped = 0;
  const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / (c.radius * 0.5)));
  // a gap narrower than the capsule pushes it back and forth between two boxes and leaves it inside;
  // such a sub-step is undone (then retried per axis so sliding along the gap's mouth still works)
  let clean = !overlaps(world, p, c);
  for (let i = 0; i < n; i++) {
    const x0 = p.x, y0 = p.y, z0 = p.z, s0 = moveResult.stepped;
    if (subStep(world, p, dx / n, dz / n, c) && clean && overlaps(world, p, c)) {
      moveResult.hitWall = true;
      let ok = false;
      for (const [sx, sz] of [[dx / n, 0], [0, dz / n]]) {
        p.x = x0; p.y = y0; p.z = z0; moveResult.stepped = s0;
        if (sx === 0 && sz === 0) continue;
        if (!subStep(world, p, sx, sz, c) || !overlaps(world, p, c)) { ok = true; break; }
      }
      if (!ok) { p.x = x0; p.y = y0; p.z = z0; moveResult.stepped = s0; }
    }
    clean = clean || !overlaps(world, p, c);
  }
  const g = groundHeight(world, p.x, p.z, c.radius, p.y + (p.grounded ? c.stepHeight : 0));
  if (p.grounded && p.y - g <= c.stepHeight + SKIN) {
    if (g !== p.y) moveResult.stepped += g - p.y;
    p.y = g; p.vy = 0; // snap down stairs instead of bouncing off each tread
  } else {
    p.vy = Math.max(-MAX_FALL, p.vy - GRAVITY * dt);
    p.y += p.vy * dt;
    if (p.y <= g) { p.y = g; p.vy = 0; p.grounded = true; } else p.grounded = false;
  }
  return p;
}
