import campusData from '../shared/campus/colliders.json';
import { CollisionWorld, groundHeight, overlaps, type AABB } from '../shared/campus/collision.ts';
import { NavGraph, NAV_CAPSULE, walk } from '../shared/campus/nav.ts';
import { inBounds, levelSolids, type Level } from '../shared/level.ts';

/** The authored middle leaf opens after roll call. Side walls remain solid. */
export const isFinaleGateLeaf = (b: AABB) => b.minX >= -4.81 && b.maxX <= 4.81
  && b.minZ >= -8.2 && b.maxZ <= -7.8 && b.minY === 0 && b.maxY <= 1.6;

/** The campus tour's 4 m outdoor grid misses the two-metre escape path.
 * Plan on the opened-gate route; live door/gate authority still validates every actual move. */
export function finaleAreaNav(lv: Level): NavGraph {
  const def = lv.def.finale!;
  const world = new CollisionWorld([
    ...(campusData.colliders as AABB[]).filter(b => !isFinaleGateLeaf(b)), ...levelSolids(lv.def),
  ]);
  for (const h of campusData.holes) world.addHole(h.x0, h.x1, h.z0, h.z1);
  const graph = new NavGraph();
  const add = (x: number, z: number, y = 0) => {
    const ground = groundHeight(world, x, z, NAV_CAPSULE.radius, y + NAV_CAPSULE.stepHeight);
    if (Math.abs(ground - y) > NAV_CAPSULE.stepHeight || !inBounds(lv, x, ground, z)
      || overlaps(world, { x, y: ground, z, vy: 0, grounded: true }, NAV_CAPSULE)) return;
    graph.addNode({ x, y: ground, z, tag: 'finale' });
  };
  for (const r of lv.def.regions ?? [lv.def.area]) {
    for (let x = Math.ceil(r.x0); x <= Math.floor(r.x1); x++)
      for (let z = Math.ceil(r.z0); z <= Math.floor(r.z1); z++) add(x, z);
  }
  for (const [i, a] of def.route.entries()) {
    add(a.x, a.z, a.y);
    const b = def.route[i + 1];
    if (!b) continue;
    const count = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z));
    for (let k = 1; k < count; k++) add(a.x + (b.x - a.x) * k / count, a.z + (b.z - a.z) * k / count, a.y);
  }
  for (const p of [...lv.spawns, def.chaseSpawn, lv.exit]) add(p.x, p.z, p.y ?? 0);
  add(def.rollcall.x, def.rollcall.z + 1.45, def.rollcall.y);
  const bins = new Map<string, number[]>();
  const bin = (x: number, z: number) => `${x},${z}`;
  const clear = (a: number, b: number) => {
    const from = graph.nodes[a], to = graph.nodes[b], ys = walk(world, from, [[to.x, to.z]]);
    return !!ys && Math.abs(ys[0] - to.y) < .1;
  };
  for (const [i, n] of graph.nodes.entries()) {
    const bx = Math.floor(n.x / 1.5), bz = Math.floor(n.z / 1.5);
    for (let x = bx - 1; x <= bx + 1; x++) for (let z = bz - 1; z <= bz + 1; z++) {
      for (const j of bins.get(bin(x, z)) ?? []) {
        if (graph.dist(i, j) <= 1.5 && clear(i, j) && clear(j, i)) graph.link(i, j);
      }
    }
    const key = bin(bx, bz);
    if (!bins.has(key)) bins.set(key, []);
    bins.get(key)!.push(i);
  }
  // Do not send unreachable room fragments to the route guide or the pursuer.
  const sp = lv.spawns[0], start = graph.nearest(sp.x, sp.y ?? 0, sp.z);
  const reached = graph.reachable(start);
  const kept = new Set([...reached].map(i => graph.nodes[i]));
  return graph.subgraph(n => kept.has(n));
}
