import campusData from './campus/colliders.json';
import { CollisionWorld, overlaps, type AABB } from './campus/collision.ts';
import { NAV_CAPSULE, walk, type NavGraph, type NavNode } from './campus/nav.ts';
import { levelSolids, type Level } from './level.ts';

/** The blackout floor's corridor goes around its blocked east stair entrance. */
export function connectBlackoutCorridor(graph: NavGraph, lv: Level, doorsShut: CollisionWorld): NavGraph {
  const blackout = lv.def.blackout;
  if (!blackout) return graph;
  const world = new CollisionWorld([...(campusData.colliders as AABB[]), ...levelSolids(lv.def)]);
  for (const h of campusData.holes) world.addHole(h.x0, h.x1, h.z0, h.z1);

  // Campus routes predate the level barriers. Keep openable door links, but remove legs a permanent solid cuts.
  for (let i = 0; i < graph.nodes.length; i++) for (const j of [...graph.adj[i]]) {
    if (j <= i || clearLeg(world, graph.nodes[i], graph.nodes[j])) continue;
    graph.adj[i] = graph.adj[i].filter((k) => k !== j);
    graph.adj[j] = graph.adj[j].filter((k) => k !== i);
  }

  const spawn = lv.spawns[0], y = spawn.y ?? 0;
  // Between the spawn row and the fuse-box wall, clear of the stair barricade's north edge.
  const z = (spawn.z + blackout.fuseBox.z) / 2;
  const original = graph.nodes.length;
  const xs = [...new Set([
    lv.exit.x, blackout.fuseBox.x, ...lv.spawns.map((p) => p.x),
    ...graph.nodes.filter((n) => Math.abs(n.y - y) < 0.1).map((n) => n.x),
  ])].sort((a, b) => a - b);
  const corridor: number[] = [];
  for (const x of xs) {
    const n = { x, y, z };
    if (!overlaps(doorsShut, { ...n, vy: 0, grounded: true }, NAV_CAPSULE)) corridor.push(graph.addNode(n));
  }
  const link = (a: number, b: number) => {
    if (clearLeg(doorsShut, graph.nodes[a], graph.nodes[b])) graph.link(a, b);
  };
  for (let i = 1; i < corridor.length; i++) link(corridor[i - 1], corridor[i]);
  for (let i = 0; i < original; i++) {
    const n = graph.nodes[i];
    if (Math.abs(n.y - y) > 0.1) continue;
    const projection = corridor.find((j) => Math.abs(graph.nodes[j].x - n.x) < 0.05);
    if (projection !== undefined) link(i, projection);
  }
  // The campus also supplies nodes beyond the sealed stairs and outside the west grate. They cannot be goals
  // on this floor: keeping them lets nearest() select a point with no route back to the playable corridor.
  const reached = graph.reachable(graph.nearest(spawn.x, y, spawn.z));
  const kept = new Set([...reached].map((i) => graph.nodes[i]));
  return graph.subgraph((n) => kept.has(n));
}

function clearLeg(world: CollisionWorld, a: NavNode, b: NavNode): boolean {
  const ys = walk(world, a, [[b.x, b.z]]);
  if (!ys || Math.abs(ys[0] - b.y) > 0.1) return false;
  if (Math.abs(a.y - b.y) > 0.1) return true; // Existing stair legs follow their treads.
  // walk() can slide around an obstacle; an arrow's straight leg must clear the whole capsule too.
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.1));
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    if (overlaps(world, { x: a.x + (b.x - a.x) * t, y: a.y, z: a.z + (b.z - a.z) * t, vy: 0, grounded: true }, NAV_CAPSULE)) return false;
  }
  return true;
}
