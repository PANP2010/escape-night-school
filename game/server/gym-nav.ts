import campusData from '../shared/campus/colliders.json';
import { CollisionWorld, groundHeight, overlaps, type AABB } from '../shared/campus/collision.ts';
import { NavGraph, NAV_CAPSULE, walk } from '../shared/campus/nav.ts';
import { campusDoorSlab, type DoorSpot } from '../shared/doors.ts';
import { levelSolids, type Level } from '../shared/level.ts';

/** Open hall needs a grid (the campus tour graph has only one room-centre chain).
 * Add the narrow equipment doorway explicitly, and real stair-height nodes on the bleachers. */
export function gymAreaNav(lv: Level): NavGraph {
  const def = lv.def.gym!;
  const w = new CollisionWorld([...(campusData.colliders as AABB[]), ...levelSolids(lv.def),
    ...(campusData.doors as DoorSpot[]).filter((d) => d.id !== def.equipmentDoor).map((d) => campusDoorSlab(d, false))]);
  const g = new NavGraph(), a = lv.def.area;
  const add = (x: number, z: number, maxY = 0.1) => {
    // A grounded capsule immediately steps onto any support within stepHeight.
    // Include that span so a floor-grid node cannot sit inside a low bleacher tread.
    const y = groundHeight(w, x, z, NAV_CAPSULE.radius, maxY + NAV_CAPSULE.stepHeight);
    if (y > maxY || overlaps(w, { x, y, z, vy: 0, grounded: true }, NAV_CAPSULE)) return;
    g.addNode({ x, y, z });
  };
  for (let x = a.x0 + 0.75; x < a.x1 - 0.5; x += 1) for (let z = a.z0 + 0.75; z < a.z1 - 0.5; z += 1) add(x, z);
  for (const z of [49.6, 50.4, 51.24, 52.1, 53]) add(def.ballSpawn.x, z);
  for (const s of def.switches) add(s.x, s.z);
  for (const s of def.stands) {
    add(s.x + s.w / 2, s.z - 0.4);
    for (let i = 0; i < s.rows; i++) add(s.x + s.w / 2, s.z + (i + 0.5) * s.run, (i + 1) * s.rise + 0.04);
  }
  for (let i = 0; i < g.nodes.length; i++) for (let j = i + 1; j < g.nodes.length; j++) {
    const a = g.nodes[i], b = g.nodes[j];
    if (Math.hypot(a.x - b.x, a.z - b.z) > 1.5 || Math.abs(a.y - b.y) > 0.25) continue;
    const ys = walk(w, a, [[b.x, b.z]]), back = walk(w, b, [[a.x, a.z]]);
    if (ys && back && Math.abs(ys[0] - b.y) < 0.1 && Math.abs(back[0] - a.y) < 0.1) g.link(i, j);
  }
  return g;
}
