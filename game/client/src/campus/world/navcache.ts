// Server-side disk cache for campusNav() (~29 s to build). Keyed by a hash of the campus data so edits rebuild it.
// Kept apart from navgraph.ts because that file is also bundled into the client.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { NavGraph } from '../../../../shared/campus/nav.ts';
import { CAMPUS, GROUND, campusColliders, groundlessFootprints } from './campus.ts';
import { campusNav, campusWorld, type CampusNav } from './navgraph.ts';

const campusKey = () => createHash('sha1').update(JSON.stringify([CAMPUS, GROUND, campusColliders(), groundlessFootprints()])).digest('hex');

/** campusNav() loaded from `file` when its key matches, else built and written there. */
export function campusNavCached(file: string): CampusNav {
  const key = campusKey();
  if (existsSync(file)) {
    try {
      const d = JSON.parse(readFileSync(file, 'utf8'));
      if (d.key === key) {
        const graph = new NavGraph();
        graph.nodes.push(...d.nodes); graph.adj.push(...d.adj);
        return { graph, world: campusWorld(), failures: d.failures };
      }
    } catch { /* corrupt cache: rebuild */ }
  }
  const nav = campusNav();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ key, nodes: nav.graph.nodes, adj: nav.graph.adj, failures: nav.failures }));
  return nav;
}
