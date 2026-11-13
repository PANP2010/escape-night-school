import type { Vec3 } from '../../shared/protocol.ts';

/** A bounded, local capsule route to a remembered position. It never samples an unseen player's current location. */
export function evidenceRoute(from: Vec3, goal: Vec3, walkable: (a: Vec3, b: Vec3) => boolean,
  allowed: (p: Vec3) => boolean): Vec3[] | null {
  if (Math.abs(from[1] - goal[1]) > .4 || !allowed(from) || !allowed(goal)) return null;
  if (walkable(from, goal)) return [[...from], [...goal]];
  const step = .15, margin = 1.8;
  const x0 = Math.min(from[0], goal[0]) - margin, x1 = Math.max(from[0], goal[0]) + margin;
  const z0 = Math.min(from[2], goal[2]) - margin, z1 = Math.max(from[2], goal[2]) + margin;
  interface Point { i: number; j: number; p: Vec3; cost: number; estimate: number; previous?: Point }
  const start: Point = { i: 0, j: 0, p: [...from], cost: 0, estimate: Math.hypot(goal[0] - from[0], goal[2] - from[2]) };
  const key = (i: number, j: number) => `${i},${j}`;
  const points = new Map<string, Point>([[key(0, 0), start]]), open = new Set([start]), done = new Set<Point>();
  for (let expanded = 0; open.size && expanded < 1200; expanded++) {
    let current = start, score = Infinity;
    for (const candidate of open) if (candidate.estimate < score) { score = candidate.estimate; current = candidate; }
    open.delete(current); done.add(current);
    if (walkable(current.p, goal)) {
      const path: Vec3[] = [[...goal]];
      for (let p: Point | undefined = current; p; p = p.previous) path.unshift([...p.p]);
      // Keep only actual corners. Every shortcut is tested with the same full capsule/world/door checks.
      const simple: Vec3[] = [path[0]];
      for (let i = 0; i < path.length - 1;) {
        let next = path.length - 1;
        while (next > i + 1 && !walkable(path[i], path[next])) next--;
        simple.push(path[next]); i = next;
      }
      return simple;
    }
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const i = current.i + di, j = current.j + dj, id = key(i, j);
      const p: Vec3 = [from[0] + i * step, from[1], from[2] + j * step];
      if (p[0] < x0 || p[0] > x1 || p[2] < z0 || p[2] > z1 || !allowed(p)) continue;
      const existing = points.get(id);
      if (existing && done.has(existing)) continue;
      const cost = current.cost + Math.hypot(di, dj) * step;
      if (existing && existing.cost <= cost) continue;
      if (!walkable(current.p, p)) continue;
      const point: Point = existing ?? { i, j, p, cost, estimate: 0 };
      point.cost = cost; point.estimate = cost + Math.hypot(goal[0] - p[0], goal[2] - p[2]); point.previous = current;
      points.set(id, point); open.add(point);
    }
  }
  return null;
}
