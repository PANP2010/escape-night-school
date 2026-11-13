// 无脸值日生 AI (design.md: 被任何玩家看着就不动；没人看时 7.8 m/s 冲向最近玩家；碰到 = 罚站；每 20 s 全员眨眼 0.2 s).
// Pure like warden.ts: the room feeds it players and a line-of-sight test, and reads back position / yaw / anim.
import type { NavGraph } from '../../shared/campus/nav.ts';
import { CROUCH_EYE_H, EYE_H } from '../../shared/constants.ts';
import { F_CROUCH, F_HIDE, type Vec3 } from '../../shared/protocol.ts';

export const MONITOR_SPEED = 7.8;
/** Touched when within this horizontal distance (and one storey-step of height), m. */
export const MONITOR_CATCH_R = 0.8;
/** How long it stands where it touched someone before it hunts again, s. */
export const MONITOR_HOLD_S = 4;
/** After the level starts it stands still this long, so the team can leave the spawn, s. */
export const MONITOR_START_DELAY_S = 15;
/** Everyone blinks (screens black) for BLINK_S every BLINK_EVERY_S, and nobody sees it then. */
export const BLINK_EVERY_S = 20;
export const BLINK_S = 0.2;
/**
 * A player sees it when it lies within this half-angle of their look direction (the camera is 75° vertical; on a
 * 16:9 window that is ≈ 53° each side of the centre) and closer than the range (fog), with a clear line to the body.
 */
export const MONITOR_VIEW_HALF_ANGLE = (55 * Math.PI) / 180;
export const MONITOR_VIEW_RANGE = 40;
/** Heights above its feet that count as "seeing it": head, chest, knees. */
const BODY_Y = [1.65, 1.0, 0.35];
/** Route is re-planned this often while the straight line to the prey is blocked, s. */
const REPLAN_S = 0.5;

export type MonitorState = 'wait' | 'frozen' | 'chase' | 'hold';
export type MonitorAnim = 'idle' | 'freeze' | 'run';

/** What the AI needs to know about a player (the room's Player fits). */
export interface MonitorViewer { id: number; p: Vec3; yaw: number; pitch?: number; f: number }

type Los = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => boolean;

export interface MonitorEnv {
  graph: NavGraph;
  /** Nothing solid between two points (walls + closed doors). */
  los: Los;
  /** Its capsule can walk the straight segment a → b. Absent = always. */
  walkable?: (a: Vec3, b: Vec3) => boolean;
  speedMultiplier?: number;
}

/** Does `viewer` have any part of a figure standing at `at` (feet) in their view cone, unobstructed? Exported for tests. */
export function seenBy(viewer: MonitorViewer, at: Vec3, los: Los): boolean {
  if (viewer.f & F_HIDE) return false; // inside a locker / under a desk: no view out
  const e = { x: viewer.p[0], y: viewer.p[1] + (viewer.f & F_CROUCH ? CROUCH_EYE_H : EYE_H), z: viewer.p[2] };
  const pitch = viewer.pitch ?? 0, cp = Math.cos(pitch);
  const fx = -Math.sin(viewer.yaw) * cp, fy = Math.sin(pitch), fz = -Math.cos(viewer.yaw) * cp;
  const cosMin = Math.cos(MONITOR_VIEW_HALF_ANGLE);
  for (const h of BODY_Y) {
    const c = { x: at[0], y: at[1] + h, z: at[2] };
    const dx = c.x - e.x, dy = c.y - e.y, dz = c.z - e.z, d = Math.hypot(dx, dy, dz);
    if (d > MONITOR_VIEW_RANGE) continue;
    if (d > 1e-6 && (dx * fx + dy * fy + dz * fz) / d < cosMin) continue;
    if (los(e, c)) return true;
  }
  return false;
}

export class MonitorAI {
  /** Feet position. */
  p: Vec3;
  /** Facing, same convention as players: forward = (-sin yaw, -cos yaw). */
  yaw = 0;
  state: MonitorState = 'wait';
  /** Player ids it touched during the last step() call. */
  caught: number[] = [];
  /** True on the one step the team-wide blink starts / while screens are black. */
  blinked = false;
  blinking = false;

  private env: MonitorEnv;
  private timer = MONITOR_START_DELAY_S;
  private toBlink = BLINK_EVERY_S;
  private blinkLeft = 0;
  private route: number[] = [];
  private replan = 0;

  constructor(env: MonitorEnv, start: Vec3) {
    this.env = env;
    this.p = [start[0], start[1], start[2]];
  }

  get anim(): MonitorAnim { return this.state === 'chase' ? 'run' : this.state === 'frozen' ? 'freeze' : 'idle'; }

  /** Debug: stand at `p` and hunt right away. */
  forceHunt(p: Vec3, yaw: number): void {
    this.p = [p[0], p[1], p[2]];
    this.yaw = yaw;
    this.state = 'chase'; this.timer = 0; this.route = []; this.replan = 0;
  }

  /** `players` = everyone who is up (downed players are not prey). */
  step(dt: number, players: readonly MonitorViewer[]): void {
    this.caught = [];
    this.stepBlink(dt);
    if (this.timer > 0) { // start delay / hold after a touch: stands still (state stays 'wait' / 'hold')
      this.timer = Math.max(0, this.timer - dt);
      if (this.timer > 0) return;
      this.state = 'wait';
    }
    const prey = players.filter((v) => !(v.f & F_HIDE)); // hidden players are out of its reach
    if (!prey.length) { this.state = 'wait'; return; }
    if (!this.blinking && prey.some((v) => seenBy(v, this.p, this.env.los))) {
      this.state = 'frozen';
    } else {
      this.state = 'chase';
      this.move(MONITOR_SPEED * (this.env.speedMultiplier ?? 1) * dt, this.nearest(prey), dt);
    }
    for (const v of prey) {
      if (Math.hypot(v.p[0] - this.p[0], v.p[2] - this.p[2]) <= MONITOR_CATCH_R && Math.abs(v.p[1] - this.p[1]) < 1.5) this.caught.push(v.id);
    }
    if (this.caught.length) { this.state = 'hold'; this.timer = MONITOR_HOLD_S; this.route = []; }
  }

  private stepBlink(dt: number): void {
    this.blinked = false;
    this.blinkLeft = Math.max(0, this.blinkLeft - dt);
    this.toBlink -= dt;
    if (this.toBlink <= 0) { this.toBlink += BLINK_EVERY_S; this.blinkLeft = BLINK_S; this.blinked = true; }
    this.blinking = this.blinkLeft > 1e-9; // float residue must not add a 5th tick to a 0.2 s blink
  }

  /** The closest player (a storey up or down counts triple, as NavGraph.nearest). */
  private nearest(prey: readonly MonitorViewer[]): MonitorViewer {
    const d = (v: MonitorViewer) => (v.p[0] - this.p[0]) ** 2 + (3 * (v.p[1] - this.p[1])) ** 2 + (v.p[2] - this.p[2]) ** 2;
    return prey.reduce((a, b) => (d(b) < d(a) ? b : a));
  }

  private move(dist: number, prey: MonitorViewer, dt: number): void {
    const to = prey.p, w = this.env.walkable;
    const direct = Math.abs(to[1] - this.p[1]) < 1.5 && (!w || w(this.p, to));
    if (direct) { this.route = []; this.walkTo(to, dist); return; }
    this.replan -= dt;
    if (!this.route.length || this.replan <= 0) {
      const g = this.env.graph;
      const path = g.astar(g.nearest(this.p[0], this.p[1], this.p[2]), g.nearest(to[0], to[1], to[2]));
      // the nearest node can lie behind us: drop leading nodes we are already past (else it oscillates between two nodes)
      while (path && path.length > 1 && this.distTo(path[1]) < g.dist(path[0], path[1])) path.shift();
      this.route = path ?? [];
      this.replan = REPLAN_S;
    }
    let left = dist;
    for (let i = 0; i < 6 && left > 1e-6 && this.route.length; i++) {
      const n = this.env.graph.nodes[this.route[0]];
      const used = this.walkTo([n.x, n.y, n.z], left);
      left -= used;
      if (Math.hypot(n.x - this.p[0], n.y - this.p[1], n.z - this.p[2]) < 1e-6) this.route.shift();
    }
  }

  private distTo(node: number): number {
    const n = this.env.graph.nodes[node];
    return Math.hypot(n.x - this.p[0], n.y - this.p[1], n.z - this.p[2]);
  }

  /** Walk up to `dist` metres straight to `to`; returns the metres used. */
  private walkTo(to: Vec3, dist: number): number {
    const dx = to[0] - this.p[0], dy = to[1] - this.p[1], dz = to[2] - this.p[2], d = Math.hypot(dx, dy, dz);
    if (Math.hypot(dx, dz) > 1e-6) this.yaw = Math.atan2(-dx, -dz);
    if (d <= dist) { this.p = [to[0], to[1], to[2]]; return d; }
    const u = dist / d;
    this.p = [this.p[0] + dx * u, this.p[1] + dy * u, this.p[2] + dz * u];
    return dist;
  }
}
