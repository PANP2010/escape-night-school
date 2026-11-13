// The campus nav graph (shared/campus/nav.ts) built from the interior routes (interior.ts roomRoute / bridgeRoute:
// corridor centrelines, doors, stairs, entrances) plus an outdoor grid tying the entrances together; every edge is
// walked once with the players' capsule, which also gives each node its feet height. Plus the server's spawn points.
import { CollisionWorld, groundHeight, overlaps } from '../../../../shared/campus/collision.ts';
import { NAV_CAPSULE, NavGraph, walk, type NavNode } from '../../../../shared/campus/nav.ts';
import { floorStack } from '../../../../shared/campus/campus_schema.ts';
import { CAMPUS, GROUND, campusColliders, groundlessFootprints } from './campus.ts';
import { bridgeRoute, classroomRoute, roomRoute } from './interior.ts';
import { storeyRooms } from './rooms.ts';

/** The campus colliders as a CollisionWorld (gate closed, as built), basement footprints without ground. */
export function campusWorld(): CollisionWorld {
  const w = new CollisionWorld(campusColliders());
  for (const h of groundlessFootprints()) w.addHole(h.x0, h.x1, h.z0, h.z1);
  return w;
}

const OUT_STEP = 4;
const inFootprint = (x: number, z: number, m = 0) =>
  CAMPUS.buildings.some(b => Math.abs(x - b.x) < b.w / 2 + m && Math.abs(z - b.z) < b.d / 2 + m);

export interface CampusNav { graph: NavGraph; world: CollisionWorld; /** routes that threw or couldn't be walked */ failures: string[] }

export function campusNav(world = campusWorld()): CampusNav {
  const graph = new NavGraph(), failures: string[] = [];
  const add = (label: string, pts: [number, number][], y0: number, last?: Partial<NavNode>) => {
    const ys = walk(world, { x: pts[0][0], y: y0, z: pts[0][1] }, pts.slice(1));
    if (!ys) { failures.push(label); return null; }
    const nodes: NavNode[] = pts.map(([x, z], i) => ({ x, z, y: i ? ys[i - 1] : y0 }));
    Object.assign(nodes[nodes.length - 1], last);
    return graph.chain(nodes);
  };
  const heads: number[] = [];
  for (const b of CAMPUS.buildings) for (const { level, y } of floorStack(b)) {
    for (const r of storeyRooms(b, level)) {
      if (r.kind === 'corridor' || r.kind === 'stairs') continue;
      const label = `${b.id}:${level}:${r.id}`;
      let pts: [number, number][];
      // a room without doors of its own is only reachable when an entrance opens into it (门卫室)
      try { pts = roomRoute(b, level, r.id); } catch { if (r.doors?.length) failures.push(label); continue; }
      const y0 = groundHeight(world, pts[0][0], pts[0][1], 0.05, 1), last = { tag: `${b.id}:${level}`, room: r.id, y };
      let ids = add(label, pts, y0, last);
      // an open-plan area (礼堂 seats): its centre is among the seat rows, so it ends where its aisle does
      while (!ids && !r.doors?.length && pts.length > 2) { failures.pop(); pts = pts.slice(0, -1); ids = add(label, pts, y0, last); }
      if (ids) heads.push(ids[0]);
    }
  }
  for (const def of CAMPUS.bridges ?? []) {
    const [p, q] = def.between.map(id => CAMPUS.buildings.find(b => b.id === id)!);
    const room = (b: typeof p) => storeyRooms(b, def.level).find(r => r.kind !== 'corridor' && r.kind !== 'stairs' && r.doors?.length)?.id;
    const from = room(p), to = room(q), y = floorStack(p).find(s => s.level === def.level)!.y;
    let pts: [number, number][] | null = null;
    for (const [f, t, rev] of [[from, to, false], [to, from, true], [from, to, true], [to, from, false]] as const) {
      try { if (f && t) { pts = bridgeRoute(CAMPUS, def.id, f, t, rev); break; } } catch { /* other orientation */ }
    }
    if (!pts) { failures.push(def.id); continue; }
    add(def.id, pts, groundHeight(world, pts[0][0], pts[0][1], 0.05, y + 0.5));
  }
  // outdoor grid: capsule-clear points outside the buildings, linked to their walkable right / down neighbours
  const [sx, sz] = GROUND.size, [cx, cz] = GROUND.center, grid = new Map<string, number>();
  for (let i = 0; cx - sx / 2 + i * OUT_STEP < cx + sx / 2; i++) for (let j = 0; cz - sz / 2 + j * OUT_STEP < cz + sz / 2; j++) {
    const x = cx - sx / 2 + i * OUT_STEP, z = cz - sz / 2 + j * OUT_STEP;
    if (inFootprint(x, z, 0.5)) continue;
    const y = groundHeight(world, x, z, 0.05, 1);
    if (y < -1 || overlaps(world, { x, y, z, vy: 0, grounded: true }, NAV_CAPSULE)) continue;
    grid.set(i + ',' + j, graph.addNode({ x, y, z, tag: 'out' }));
  }
  const tryLink = (a: number, b: number) => {
    const p = graph.nodes[a], q = graph.nodes[b], ys = walk(world, p, [[q.x, q.z]]);
    if (!ys || Math.abs(ys[0] - q.y) >= 0.3) return;
    // walk() slides around thin obstacles; the straight edge itself (what the AI follows) must be capsule-clear too
    const n = Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / 0.1);
    for (let k = 1; k < n; k++) {
      const t = k / n, y = p.y + (q.y - p.y) * t;
      if (overlaps(world, { x: p.x + (q.x - p.x) * t, y, z: p.z + (q.z - p.z) * t, vy: 0, grounded: true }, NAV_CAPSULE)) return;
    }
    graph.link(a, b);
  };
  for (const [k, id] of grid) {
    const [i, j] = k.split(',').map(Number);
    for (const n of [`${i + 1},${j}`, `${i},${j + 1}`]) if (grid.has(n)) tryLink(id, grid.get(n)!);
  }
  // entrances (each route's first point, 1 m outside) onto the grid nodes around them
  for (const h of new Set(heads)) {
    const p = graph.nodes[h], i = Math.round((p.x - cx + sx / 2) / OUT_STEP), j = Math.round((p.z - cz + sz / 2) / OUT_STEP);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const g = grid.get(`${i + di},${j + dj}`);
      if (g !== undefined) tryLink(h, g);
    }
  }
  return { graph, world, failures };
}

/** World (x, z) waypoints from 教学楼A's ground-floor entrance hall into its first 教室 (2 m past the door). */
export const spawnRoute = (): [number, number][] => classroomRoute(CAMPUS.buildings.find(b => b.id === 'A')!, 1).slice(2);

/** Player spawns: inside 教学楼A's entrance, spread along the hall line towards the corridor. */
export function campusSpawns(n = 4): { x: number; z: number }[] {
  const [a, b] = spawnRoute();
  return Array.from({ length: n }, (_, k) => {
    const t = (k + 0.5) / n * 0.8;
    return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t };
  });
}
