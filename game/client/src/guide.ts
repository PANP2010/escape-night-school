/**
 * 目标箭头 (#221 B): where the next objective is — the item (once seen), roughly its room (not yet seen),
 * the fuse box, the exit — and the next corner of the nav-graph path towards it, as a marker / screen-edge
 * arrow with the distance. Pure: game.ts feeds it the level, the objective and the camera projection.
 */
import { NAV_CAPSULE, NavGraph } from '../../shared/campus/nav.ts';
import type { DoorSpot } from '../../shared/doors.ts';
import { inExit } from '../../shared/level.ts';
import type { LevelDef } from '../../shared/levels/def.ts';
import type { WorldItem } from '../../shared/protocol.ts';
import type { Objective } from './objective.ts';
import type { BroadcastSnap } from '../../shared/broadcast.ts';
import { FLOOR_HEIGHT } from '../../shared/campus/campus_schema.ts';

type P = { x: number; y: number; z: number };

/** The server's 'nav' message (cm, flat x y z) as a graph; null when malformed. */
export function navFromMsg(n: unknown, adj: unknown): NavGraph | null {
  if (!Array.isArray(n) || !Array.isArray(adj) || n.length % 3 || adj.length !== n.length / 3 || !adj.length) return null;
  const g = new NavGraph(), count = adj.length;
  for (let i = 0; i < count; i++) {
    const [x, y, z] = [n[i * 3], n[i * 3 + 1], n[i * 3 + 2]];
    const a = adj[i];
    if (![x, y, z].every(Number.isFinite) || !Array.isArray(a) || !a.every((j) => Number.isInteger(j) && j >= 0 && j < count && j !== i)) return null;
    g.nodes.push({ x: x / 100, y: y / 100, z: z / 100 });
    g.adj.push([...a]);
  }
  return g;
}

/** The point the arrow leads to; `exact` false = only the rough spot (an item nobody has seen yet); `arrived`: the last step and already in the exit zone. */
export interface Goal extends P {
  exact: boolean;
  item?: number;
  arrived?: true;
  /** Wall props are aimed at their visible centre, with routing anchored to their actual storey and approach. */
  floorY?: number;
  approach?: P;
  label?: string;
}

/** L4: shared unread clues, chosen by a reachable walking route rather than their password order. */
export function broadcastGoalPoint(def: LevelDef, station: Pick<BroadcastSnap, 'off' | 'clues'> | undefined, from: P,
  graph?: NavGraph | null, los?: (a: P, b: P) => boolean): Goal | null {
  const broadcast = def.broadcast;
  if (!broadcast) return null;
  const floor = (y: number) => `${Math.round(y / FLOOR_HEIGHT) + 1}楼`;
  if (station?.off) return { ...def.exit, exact: true, label: `集合点 · ${floor(def.exit.y)}`,
    ...(inExit(def, from.x, from.y, from.z) && { arrived: true as const }) };
  const unread = broadcast.stickers.flatMap((s, i) => station?.clues[i] != null ? [] : [{
    x: s.x, y: s.y + 1.45, z: s.z, floorY: s.y, exact: true,
    approach: { x: s.x, y: s.y, z: s.z + (s.face === 'z+' ? .65 : -.65) },
    label: `贴纸${['①', '②', '③', '④'][i] ?? i + 1} · ${floor(s.y)}`,
  }]);
  if (!unread.length) {
    const p = broadcast.console;
    return { x: p.x, y: p.y + 1.25, z: p.z - .18, floorY: p.y,
      approach: { x: p.x, y: p.y, z: p.z - .8 }, exact: true, label: `广播室 · ${floor(p.y)}` };
  }
  const routes = graph?.nodes.length ? distTo(graph, seenNearest(graph, from, los)) : null;
  let best: Goal | null = null, distance = Infinity;
  for (const target of unread) {
    const p = target.approach;
    let d = Math.hypot(p.x - from.x, 3 * (p.y - from.y), p.z - from.z);
    if (routes && graph) {
      const i = seenNearest(graph, p, los), n = graph.nodes[i];
      d = routes[i] + Math.hypot(n.x - p.x, n.y - p.y, n.z - p.z);
    }
    if (d < distance) { best = target; distance = d; }
  }
  return best;
}

/**
 * The current step's target: L1 the stair key, 停电关 the fuses (a seen one first, else the nearest by walking route) then the
 * fuse box, last the exit. An unseen item gives the nav node nearest to it (its room) instead of its spot.
 */
export function goalPoint(def: LevelDef, o: Objective, items: readonly WorldItem[], seen: ReadonlySet<number>, from: P, graph?: NavGraph | null): Goal | null {
  const last = o.cur >= o.steps.length - 1, bo = def.blackout;
  if (last) return { x: def.exit.x, y: def.exit.y, z: def.exit.z, exact: true, ...(inExit(def, from.x, from.y, from.z) && { arrived: true as const }) };
  if (def.exam) return { ...def.exam.paper, exact: true };
  if (o.target) return { ...o.target, exact: true };
  if (bo && o.cur === 1) return { x: bo.fuseBox.x, y: bo.fuseBox.y, z: bo.fuseBox.z, exact: true };
  const kind = bo ? 'fuse' : o.cur === 0 ? 'drawer_key' : 'stair_key';
  const cands = items.filter((it) => it.kind === kind && !it.decoy);
  if (!cands.length) return null;
  const d = (it: WorldItem) => Math.hypot(it.p[0] - from.x, 3 * (it.p[1] - from.y), it.p[2] - from.z);
  const known = cands.filter((it) => seen.has(it.id));
  // A fuse in the next room can be closer through its wall while its doorway is the long way round. Choose the
  // rough room by the same graph the arrow follows; as the player walks that route, another room won't steal it.
  const routes = !known.length && graph?.nodes.length ? distTo(graph, graph.nearest(from.x, from.y, from.z)) : null;
  const distance = (it: WorldItem) => {
    if (!routes || !graph) return d(it);
    const i = graph.nearest(it.p[0], it.p[1], it.p[2]), n = graph.nodes[i];
    return routes[i] + Math.hypot(n.x - it.p[0], 3 * (n.y - it.p[1]), n.z - it.p[2]);
  };
  const it = (known.length ? known : cands).reduce((a, b) => (distance(b) < distance(a) ? b : a));
  if (seen.has(it.id) || !graph?.nodes.length) return { x: it.p[0], y: it.p[1], z: it.p[2], exact: seen.has(it.id), item: it.id };
  const nd = graph.nodes[graph.nearest(it.p[0], it.p[1], it.p[2])];
  return { x: nd.x, y: nd.y, z: nd.z, exact: false, item: it.id };
}

/** Clear walk-ish line a → b: three knee-high rays (centre and ±`half` m sideways), `los` is the collider test. */
export function wideLos(los: (a: P, b: P) => boolean, a: P, b: P, half = 0.35, knee = 0.5): boolean {
  const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1, sx = (-dz / l) * half, sz = (dx / l) * half;
  for (const s of [0, 1, -1]) {
    if (!los({ x: a.x + sx * s, y: a.y + knee, z: a.z + sz * s }, { x: b.x + sx * s, y: b.y + knee, z: b.z + sz * s })) return false;
  }
  return true;
}

/** How many path nodes ahead the waypoint may skip to (when the line to them is clear). */
export const LOOKAHEAD = 5;

/** A goal up to this many m above the feet (an item on a desk / lectern, 1.15 m) is on the same storey. */
export const ON_TOP = 1.8;

/** A goal on the same storey within this many m (flat) and in eye-high view is led to straight: the desk rows between
 *  block the knee rays (to it and to the room's node) and the path would lead out of the room and back. */
export const NEAR_GOAL = 3;

/** The nearest node to `p` in sight of it (same storey, within `r` m), else simply the nearest: never one through a wall. */
export function seenNearest(graph: NavGraph, p: P, los?: (a: P, b: P) => boolean, r = 12): number {
  if (!los) return graph.nearest(p.x, p.y, p.z);
  const lift = (q: P) => ({ x: q.x, y: q.y + 0.5, z: q.z });
  // nearest first (graph.nearest's metric, ties to the lower index), so the LOS rays stop at the first one in sight
  const near: [number, number][] = [];
  graph.nodes.forEach((n, i) => {
    if (Math.abs(n.y - p.y) < 1 && (n.x - p.x) ** 2 + (n.z - p.z) ** 2 < r * r) near.push([(n.x - p.x) ** 2 + (3 * (n.y - p.y)) ** 2 + (n.z - p.z) ** 2, i]);
  });
  near.sort((u, v) => u[0] - v[0] || u[1] - v[1]);
  for (const [, i] of near) if (los(lift(p), lift(graph.nodes[i]))) return i;
  // none in sight (a node-less strip, the path out round a wall's end): the node in sight from the far end of one of
  // 16 rays, shortest over both legs, so the arrow leads along the wall to the opening, not through it
  const o = lift(p);
  let best = -1, bestD = Infinity;
  for (let a = 0; a < 16; a++) {
    const dx = Math.cos((a * Math.PI) / 8), dz = Math.sin((a * Math.PI) / 8);
    let d = 0;
    while (d < r && los(o, { x: o.x + dx * (d + 0.5), y: o.y, z: o.z + dz * (d + 0.5) })) d += 0.5;
    if (d < 1) continue;
    const s = { x: o.x + dx * (d - 0.3), y: o.y, z: o.z + dz * (d - 0.3) };
    for (const [, i] of near) {
      const n = graph.nodes[i], t = d - 0.3 + Math.hypot(n.x - s.x, n.z - s.z);
      if (t < bestD && los(s, lift(n))) { best = i; bestD = t; }
    }
  }
  return best >= 0 ? best : graph.nearest(p.x, p.y, p.z);
}

/** Walking distance from every node to `b` over the graph (Infinity where cut off): Dijkstra, the graph is undirected. */
export function distTo(graph: NavGraph, b: number): number[] {
  const d = graph.nodes.map(() => Infinity), done = graph.nodes.map(() => false);
  d[b] = 0;
  for (;;) {
    let cur = -1;
    for (let i = 0; i < d.length; i++) if (!done[i] && d[i] < Infinity && (cur < 0 || d[i] < d[cur])) cur = i;
    if (cur < 0) return d;
    done[cur] = true;
    for (const n of graph.adj[cur]) d[n] = Math.min(d[n], d[cur] + graph.dist(cur, n));
  }
}

/**
 * The node to start the path at from `p`: of those in sight (same storey, within `r` m) the one with the shortest
 * walk via it (straight there + `d` on), so a nearer node off the way round (the corridor node with no link on
 * towards the goal) doesn't send the arrow back; none in sight: seenNearest.
 */
export function bestStart(graph: NavGraph, p: P, d: readonly number[], los?: (a: P, b: P) => boolean, r = 12): number {
  if (!los) return seenNearest(graph, p);
  const lift = (q: P) => ({ x: q.x, y: q.y + 0.5, z: q.z });
  // Check wall corners across the player's width at eye height. Low furniture can cover the knee shoulders
  // beside an otherwise clear aisle; treating that as a wall sends the route back out of the room.
  const clear = (a: P, b: P) => los(a, b) && wideLos(los, a, b, NAV_CAPSULE.radius, 0.7);
  let best = -1, bestT = Infinity;
  graph.nodes.forEach((n, i) => {
    const h = Math.hypot(n.x - p.x, n.z - p.z), t = h + d[i];
    if (Math.abs(n.y - p.y) < 1 && h < r && t < bestT && clear(lift(p), lift(n))) { best = i; bestT = t; }
  });
  return best >= 0 ? best : seenNearest(graph, p, clear, r);
}

/**
 * The next point to walk to towards `goal` (feet `from`) and the walking distance there: the goal itself when
 * the line is clear on the same storey, else the furthest clear node of the A* path within LOOKAHEAD (at least
 * the one after the node underfoot). The path ends at the goal's nearest node in sight (seenNearest) and starts at
 * the node in sight with the shortest walk via it (bestStart).
 */
export function guideWaypoint(graph: NavGraph | null | undefined, from: P, goal: P & Pick<Goal, 'arrived' | 'floorY' | 'approach'>, los?: (a: P, b: P) => boolean, shut?: (a: P, b: P) => P | null): P & { dist: number } {
  const straight = Math.hypot(goal.x - from.x, goal.y - from.y, goal.z - from.z);
  const clear = (a: P, b: P) => !los || wideLos(los, a, b);
  const up = (goal.floorY ?? goal.y) - from.y, here = up > -1 && up < ON_TOP;
  const flat = Math.hypot(goal.x - from.x, goal.z - from.z);
  const inView = () => !los || los({ x: from.x, y: from.y + 1.2, z: from.z }, { x: goal.x, y: goal.y + 0.3, z: goal.z });
  // in the exit zone the stairwell walls block the rays: the path would lead back out to the nearest node in sight
  if (goal.arrived || !graph?.nodes.length || (here && (clear(from, goal) || (flat < NEAR_GOAL && inView())))) return { x: goal.x, y: goal.y, z: goal.z, dist: straight };
  // an item on a desk / lectern: its node is on the floor under it
  const endpoint = goal.approach ?? { x: goal.x, y: goal.floorY ?? (here ? from.y : goal.y), z: goal.z };
  const b = seenNearest(graph, endpoint, los), d = distTo(graph, b);
  const a = bestStart(graph, from, d, los);
  // down the distances from a to b: a shortest path, as astar would give
  const path = d[a] < Infinity ? [a] : null;
  while (path && path[path.length - 1] !== b) {
    const c = path[path.length - 1];
    path.push(graph.adj[c].reduce((u, v) => (d[v] + graph.dist(c, v) < d[u] + graph.dist(c, u) ? v : u)));
  }
  if (!path) return { x: goal.x, y: goal.y, z: goal.z, dist: straight };
  const node = (i: number) => graph.nodes[path[i]];
  let k = 0;
  for (let i = Math.min(path.length - 1, LOOKAHEAD); i > 0; i--) {
    if (Math.abs(node(i).y - from.y) < 1 && clear(from, node(i))) { k = i; break; }
  }
  // nothing ahead in view (a shut door, the turn of a stair) and on the nearest node or on the way along the next leg
  // (past it, within 1 m of the leg): the next one, not underfoot (walking back to it, the door it leads through
  // never comes in reach to open: A → B → A); off the leg round a wall end: the node first, the next one's line clips the end
  const d0 = Math.hypot(node(0).x - from.x, node(0).z - from.z);
  const lx = path.length > 1 ? node(1).x - node(0).x : 0, lz = path.length > 1 ? node(1).z - node(0).z : 0, ll = Math.hypot(lx, lz) || 1;
  const along = ((from.x - node(0).x) * lx + (from.z - node(0).z) * lz) / ll, off = Math.abs((from.x - node(0).x) * lz - (from.z - node(0).z) * lx) / ll;
  // Beyond the existing arrival band, projection onto the next leg can cut across a wall corner.
  // Check the nearby capsule-width approach; an actual shut door remains the next interaction.
  const localLegClear = () => {
    if (!shut || d0 < 0.6 + NAV_CAPSULE.radius / 2 || Math.abs(node(1).y - from.y) >= 1) return true;
    const t = Math.min(ll, along + 1.5) / ll;
    const ahead = { x: node(0).x + lx * t, y: node(0).y, z: node(0).z + lz * t };
    return !los || wideLos(los, from, ahead, NAV_CAPSULE.radius) || !!shut(from, ahead);
  };
  if (!k && path.length > 1 && (d0 < 0.6 || (along > 0 && along < ll && off < 1 && localLegClear()))) k = 1;
  const w = node(k);
  // the path's last node and the goal out of the knee rays' sight (round the doorpost, behind the desk it is on): the
  // goal once standing on the node, or once past it (the goal nearer than from the node) and in view, so the arrow doesn't flip back
  const toW = Math.hypot(w.x - from.x, w.z - from.z), near = Math.hypot(goal.x - from.x, goal.z - from.z) < Math.hypot(goal.x - w.x, goal.z - w.z);
  // the node past a shut door (or the goal behind it) reads as「through the wall」: the door first, its「E 打开」is the next step
  // (or, the doorway node this side of it in reach, the leg after it goes through the door)
  const door = (p: P) => shut?.(from, p);
  const past = toW < 1.5 ? shut?.(w, k + 1 < path.length ? node(k + 1) : goal) : null;
  if (k === path.length - 1 && (toW < 1.5 || (here && near && inView()))) return { ...(door(goal) ?? past ?? { x: goal.x, y: goal.y, z: goal.z }), dist: straight };
  let dist = Math.hypot(w.x - from.x, w.y - from.y, w.z - from.z);
  for (let i = k + 1; i < path.length; i++) dist += graph.dist(path[i - 1], path[i]);
  const e = node(path.length - 1);
  dist += Math.hypot(goal.x - e.x, goal.y - e.y, goal.z - e.z);
  return { ...(door(w) ?? past ?? { x: w.x, y: w.y, z: w.z }), dist };
}

/** Where the flat walk from `a` to `b` meets a shut door on a's storey (the door's centre on the floor), or null. */
export function shutDoorOn(doors: readonly DoorSpot[], open: readonly boolean[], a: P, b: P): P | null {
  const dx = b.x - a.x, dz = b.z - a.z;
  let best: P | null = null, bt = Infinity;
  for (const d of doors) {
    const y = d.y0 ?? 0;
    if (open[d.id] || Math.abs(a.y - y) > 1.2) continue;
    // slab test of the segment against the door's box
    let t0 = 0, t1 = 1;
    for (const [o, v, lo, hi] of [[a.x, dx, d.box.x0, d.box.x1], [a.z, dz, d.box.z0, d.box.z1]]) {
      if (Math.abs(v) < 1e-9) { if (o < lo || o > hi) t0 = Infinity; continue; }
      const u = (lo - o) / v, w = (hi - o) / v;
      t0 = Math.max(t0, Math.min(u, w)); t1 = Math.min(t1, Math.max(u, w));
    }
    if (t0 <= t1 && t0 < bt) { bt = t0; best = { x: d.x, y, z: d.z }; }
  }
  return best;
}

/** The arrow's text once in the exit zone (Goal.arrived): stay, the level ends when everyone is in. */
export const ARRIVED = '到了，等队友';
/** 「12 m」, or 「约 15 m」 (to 5 m) for a rough goal. */
export const distText = (m: number, exact: boolean) => (exact ? `${Math.max(1, Math.round(m))} m` : `约 ${Math.max(5, Math.round(m / 5) * 5)} m`);

/**
 * Screen placement of the arrow for a point at NDC (nx, ny) (`behind` = it's behind the camera) in a w × h
 * view: on screen → the marker there (`on`), else the edge of the view inset by `margin`, pointing at it.
 * The bottom also reserves the distance tag, control hint and a phone's home indicator.
 * `a` is the arrow's angle in degrees, 0 = up, positive clockwise (right).
 */
export function edgeArrow(nx: number, ny: number, behind: boolean, w: number, h: number, margin: number): { x: number; y: number; a: number; on: boolean } {
  const hw = w / 2, hh = h / 2;
  // Below 700 px the hint may wrap to two 17 px lines. Phones also reserve up to 34 px for the home indicator;
  // the tag reaches 37 px below its marker and needs 6 px clear of the hint. No DOM reads in this per-frame path.
  const footer = Math.max(0, Math.min(hh - 1, Math.max(margin, w < 700 ? 118 : w < 900 ? 100 : 70)));
  let dx = nx * hw, dy = -ny * hh; // px from the centre, y down
  if (!behind && Math.abs(dx) <= hw - margin && dy >= -hh + margin && dy <= hh - footer) return { x: hw + dx, y: hh + dy, a: 0, on: true };
  if (behind) { dx = -dx; dy = -dy; if (Math.abs(dy) < 1e-6 && Math.abs(dx) < 1e-6) dy = hh; }
  const s = Math.min((hw - margin) / Math.max(Math.abs(dx), 1e-6), (hh - (dy > 0 ? footer : margin)) / Math.max(Math.abs(dy), 1e-6));
  return { x: hw + dx * s, y: hh + dy * s, a: (Math.atan2(dx, -dy) * 180) / Math.PI, on: false };
}

export interface ScreenRect { left: number; top: number; right: number; bottom: number }

/** Move the whole arrow + its measured label clear of touch controls, preserving its destination bearing. */
export function avoidArrowControls(arrow: ReturnType<typeof edgeArrow>, w: number, h: number,
  footprint: ScreenRect, blocked: readonly ScreenRect[], gap = 8): ReturnType<typeof edgeArrow> {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const x0 = gap - footprint.left, x1 = w - gap - footprint.right;
  const y0 = gap - footprint.top, y1 = h - gap - footprint.bottom;
  if (arrow.x >= x0 && arrow.x <= x1 && arrow.y >= y0 && arrow.y <= y1
    && !blocked.some(b => arrow.x + footprint.right > b.left - gap && arrow.x + footprint.left < b.right + gap
      && arrow.y + footprint.bottom > b.top - gap && arrow.y + footprint.top < b.bottom + gap)) return arrow;
  const xs = [clamp(arrow.x, x0, x1)], ys = [clamp(arrow.y, y0, y1)];
  for (const b of blocked) {
    xs.push(clamp(b.left - gap - footprint.right, x0, x1), clamp(b.right + gap - footprint.left, x0, x1));
    ys.push(clamp(b.top - gap - footprint.bottom, y0, y1), clamp(b.bottom + gap - footprint.top, y0, y1));
  }
  let best: { x: number; y: number } | undefined, score = Infinity;
  for (const x of xs) for (const y of ys) {
    const d = (x - arrow.x) ** 2 + (y - arrow.y) ** 2;
    if (d >= score || blocked.some(b => x + footprint.right > b.left - gap && x + footprint.left < b.right + gap
      && y + footprint.bottom > b.top - gap && y + footprint.top < b.bottom + gap)) continue;
    best = { x, y }; score = d;
  }
  if (!best || score === 0) return arrow;
  return { ...arrow, ...best, on: false,
    a: arrow.on ? Math.atan2(arrow.x - best.x, best.y - arrow.y) * 180 / Math.PI : arrow.a };
}
