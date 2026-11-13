// Persistent pursuit used only by the final level. Unlike the regular Warden state machine, it never loses the target.
import type { NavGraph } from '../../shared/campus/nav.ts';
import type { Vec3 } from '../../shared/protocol.ts';

export const FINALE_CHASE_SPEED = 4.6;
export const FINALE_CATCH_R = 0.8;

export interface FinaleTarget { id: number; p: Vec3 }
export interface FinaleEnv {
  graph?: NavGraph;
  walkable?: (a: Vec3, b: Vec3) => boolean;
}

export class FinaleAI {
  p: Vec3;
  yaw = 0;
  target = 0;
  caught: number[] = [];
  private env: FinaleEnv;
  private route: number[] = [];
  private plannedFor = 0;

  constructor(env: FinaleEnv, spawn: Vec3) { this.env = env; this.p = [...spawn]; }

  reset(spawn: Vec3): void { this.p = [...spawn]; this.yaw = 0; this.target = 0; this.caught = []; this.route = []; }

  get anim(): string { return 'chase'; }

  step(dt: number, targets: readonly FinaleTarget[]): void {
    this.caught = [];
    const target = targets.reduce<FinaleTarget | undefined>((best, p) => !best || flat(this.p, p.p) < flat(this.p, best.p) ? p : best, undefined);
    if (!target) { this.target = 0; this.route = []; return; }
    if (this.target !== target.id) this.plannedFor = 0;
    this.target = target.id;
    const dist = flat(this.p, target.p);
    if (dist <= FINALE_CATCH_R && Math.abs(target.p[1] - this.p[1]) < 1.5 && (this.env.walkable?.(this.p, target.p) ?? true)) {
      this.caught.push(target.id);
      return;
    }
    const max = FINALE_CHASE_SPEED * Math.min(dt, 0.1);
    if (Math.abs(target.p[1] - this.p[1]) < 0.5 && (this.env.walkable?.(this.p, target.p) ?? true)) {
      this.route = [];
      this.move(target.p, max);
      return;
    }
    const graph = this.env.graph;
    if (!graph?.nodes.length) return;
    this.plannedFor -= dt;
    if (!this.route.length || this.plannedFor <= 0) {
      const clear = (a: Vec3, i: number) => this.env.walkable?.(a, point(graph, i)) ?? true;
      const nearestClear = (p: Vec3) => {
        const ids = graph.nodes.map((n, i) => ({ i, d: (n.x - p[0]) ** 2 + 9 * (n.y - p[1]) ** 2 + (n.z - p[2]) ** 2 })).sort((a, b) => a.d - b.d);
        return ids.find(({ i }) => clear(p, i))?.i ?? -1;
      };
      const a = nearestClear(this.p), b = nearestClear(target.p);
      this.route = a < 0 || b < 0 ? [] : graph.astar(a, b) ?? [];
      // Keep the graph entry point unless the next leg is actually clear. Dropping it blindly cuts corners through walls.
      while (this.route.length > 1 && clear(this.p, this.route[1])) this.route.shift();
      this.plannedFor = 0.4;
    }
    this.follow(graph, max);
  }

  private move(to: Vec3, d: number) {
    const dx = to[0] - this.p[0], dy = to[1] - this.p[1], dz = to[2] - this.p[2], len = Math.hypot(dx, dy, dz);
    if (len > 1e-6) this.yaw = Math.atan2(-dx, -dz);
    const u = len <= d ? 1 : d / len;
    this.p = [this.p[0] + dx * u, this.p[1] + dy * u, this.p[2] + dz * u];
  }

  private follow(graph: NavGraph, budget: number) {
    while (budget > 0 && this.route.length) {
      const n = graph.nodes[this.route[0]], q: Vec3 = [n.x, n.y, n.z], d = Math.hypot(q[0] - this.p[0], q[1] - this.p[1], q[2] - this.p[2]);
      if (!(this.env.walkable?.(this.p, q) ?? true)) { this.route = []; this.plannedFor = 0; return; }
      if (d <= budget) { this.p = q; budget -= d; this.route.shift(); }
      else { this.move(q, budget); budget = 0; }
    }
  }
}

const flat = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);
const point = (g: NavGraph, i: number): Vec3 => [g.nodes[i].x, g.nodes[i].y, g.nodes[i].z];
