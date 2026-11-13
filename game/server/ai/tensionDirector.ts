// Room-local, deterministic pacing. No timers, I/O, teleports, voice lines or changes to Warden's locomotion.
import { F_HIDE, type Vec3 } from '../../shared/protocol.ts';
import { mulberry32 } from '../../shared/rng.ts';
import type { WardenEnv, WardenState, WardenTarget } from './warden.ts';
import { EYE_H } from '../../shared/constants.ts';
import { NavGraph } from '../../shared/campus/nav.ts';

export const TENSION = {
  /** Start a safe investigation this often after the previous chase began. Sight still earns the chase. */
  encounter: [60, 75] as const,
  /** Leave 15 s for the existing navigation/sight AI to turn an approach into a 60–90 s encounter. */
  approachLead: 15,
  respite: [20, 30] as const,
  scareCooldown: 45,
  approachRefresh: 3,
  standOff: [6, 13] as const,
};

export interface DirectorMob { state: WardenState; target: number; p: Vec3; retreating: boolean }
export interface DirectorPlayer extends WardenTarget { /** Distance from this level's spawn, m. */ advance: number }
export interface DirectorPlan { prey: WardenTarget[]; investigate?: number; disengage?: number }

/** Sparse campus corridor chains sometimes run past a level barrier before branching back to a classroom.
 * Keep node ids stable for Warden's current route, but validate every edge and add only capsule-clear shortcuts.
 * The room's shared navigation / player guidance graph is never mutated. */
export function investigationGraph(source: NavGraph, walkable: (a: Vec3, b: Vec3) => boolean): NavGraph {
  const graph = new NavGraph();
  graph.nodes.push(...source.nodes.map(n => ({ ...n })));
  graph.adj.push(...source.nodes.map(() => [] as number[]));
  const point = (i: number): Vec3 => { const n = source.nodes[i]; return [n.x, n.y, n.z]; };
  // A dense grid (gym / mirror rooms) already has local routes. Long all-pairs capsule probes there
  // cost far more than the sparse campus chains they repair; only fill small gaps in dense graphs.
  const shortcutRange = source.nodes.length > 256 ? 2 : 40;
  for (let i = 0; i < source.nodes.length; i++) for (let j = i + 1; j < source.nodes.length; j++) {
    const a = source.nodes[i], b = source.nodes[j];
    const original = source.adj[i].includes(j);
    if (!original && (Math.abs(a.y - b.y) > .5 || Math.hypot(a.x - b.x, a.z - b.z) > shortcutRange)) continue;
    if (walkable(point(i), point(j))) graph.link(i, j);
  }
  return graph;
}

/** A real, reachable sightline 6–13 m away (below Warden's 14 m sight range), never on someone's face or behind a shut door.
 * This only selects an investigation goal. Warden.hear/step still walk the existing graph from his current position. */
export function investigationPoint(env: Pick<WardenEnv, 'graph' | 'los' | 'walkable'>, from: Vec3, target: WardenTarget, players: readonly WardenTarget[]): Vec3 | undefined {
  const g = env.graph, start = g.nearest(...from);
  if (start < 0) return;
  let best: Vec3 | undefined, score = Infinity;
  for (let i = 0; i < g.nodes.length; i++) {
    const n = g.nodes[i], d = Math.hypot(n.x - target.p[0], n.z - target.p[2]);
    if (Math.abs(n.y - target.p[1]) > .5 || d < TENSION.standOff[0] || d > TENSION.standOff[1]) continue;
    if (players.some(p => Math.abs(n.y - p.p[1]) < 1.5 && Math.hypot(n.x - p.p[0], n.z - p.p[2]) < TENSION.standOff[0])) continue;
    if (!env.los({ x: n.x, y: n.y + EYE_H, z: n.z }, { x: target.p[0], y: target.p[1] + EYE_H, z: target.p[2] })) continue;
    const path = g.astar(start, i);
    if (!path) continue;
    let at = from, length = 0, clear = true;
    for (const id of path) {
      const p = g.nodes[id], next: Vec3 = [p.x, p.y, p.z];
      if (env.walkable && !env.walkable(at, next)) { clear = false; break; }
      length += Math.hypot(next[0] - at[0], next[1] - at[1], next[2] - at[2]);
      at = next;
    }
    if (!clear) continue;
    // Prefer a route the player can see; don't require them to stare at the monster to make progress.
    const forward = ((n.x - target.p[0]) * -Math.sin(target.yaw) + (n.z - target.p[2]) * -Math.cos(target.yaw)) / d;
    const cost = length + Math.abs(d - 9) + (forward < .5 ? 8 : 0);
    if (cost < score) { score = cost; best = [n.x, n.y, n.z]; }
  }
  return best;
}

/** One instance per Room. All times are authoritative room seconds; a level reset keeps the scare cooldown. */
export class TensionDirector {
  private rng: () => number;
  private levelFrom = 0;
  private nextEncounter = 0;
  private nextApproach = 0;
  private restUntil = 0;
  private chaseFrom: number | undefined;
  private observedState: WardenState = 'patrol';
  private encountered = false;
  private focus = 0;
  private previousTarget = 0;
  private previousEncounter = 0;
  private lastScare = -Infinity;
  private activity = new Map<number, { p: Vec3; value: number }>();
  private sampledAt = 0;
  private pressure = 0;

  constructor(seed: number) { this.rng = mulberry32(seed ^ 0x74656e73); this.reset(0); }

  reset(now: number): void {
    this.levelFrom = this.previousEncounter = this.sampledAt = now;
    this.nextEncounter = now + this.gap(TENSION.encounter);
    this.nextApproach = this.nextEncounter;
    this.restUntil = now;
    this.chaseFrom = undefined;
    this.observedState = 'patrol';
    this.encountered = false;
    this.focus = 0;
    this.activity.clear();
    this.pressure = 0;
  }

  private gap(range: readonly [number, number]) { return range[0] + this.rng() * (range[1] - range[0]); }
  resting(now: number): boolean { return now < this.restUntil; }
  /** Natural noise/broadcast investigations also honor the respite; a selected approach is not diverted by a teammate. */
  hears(now: number, source?: number): boolean {
    return !this.resting(now) && (!this.focus || source === undefined || source === this.focus);
  }
  scareReady(now: number): boolean { return now - this.lastScare >= TENSION.scareCooldown && !this.resting(now); }
  /** Call only when the existing room event is actually emitted. */
  takeScare(now: number): boolean {
    if (!this.scareReady(now)) return false;
    this.lastScare = now;
    return true;
  }

  /** Debug summon remains explicit and useful in existing tests; this never moves or changes an AI. */
  allowSummon(now: number): void { this.restUntil = now; this.focus = 0; this.chaseFrom = undefined; this.observedState = 'patrol'; }

  /** A room-confirmed, audible impact may interrupt quiet pacing. The AI still needs real sight
   * before chasing; an existing chase, its timer and the shared scare cooldown remain untouched. */
  alert(now: number, source: number): void {
    if (this.chaseFrom !== undefined) return;
    this.restUntil = now;
    this.focus = source;
    this.nextEncounter = now;
    // The room has already supplied the actual impact position. Do not replace it with a
    // scheduled approach in the same tick; subsequent refreshes retain ordinary pacing.
    this.nextApproach = now + TENSION.approachRefresh;
  }

  /** Plan immediately before Warden.step. Only the room's already eligible prey may enter this method. */
  plan(now: number, players: readonly DirectorPlayer[], mob: DirectorMob, ready: boolean, progress = 0): DirectorPlan {
    // A door close / departing player may have ended the chase between ticks. Observe that
    // departure before handing Warden prey, otherwise he can acquire someone else in the same tick.
    if (this.observedState === 'chase' && mob.state !== 'chase') this.observe(now, mob);
    const dt = Math.max(0, now - this.sampledAt);
    this.sampledAt = now;
    const ids = new Set(players.map(p => p.id));
    for (const id of this.activity.keys()) if (!ids.has(id)) this.activity.delete(id);
    for (const p of players) {
      const last = this.activity.get(p.id);
      const moved = last ? Math.min(6 * dt, Math.hypot(p.p[0] - last.p[0], p.p[2] - last.p[2])) : 0;
      this.activity.set(p.id, { p: [...p.p], value: (last?.value ?? 0) * Math.exp(-dt / 20) + moved });
    }
    const proximity = players.length ? Math.max(...players.map(p => Math.max(0, 1 - Math.hypot(p.p[0] - mob.p[0], p.p[2] - mob.p[2]) / 20))) : 0;
    const elapsed = (now - this.previousEncounter) / Math.max(1, this.nextEncounter - this.previousEncounter);
    this.pressure = this.resting(now) ? 0 : Math.max(0, Math.min(1, elapsed * .7 + proximity * .2 + Math.max(0, Math.min(1, progress)) * .1));
    if (!ready) return { prey: [] };
    if (mob.state === 'catch') return { prey: [] }; // preserve the existing catch pose and retreat route
    if (this.resting(now)) return { prey: [], ...(mob.state === 'chase' ? { disengage: mob.target } : {}) };
    // Only the AI's real lost-sight/catch/departure result ends a pursuit. Quiet encounter
    // deadlines must never cancel a chase while its target remains visible.
    // Keep witnessed hiding semantics in Warden.step: only NEW selections exclude F_HIDE.
    if (mob.state === 'chase') return { prey: players.filter(p => p.id === mob.target) };
    // The first sighting may happen naturally. Thereafter, noise may still draw an investigation
    // after respite, but sight cannot restart a chase before the next encounter deadline.
    if (this.encountered && now < this.nextEncounter) return { prey: [] };
    const candidates = players.filter(p => !(p.f & F_HIDE));
    const alternatives = candidates.filter(p => p.id !== this.previousTarget);
    const fair = alternatives.length ? alternatives : candidates;
    if (this.focus && !candidates.some(p => p.id === this.focus)) this.focus = 0;
    if (!this.focus && now >= this.nextEncounter && fair.length && !mob.retreating) {
      const score = (p: DirectorPlayer) => (this.activity.get(p.id)?.value ?? 0) + Math.min(50, p.advance) * .15;
      this.focus = fair.reduce((a, b) => score(b) > score(a) ? b : a).id;
      this.nextApproach = now;
    }
    let investigate: number | undefined;
    if (this.focus && now >= this.nextApproach && !mob.retreating) {
      investigate = this.focus;
      this.nextApproach = now + TENSION.approachRefresh;
    }
    return { prey: this.focus ? players.filter(p => p.id === this.focus) : fair, ...(investigate ? { investigate } : {}) };
  }

  /** Observe the actual result, including patrol → catch in one tick. Schedule once on an edge, never per frame. */
  observe(now: number, mob: DirectorMob): void {
    const began = mob.state === 'chase' && this.observedState !== 'chase';
    const caught = mob.state === 'catch' && this.observedState !== 'catch';
    if (began || (caught && this.chaseFrom === undefined)) {
      this.encountered = true;
      this.chaseFrom = now;
      this.previousEncounter = now;
      this.focus = mob.target;
      this.nextEncounter = now + this.gap(TENSION.encounter);
    }
    if (mob.state === 'chase' || caught) this.previousTarget = mob.target || this.previousTarget;
    if (caught || (this.observedState === 'chase' && mob.state !== 'chase' && this.chaseFrom !== undefined)) this.finish(now);
    this.observedState = mob.state;
  }

  private finish(now: number): void {
    this.restUntil = now + this.gap(TENSION.respite);
    this.chaseFrom = undefined;
    this.focus = 0;
    this.nextEncounter = Math.max(this.nextEncounter, this.restUntil);
  }

  /** Bounded diagnostics for deterministic tests, not a network/debug protocol. */
  status(now: number) {
    return { phase: this.resting(now) ? 'respite' : this.chaseFrom !== undefined ? 'chase' : this.focus ? 'approach' : 'quiet',
      tension: this.pressure, levelFrom: this.levelFrom, nextEncounter: this.nextEncounter, respiteUntil: this.restUntil,
      target: this.focus, previousTarget: this.previousTarget, lastScare: this.lastScare };
  }
}
