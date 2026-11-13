import { EYE_H } from '../../shared/constants.ts';
import type { MirrorActorSnap } from '../../shared/l7-campaign.ts';
import { inMirrorHall, mirrorForPlayer, type MirrorSurface } from '../../shared/levels/l7.ts';
import { ST_OK, type Vec3 } from '../../shared/protocol.ts';

export const MIRROR_DELAY_S = 0.6;
export const MIRROR_STILL_S = 5;
export const MIRROR_CHASE_S = 4;
export const MIRROR_COOLDOWN_S = 1;
export const MIRROR_CHASE_SPEED = 4.6;
export const MIRROR_CATCH_R = 0.8;
/** The west-wall lab bench extends 0.57 m in front of the glass. Leave room for a capsule. */
export const MIRROR_EMERGE_M = 1.15;
const EPS = 1e-8;
const MOVE_STEP_S = 0.05;

export interface MirrorPlayer { id: number; p: Vec3; yaw: number; pitch?: number; st?: number }
export interface MirrorEnv {
  /** Resolve the bounded step from → to against the server's walls, furniture and closed doors. */
  move?: (from: Vec3, to: Vec3, maxStep: number) => Vec3;
  /** Alternatively, test whether the figure's capsule can walk the whole segment. */
  walkable?: (from: Vec3, to: Vec3) => boolean;
  /** Clear ray, using world-space points (already raised to eye/body height by the AI). */
  los?: (from: Vec3, to: Vec3) => boolean;
}

interface Pose { p: Vec3; yaw: number; pitch: number }
interface Sample extends Pose { t: number }
interface Reflection extends Pose {
  id: number;
  mirror: MirrorSurface;
  phase: 'follow' | 'still' | 'chase' | 'cooldown';
  stillFor: number;
  chaseLeft: number;
  cooldownLeft: number;
  time: number;
  history: Sample[];
}

const copy = (p: Vec3): Vec3 => [p[0], p[1], p[2]];
const angleDelta = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const finite = (p: Vec3) => p.every(Number.isFinite);
const distance = (a: Vec3, b: Vec3) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

/** Each player owns their history, still timer and pursuing figure. No teammate can keep it alive. */
export class MirrorAI {
  caught: number[] = [];
  /** Contact poses survive removing a caught reflection until the next step. */
  readonly caughtSources = new Map<number, Vec3>();
  private readonly env: MirrorEnv;
  private readonly reflections = new Map<number, Reflection>();

  constructor(env: MirrorEnv) {
    if (!env.move && !env.walkable) throw new Error('MirrorAI needs collision movement or a walkable segment test');
    this.env = env;
  }

  forget(id: number): void {
    this.reflections.delete(id);
    this.caught = this.caught.filter((caught) => caught !== id);
    this.caughtSources.delete(id);
  }

  reset(): void { this.reflections.clear(); this.caught = []; this.caughtSources.clear(); }

  snapshots(): MirrorActorSnap[] {
    return [...this.reflections.values()].filter((s) => s.phase !== 'cooldown').map((s) => ({
      id: s.id, mirrorId: s.mirror.id, phase: s.phase as MirrorActorSnap['phase'],
      p: copy(s.p), yaw: s.yaw, pitch: s.pitch, stillFor: s.stillFor, chaseLeft: s.chaseLeft,
    }));
  }

  /** Positions are the current tick's input; sample between them to follow the pose exactly 0.6 s ago. */
  step(dt: number, players: readonly MirrorPlayer[]): void {
    this.caught = [];
    this.caughtSources.clear();
    const elapsed = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    const present = new Set(players.map((p) => p.id));
    for (const id of this.reflections.keys()) if (!present.has(id)) this.reflections.delete(id);

    for (const player of players) {
      const mirror = this.visibleMirror(player);
      if (!mirror) { this.reflections.delete(player.id); continue; }
      let state = this.reflections.get(player.id);
      if (!state) {
        state = {
          id: player.id, mirror, phase: 'follow', p: copy(player.p), yaw: player.yaw, pitch: player.pitch ?? 0,
          stillFor: 0, chaseLeft: 0, cooldownLeft: 0, time: 0,
          history: [{ t: 0, p: copy(player.p), yaw: player.yaw, pitch: player.pitch ?? 0 }],
        };
        this.reflections.set(player.id, state);
      }
      if (state.phase !== 'chase' && state.mirror.id !== mirror.id) {
        state.mirror = mirror;
        state.stillFor = 0;
        if (state.phase === 'still') state.phase = 'follow';
      }
      const start = state.time, end = start + elapsed;
      state.time = end;
      const sample = { t: end, p: copy(player.p), yaw: player.yaw, pitch: player.pitch ?? 0 };
      if (state.history.at(-1)!.t === end) state.history[state.history.length - 1] = sample;
      else state.history.push(sample);
      this.advance(state, player, start, end);
      // Keep the sample just before the delayed cursor for interpolation, plus the last 0.6 seconds.
      while (state.history.length > 2 && state.history[1].t <= end - MIRROR_DELAY_S) state.history.shift();
    }
  }

  private visibleMirror(player: MirrorPlayer): MirrorSurface | undefined {
    if ((player.st ?? ST_OK) !== ST_OK || !finite(player.p) || !Number.isFinite(player.yaw)
      || !Number.isFinite(player.pitch ?? 0) || !inMirrorHall(player.p)) return undefined;
    const mirror = mirrorForPlayer(player.p, player.yaw, player.pitch);
    if (!mirror) return undefined;
    const eye: Vec3 = [player.p[0], player.p[1] + EYE_H, player.p[2]];
    return !this.env.los || this.env.los(eye, copy(mirror.center)) ? mirror : undefined;
  }

  private poseAt(state: Reflection, t: number): Pose {
    const history = state.history;
    if (t <= history[0].t) return { p: copy(history[0].p), yaw: history[0].yaw, pitch: history[0].pitch };
    for (let i = 1; i < history.length; i++) {
      const b = history[i];
      if (b.t < t) continue;
      const a = history[i - 1], u = (t - a.t) / (b.t - a.t);
      return {
        p: [a.p[0] + (b.p[0] - a.p[0]) * u, a.p[1] + (b.p[1] - a.p[1]) * u, a.p[2] + (b.p[2] - a.p[2]) * u],
        yaw: a.yaw + angleDelta(a.yaw, b.yaw) * u,
        pitch: a.pitch + (b.pitch - a.pitch) * u,
      };
    }
    const last = history.at(-1)!;
    return { p: copy(last.p), yaw: last.yaw, pitch: last.pitch };
  }

  private advance(state: Reflection, player: MirrorPlayer, start: number, end: number): void {
    let time = start;
    while (time < end - EPS) {
      if (state.phase === 'cooldown') {
        const used = Math.min(end - time, state.cooldownLeft);
        state.cooldownLeft = Math.max(0, state.cooldownLeft - used);
        time += used;
        if (state.cooldownLeft <= EPS) { state.phase = 'follow'; state.stillFor = 0; }
        continue;
      }
      if (state.phase === 'chase') {
        const used = Math.min(end - time, state.chaseLeft, MOVE_STEP_S);
        this.move(state, player.p, MIRROR_CHASE_SPEED * used);
        state.chaseLeft = Math.max(0, state.chaseLeft - used);
        time += used;
        if (this.touches(state.p, player.p)) {
          this.caught.push(player.id);
          this.caughtSources.set(player.id, copy(state.p));
          this.reflections.delete(player.id);
          return;
        }
        if (state.chaseLeft <= EPS) {
          state.phase = 'cooldown'; state.chaseLeft = 0;
          state.cooldownLeft = MIRROR_COOLDOWN_S; state.stillFor = 0;
        }
        continue;
      }
      // Delayed history is piecewise linear. Split at its knots so a partial tick's movement cannot
      // erase or add a whole tick of still time when crossing the 0.6 s delay or the 5 s threshold.
      let until = end;
      for (const sample of state.history) {
        const boundary = sample.t + MIRROR_DELAY_S;
        if (boundary > time + EPS) { until = Math.min(end, boundary); break; }
      }
      const before = this.poseAt(state, time - MIRROR_DELAY_S), after = this.poseAt(state, until - MIRROR_DELAY_S);
      const span = until - time;
      const moving = distance(before.p, after.p) > 1e-5 * span + EPS
        || Math.abs(angleDelta(before.yaw, after.yaw)) > 1e-5 * span + EPS
        || Math.abs(after.pitch - before.pitch) > 1e-5 * span + EPS;
      if (moving) {
        state.phase = 'follow'; state.stillFor = 0;
        state.p = after.p; state.yaw = after.yaw; state.pitch = after.pitch; time = until;
      } else {
        const used = Math.min(span, Math.max(0, MIRROR_STILL_S - state.stillFor));
        state.phase = 'still'; state.stillFor = Math.min(MIRROR_STILL_S, state.stillFor + used);
        const pose = this.poseAt(state, time + used - MIRROR_DELAY_S);
        state.p = pose.p; state.yaw = pose.yaw; state.pitch = pose.pitch; time += used;
        if (state.stillFor >= MIRROR_STILL_S - EPS) {
          state.phase = 'chase'; state.stillFor = MIRROR_STILL_S; state.chaseLeft = MIRROR_CHASE_S;
          const m = state.mirror;
          state.p = [m.center[0] + m.normal[0] * MIRROR_EMERGE_M, player.p[1], m.center[2] + m.normal[2] * MIRROR_EMERGE_M];
          state.yaw = Math.atan2(state.p[0] - player.p[0], state.p[2] - player.p[2]);
          state.pitch = 0;
        }
      }
    }
    if (state.phase === 'follow' || state.phase === 'still') {
      const pose = this.poseAt(state, end - MIRROR_DELAY_S);
      state.p = pose.p; state.yaw = pose.yaw; state.pitch = pose.pitch;
    }
  }

  private move(state: Reflection, target: Vec3, maxStep: number): void {
    const from = state.p, d = distance(from, target);
    if (d <= EPS || maxStep <= 0) return;
    state.yaw = Math.atan2(from[0] - target[0], from[2] - target[2]);
    const u = Math.min(1, maxStep / d);
    const to: Vec3 = [from[0] + (target[0] - from[0]) * u, from[1] + (target[1] - from[1]) * u, from[2] + (target[2] - from[2]) * u];
    if (this.env.move) {
      const resolved = this.env.move(copy(from), to, maxStep);
      if (finite(resolved) && distance(from, resolved) <= maxStep + 1e-5) state.p = copy(resolved);
    } else if (this.env.walkable!(copy(from), to)) state.p = to;
  }

  private touches(from: Vec3, target: Vec3): boolean {
    if (Math.hypot(from[0] - target[0], from[2] - target[2]) > MIRROR_CATCH_R || Math.abs(from[1] - target[1]) > 0.75) return false;
    const a: Vec3 = [from[0], from[1] + 1, from[2]], b: Vec3 = [target[0], target[1] + 1, target[2]];
    if (this.env.los && !this.env.los(a, b)) return false;
    if (this.env.walkable) return this.env.walkable(copy(from), copy(target));
    // A thin wall can fit inside the catch radius. Probe the same capsule move before reporting a touch.
    const reached = this.env.move!(copy(from), copy(target), distance(from, target));
    return finite(reached) && distance(reached, target) < 1e-4;
  }
}
