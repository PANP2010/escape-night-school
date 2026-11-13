import { NAV_CAPSULE, type NavGraph } from '../shared/campus/nav.ts';

/** The campus room routes can slide diagonally around OFF's stair enclosure when baked.
 * An actual walker (and Warden's straight graph edges) needs a square turn through the 1.6 m doorway.
 * Re-route only L4's edges crossing the enclosure's west wall through the centre of each storey's doorway. */
export function l4StairDoors(graph: NavGraph): void {
  const crossings: [number, number][] = [];
  graph.adj.forEach((links, i) => { for (const j of links) if (i < j) {
    const a = graph.nodes[i], b = graph.nodes[j];
    if (Math.abs(a.y - b.y) >= .1 || !((a.x < -13 && b.x > -12.8) || (b.x < -13 && a.x > -12.8))) continue;
    // The east corridor also crosses this x coordinate south of the enclosure. Its legal edges must
    // stay in that corridor: routing them to the stair door would cut through the south wall.
    const z = a.z + (b.z - a.z) * (-13 - a.x) / (b.x - a.x);
    if (z >= 131.3 && z <= 137) crossings.push([i, j]);
  } });
  const doors = new Map<number, [number, number]>();
  for (const [i, j] of crossings) {
    const a = graph.nodes[i], y = Math.abs(a.y - 7.2) < .1 ? 7.2 : 10.8;
    let ids = doors.get(y);
    if (!ids) {
      ids = [graph.addNode({ x: -13.65, y, z: 134.13 }), graph.addNode({ x: -12.1, y, z: 134.13 })];
      graph.link(...ids); doors.set(y, ids);
    }
    graph.adj[i] = graph.adj[i].filter(k => k !== j); graph.adj[j] = graph.adj[j].filter(k => k !== i);
    graph.link(i, ids[a.x < -13 ? 0 : 1]); graph.link(j, ids[a.x < -13 ? 1 : 0]);
  }

  // The baked walker gives only the flight's endpoints. Warden interpolates their heights, so a
  // single slope spanning the flat landings puts his feet inside the upper treads. Match the
  // two actual 3F→4F flights: 0.28 m treads rise 0.15 m, with flat landings at either end.
  // Start each rise one capsule radius before the first tread reaches the monster's feet.
  const flights = [
    { z: 132.74, westY: 7.2, eastY: 9, westX: -11.2 - NAV_CAPSULE.radius, eastX: -8.12 },
    { z: 135.52, westY: 10.8, eastY: 9, westX: -11.2, eastX: -8.12 + NAV_CAPSULE.radius },
  ];
  for (const flight of flights) {
    const links: [number, number][] = [];
    graph.adj.forEach((neighbors, i) => { for (const j of neighbors) if (i < j) {
      const a = graph.nodes[i], b = graph.nodes[j], west = a.x < b.x ? a : b, east = a.x < b.x ? b : a;
      if (Math.abs(a.z - flight.z) < .05 && Math.abs(b.z - flight.z) < .05 &&
        Math.abs(west.y - flight.westY) < .05 && Math.abs(east.y - flight.eastY) < .05 &&
        west.x < flight.westX && east.x > flight.eastX) links.push([i, j]);
    } });
    for (const [i, j] of links) {
      const west = graph.nodes[i].x < graph.nodes[j].x ? i : j, east = west === i ? j : i;
      graph.adj[i] = graph.adj[i].filter(k => k !== j); graph.adj[j] = graph.adj[j].filter(k => k !== i);
      const w = graph.addNode({ x: flight.westX, y: flight.westY, z: flight.z });
      const e = graph.addNode({ x: flight.eastX, y: flight.eastY, z: flight.z });
      graph.link(west, w); graph.link(w, e); graph.link(e, east);
    }
  }
}
