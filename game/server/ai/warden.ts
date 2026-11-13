// 角色074 AI state machine (design.md: 巡逻 → 调查 → 追击 → 抓到). Pure: no timers, no I/O; the room feeds it
// players, noise events and a line-of-sight test, and reads back position / yaw / anim.
import type { NavGraph } from '../../shared/campus/nav.ts';
import { hears, type BlockedFn, type NoiseEvent } from '../../shared/noise.ts';
import { F_CROUCH, F_HIDE, F_LIGHT, F_RUN, type Vec3 } from '../../shared/protocol.ts';
import { CROUCH_EYE_H, EYE_H } from '../../shared/constants.ts';
import { pickLine, type LineTrigger } from '../../shared/lines.ts';

export const WARDEN_PATROL_SPEED = 1.4;
export const WARDEN_CHASE_SPEED = 3.8; // walk 3.4 < chase < run 6.0: the steady approach still gains on an exhausted player
export const WARDEN_INVESTIGATE_SPEED = 1.9;
/** Chase ends (→ investigate the last seen spot) after this long without sight, s. */
export const WARDEN_LOSE_SIGHT_S = 6;
/** Caught when within this horizontal distance, m. */
export const WARDEN_CATCH_R = 0.8;
/** How long the catch pose holds before he resumes patrol, s. */
export const WARDEN_CATCH_HOLD_S = 3;
/** After the catch hold he walks off to a patrol node at least this far (horizontally) from the catch spot and from
 * every `env.avoid` point, sensing nobody on the way (review #188: one catch at the spawn turned into a wipe). */
export const WARDEN_RETREAT_M = 15;
/** The retreat (blind to sight, beam and noise) ends at the node or after this long, s. */
export const WARDEN_RETREAT_MAX_S = 20;
/** While `env.keepOut` lists spots his patrol stays this far (horizontally) from them and he ignores noise made inside, m. */
export const WARDEN_KEEP_OUT_M = 20;
/** How long he stands and looks around at an investigated spot, s. */
export const WARDEN_LOOK_S = 2.5;
export const WARDEN_EYE_H = 1.88; // matches the taller teacher's supported head; navigation/catch capsule stays unchanged
/** Sight: full range in front (half-angle below), short range all round. */
export const WARDEN_SIGHT_RANGE = 14;
export const WARDEN_SIGHT_HALF_ANGLE = (75 * Math.PI) / 180;
export const WARDEN_SENSE_RADIUS = 2.5;
/** A flashlight beam reaches this far and is this wide (half-angle) around the player's look direction. */
export const LIGHT_RANGE = 14;
export const LIGHT_HALF_ANGLE = (22 * Math.PI) / 180;

/** Minimum gap between any two voice lines, s. */
export const WARDEN_LINE_COOLDOWN_S = 6;
/** Ambient patrol line every this many seconds (random in range). */
export const WARDEN_PATROL_LINE_S: readonly [number, number] = [25, 40];
/** A noise this kind of loud makes him say 「粗疏」-type lines when he turns to it. */
const LOUD_NOISE = new Set(['door', 'item']);

export interface WardenSaid { id: string; text: string; trigger: LineTrigger }

export type WardenState = 'patrol' | 'investigate' | 'chase' | 'catch';

/** What the AI needs to know about a player (the room's Player fits). */
export interface WardenTarget { id: number; p: Vec3; yaw: number; pitch?: number; f: number }

export interface WardenEnv {
  graph: NavGraph;
  rng: () => number;
  /** Nothing solid between two points (walls + closed doors). */
  los: (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => boolean;
  /** His capsule can walk the straight segment a → b (walls, furniture, closed doors). Absent = always. */
  walkable?: (a: Vec3, b: Vec3) => boolean;
  /** Recheck cached graph steps against dynamic puzzle doors (exam rooms). */
  checkRouteSteps?: boolean;
  /** Spots the post-catch retreat must end WARDEN_RETREAT_M from besides the catch spot (the room: spawns, downed players). */
  avoid?: () => readonly Vec3[];
  /** Spots his patrol keeps WARDEN_KEEP_OUT_M away from (the room: the spawns during the opening, #206). Empty / absent = none. */
  keepOut?: () => readonly Vec3[];
  /** Form-specific hearing, e.g. night patrol 1.5; read at each event so a room may switch forms. */
  hearingMultiplier?: () => number;
  /** Form-specific movement scale for ordinary patrol only; post-catch retreat keeps its safety speed. */
  patrolMultiplier?: () => number;
  /** Room mode changes pursuit speeds without changing action or speech timers. */
  speedMultiplier?: () => number;
}

const eyeOf = (t: WardenTarget) => ({ x: t.p[0], y: t.p[1] + (t.f & F_CROUCH ? CROUCH_EYE_H : EYE_H), z: t.p[2] });

/** Is `warden` (feet position) inside the beam of `t`'s flashlight, and unobstructed? Exported for tests. */
export function litBy(t: WardenTarget, warden: Vec3, los: WardenEnv['los']): boolean {
  if (!(t.f & F_LIGHT)) return false;
  const e = eyeOf(t), cp = Math.cos(t.pitch ?? 0);
  const fx = -Math.sin(t.yaw) * cp, fy = Math.sin(t.pitch ?? 0), fz = -Math.cos(t.yaw) * cp;
  const c = { x: warden[0], y: warden[1] + 1, z: warden[2] }; // aim at his chest
  const dx = c.x - e.x, dy = c.y - e.y, dz = c.z - e.z, d = Math.hypot(dx, dy, dz);
  if (d > LIGHT_RANGE) return false;
  if (d > 1e-6 && (dx * fx + dy * fy + dz * fz) / d < Math.cos(LIGHT_HALF_ANGLE)) return false;
  return los(e, c);
}

export class WardenAI {
  /** Feet position. */
  p: Vec3;
  /** Facing, same convention as players: forward = (-sin yaw, -cos yaw). */
  yaw = 0;
  state: WardenState = 'patrol';
  /** Chased / caught player id (0 = none). */
  target = 0;
  /** Where the current investigation / chase heads (world xyz). */
  goal: Vec3 | null = null;
  /** Player ids caught during the last step() call. */
  caught: number[] = [];

  private env: WardenEnv;
  /** Last graph node reached and the nodes still to walk. */
  private at: number;
  private prev = -1;
  private route: number[] = [];
  /** Seconds since chase sight was lost / left in look-around or catch hold. */
  private lost = 0;
  private timer = 0;
  private onGraph = true;
  /** Seconds left of the post-catch retreat (0 = none): patrol pace along `route`, no senses. */
  private calm = 0;
  /** Voice lines: clock, last line time, recent ids (newest last), next ambient line, lines not yet drained. */
  private clock = 0;
  private lastSay = -Infinity;
  private recent: string[] = [];
  private nextPatrolLine: number;
  private nextChaseLine = 8;
  private outbox: WardenSaid[] = [];
  /** Run / crouch flag of the chased player on the previous tick, so a line fires on the change only. */
  private seenKind: LineTrigger | null = null;
  /** Players he could see on the previous tick (while not hiding), and hidden players he watched go in. */
  private sawLast = new Set<number>();
  private witnessed = new Set<number>();
  /** Room-owned safe sighting: no sensing, noise response or catches until explicitly released. */
  private sighting = false;
  private sightingAnim = 'patrol';

  constructor(env: WardenEnv, start: number) {
    this.env = env;
    this.at = start;
    this.nextPatrolLine = this.patrolGap();
    const n = env.graph.nodes[start];
    this.p = [n.x, n.y, n.z];
  }

  /** Level (re)load: stand on node `start`, patrolling, with no memory of anyone (voice-line clock kept). */
  reset(start: number): void {
    const n = this.env.graph.nodes[start];
    this.p = [n.x, n.y, n.z];
    this.at = start; this.prev = -1; this.onGraph = true;
    this.toPatrol();
    this.calm = 0; this.caught = []; this.seenKind = null;
    this.sighting = false;
    this.sawLast.clear(); this.witnessed.clear();
  }

  /** Walking off after a catch (patrol anim, blind and deaf). */
  get retreating(): boolean { return this.calm > 0; }

  private patrolGap(): number {
    const [a, b] = WARDEN_PATROL_LINE_S;
    return a + this.env.rng() * (b - a);
  }

  /** Say a line for `trigger` unless the global cooldown is still running. */
  private say(trigger: LineTrigger): void {
    if (this.clock - this.lastSay < WARDEN_LINE_COOLDOWN_S) return;
    const l = pickLine(trigger, this.env.rng, this.recent);
    if (!l) return;
    this.lastSay = this.clock;
    this.recent.push(l.id);
    if (this.recent.length > 3) this.recent.shift();
    this.outbox.push({ ...l, trigger });
  }

  /** A puzzle answer was wrong (no puzzle code on the server yet; call this when it exists). */
  sayFail(): void { this.say('fail'); }

  /** Lines said since the last call (the room broadcasts them). */
  takeLines(): WardenSaid[] {
    const o = this.outbox;
    this.outbox = [];
    return o;
  }

  /** Client animation clip name for the snapshot. */
  get anim(): string { return this.sighting ? this.sightingAnim : this.state; }

  /** The room has validated that both ends of this relocation are hidden from every camera. */
  startSighting(p: Vec3, yaw: number): void {
    this.sighting = true;
    this.p = [...p]; this.yaw = yaw; this.onGraph = false;
    this.state = 'patrol'; this.target = 0; this.goal = null; this.route = [];
    this.timer = 0; this.lost = 0; this.calm = 0; this.caught = [];
    this.sawLast.clear(); this.witnessed.clear(); this.seenKind = null;
    this.sightingAnim = 'patrol';
  }

  /** Play one already capsule-checked short segment, or wait. Voice uses the ordinary global line cooldown. */
  stepSighting(dt: number, to?: Vec3, speed = WARDEN_PATROL_SPEED, peek = false): void {
    this.clock += dt; this.caught = [];
    this.state = 'patrol'; this.target = 0; this.goal = null;
    this.sightingAnim = peek ? 'peek' : 'patrol';
    if (to) this.moveDirect(to, speed * dt);
  }

  saySighting(): void { if (this.sighting) this.say('patrol'); }

  /** Resume only after the controlled exit has actually walked onto a node; retain the exact feet position.
   * Attaching several metres away would leave an unchecked door-closing window before the old follow() runs. */
  endSighting(): boolean {
    const nodes = this.env.graph.nodes;
    const local = nodes.map((n, id) => ({ id, p: [n.x, n.y, n.z] as Vec3,
      d: Math.hypot(n.x - this.p[0], n.z - this.p[2]) }))
      .filter(n => Math.abs(n.p[1] - this.p[1]) < .0001 && n.d < .0001)
      .sort((a, b) => a.d - b.d)
      .find(n => this.env.walkable?.(this.p, n.p) ?? true);
    if (!local) return false;
    this.at = local.id; this.prev = -1; this.onGraph = true;
    this.route = []; this.sighting = false;
    return true;
  }

  /** Current speed for the state (m/s); 0 while standing. */
  private get patrolSpeed(): number {
    const multiplier = this.env.patrolMultiplier?.() ?? 1;
    return WARDEN_PATROL_SPEED * (Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1) * this.modeSpeed;
  }
  private get modeSpeed(): number { return this.env.speedMultiplier?.() ?? 1; }

  get speed(): number {
    switch (this.state) {
      case 'chase': return WARDEN_CHASE_SPEED * this.modeSpeed;
      case 'investigate': return WARDEN_INVESTIGATE_SPEED * this.modeSpeed;
      case 'patrol': return this.retreating ? WARDEN_PATROL_SPEED : this.patrolSpeed;
      default: return 0;
    }
  }

  /** A noise event: patrol / investigate turn toward it when audible (chase and catch ignore noise). */
  hear(ev: NoiseEvent, blocked?: BlockedFn): void {
    if (this.sighting || this.state === 'chase' || this.state === 'catch' || this.calm > 0) return;
    const multiplier = this.env.hearingMultiplier?.() ?? 1;
    const audible = Number.isFinite(multiplier) && multiplier > 0 ? { ...ev, r: ev.r * multiplier } : ev;
    if (!hears(audible, this.p[0], this.p[1], this.p[2], blocked)) return;
    if ((this.env.keepOut?.() ?? []).some((q) => Math.hypot(ev.x - q[0], ev.z - q[2]) < WARDEN_KEEP_OUT_M)) return;
    const was = this.state;
    this.investigate([ev.x, ev.y, ev.z]);
    if (was === 'patrol' && this.state === 'investigate' && LOUD_NOISE.has(ev.kind)) this.say('noise');
  }

  private investigate(at: Vec3): void {
    // Repeated footsteps / beams keep the current plan only on the same storey. A broadcast above
    // or below an earlier noise must replace that goal even when its horizontal position matches.
    if (this.state === 'investigate' && this.goal && Math.abs(at[1] - this.goal[1]) < .3 && Math.hypot(at[0] - this.goal[0], at[2] - this.goal[2]) < 2) return;
    const g = this.env.graph, goal = g.nearest(at[0], at[1], at[2]);
    if (goal < 0) return;
    if (!this.plan(goal)) return;
    this.state = 'investigate';
    this.goal = [at[0], at[1], at[2]];
    this.timer = 0;
  }

  /** Route from where he stands to node `goal`; false (and no change) when unreachable. */
  private plan(goal: number): boolean {
    const g = this.env.graph, from = this.onGraph ? this.at : g.nearest(this.p[0], this.p[1], this.p[2]);
    const path = g.astar(from, goal);
    if (!path) return false;
    this.route = path;
    this.at = from;
    this.prev = -1;
    return true;
  }

  private canSee(t: WardenTarget): boolean {
    const dx = t.p[0] - this.p[0], dz = t.p[2] - this.p[2], d = Math.hypot(dx, dz);
    if (d > WARDEN_SIGHT_RANGE || Math.abs(t.p[1] - this.p[1]) > 2.5) return false;
    if (d > WARDEN_SENSE_RADIUS) {
      // angle between his facing and the player
      const a = Math.atan2(-dx, -dz) - this.yaw;
      const diff = Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
      if (diff > WARDEN_SIGHT_HALF_ANGLE) return false;
    }
    return this.env.los({ x: this.p[0], y: this.p[1] + WARDEN_EYE_H, z: this.p[2] }, eyeOf(t));
  }

  /** Stand at `p` and chase immediately. Debug calls announce; puzzle summons retain the normal line cooldown. */
  forceChase(p: Vec3, yaw: number, id: number, at: Vec3, announce = true): void {
    this.sighting = false;
    this.p = [p[0], p[1], p[2]];
    this.yaw = yaw;
    this.state = 'chase'; this.target = id; this.goal = [at[0], at[1], at[2]];
    this.route = []; this.timer = 0; this.lost = 0; this.onGraph = false; this.calm = 0;
    if (announce) {
      this.lastSay = -Infinity; // debug: the spot line must not be eaten by the cooldown
      this.say('spot');
    }
  }

  /** Advance `dt` seconds. */
  step(dt: number, players: readonly WardenTarget[]): void {
    if (this.sighting) { this.stepSighting(dt); return; }
    this.caught = [];
    this.clock += dt;
    if (this.state === 'catch') {
      this.timer += dt;
      if (this.timer >= WARDEN_CATCH_HOLD_S) { this.toPatrol(); this.retreat(); }
      return;
    }
    if (this.calm > 0 && this.state === 'patrol') { // retreating after a catch: walks off, blind and deaf
      this.calm -= dt;
      this.sawLast.clear();
      this.follow(WARDEN_PATROL_SPEED * dt);
      if (this.route.length === 0) this.calm = 0;
      return;
    }

    // senses. Hiding: sight and beam are void, except for a player he saw on the previous tick who then hid (he knows the spot)
    const sawNow = new Set<number>();
    let seen: WardenTarget | null = null, sd = Infinity;
    for (const t of players) {
      if (t.f & F_HIDE) {
        if (this.sawLast.has(t.id)) this.witnessed.add(t.id);
        if (!this.witnessed.has(t.id)) continue;
      } else {
        this.witnessed.delete(t.id);
        if (!this.canSee(t)) continue;
        sawNow.add(t.id);
      }
      const d = Math.hypot(t.p[0] - this.p[0], t.p[2] - this.p[2]);
      if (d < sd) { sd = d; seen = t; }
    }
    this.sawLast = sawNow;
    if (seen) {
      if (this.state !== 'chase') { this.state = 'chase'; this.route = []; this.say('spot'); }
      else {
        const k: LineTrigger | null = seen.f & F_RUN ? 'sprint' : seen.f & F_CROUCH ? 'crouch' : null;
        if (k && k !== this.seenKind) this.say(k);
      }
      this.nextChaseLine -= dt;
      if (this.nextChaseLine <= 0) { this.say('chase'); this.nextChaseLine = 8 + this.env.rng() * 6; }
      this.seenKind = seen.f & F_RUN ? 'sprint' : seen.f & F_CROUCH ? 'crouch' : null;
      this.target = seen.id;
      this.goal = [seen.p[0], seen.p[1], seen.p[2]];
      this.lost = 0;
    } else if (this.state === 'chase') {
      this.lost += dt;
      if (this.lost >= WARDEN_LOSE_SIGHT_S) {
        const g = this.goal!;
        this.target = 0;
        this.state = 'patrol';
        this.goal = null;
        this.investigate(g);
        this.say('lost');
      } else if (this.route.length === 0 && this.goal) {
        this.plan(this.env.graph.nearest(this.goal[0], this.goal[1], this.goal[2]));
      }
    } else {
      // flashlight beam on him → investigate where the beam comes from
      for (const t of players) {
        if (t.f & F_HIDE) continue;
        if (litBy(t, this.p, this.env.los)) { this.investigate([t.p[0], t.p[1], t.p[2]]); break; }
      }
    }

    // catch
    if (this.state === 'chase' && seen) {
      const d = Math.hypot(seen.p[0] - this.p[0], seen.p[2] - this.p[2]);
      if (d <= WARDEN_CATCH_R && Math.abs(seen.p[1] - this.p[1]) < 1.5) {
        this.state = 'catch'; this.timer = 0; this.caught.push(seen.id); this.witnessed.delete(seen.id);
        this.say('catch');
        return;
      }
    }

    // move
    if (this.state === 'chase' && seen) {
      // straight at a visible player on the same floor when the capsule fits the whole way (sight is only a thin
      // ray: it passes low furniture and corners); else follow the graph toward them
      if (Math.abs(seen.p[1] - this.p[1]) < 0.5 && (this.env.walkable?.(this.p, seen.p) ?? true)) { this.route = []; this.moveDirect(seen.p, WARDEN_CHASE_SPEED * this.modeSpeed * dt); }
      else if (Math.abs(seen.p[1] - this.p[1]) < 0.5 && this.slide(seen.p, WARDEN_CHASE_SPEED * this.modeSpeed * dt)) { this.route = []; }
      else {
        if (this.route.length === 0) this.plan(this.env.graph.nearest(seen.p[0], seen.p[1], seen.p[2]));
        this.follow(WARDEN_CHASE_SPEED * this.modeSpeed * dt);
      }
    } else if (this.state === 'chase') {
      this.follow(WARDEN_CHASE_SPEED * this.modeSpeed * dt);
    } else if (this.state === 'investigate') {
      if (this.route.length) this.follow(WARDEN_INVESTIGATE_SPEED * this.modeSpeed * dt);
      else {
        this.timer += dt;
        if (this.timer >= WARDEN_LOOK_S) this.toPatrol();
      }
    } else {
      this.nextPatrolLine -= dt;
      if (this.nextPatrolLine <= 0) { this.say('patrol'); this.nextPatrolLine = this.patrolGap(); }
      if (this.route.length === 0) this.pickPatrol();
      this.follow(this.patrolSpeed * dt);
    }
  }

  /** Player `id` left the room: drop them from memory; a chase after them ends right away instead of running to where they stood. */
  forget(id: number): void {
    this.sawLast.delete(id);
    this.witnessed.delete(id);
    if (this.target !== id) return;
    if (this.state === 'chase') this.toPatrol();
    else this.target = 0;
  }

  private toPatrol(): void {
    this.state = 'patrol'; this.target = 0; this.goal = null; this.route = []; this.timer = 0; this.lost = 0;
    if (!this.onGraph) { this.at = this.env.graph.nearest(this.p[0], this.p[1], this.p[2]); this.onGraph = true; }
  }

  /**
   * Head for a random same-floor node WARDEN_RETREAT_M..2× from the catch spot and every avoid point that is a short walk
   * (≤ ¾ of WARDEN_RETREAT_MAX_S at patrol speed) away; else the nearest-by-walk such node; else the farthest one.
   */
  private retreat(): void {
    const g = this.env.graph, here: Vec3 = [this.p[0], this.p[1], this.p[2]];
    const away = [here, ...(this.env.avoid?.() ?? [])];
    const clear = (i: number) => {
      const n = g.nodes[i];
      let m = Infinity;
      for (const q of away) m = Math.min(m, Math.hypot(n.x - q[0], n.z - q[2]));
      return m;
    };
    // walking distance from here (Dijkstra, cut off well past the budget: corridors wind)
    const budget = 0.75 * WARDEN_PATROL_SPEED * WARDEN_RETREAT_MAX_S;
    const walk = new Map<number, number>([[this.at, 0]]), open = new Set([this.at]), done = new Set<number>();
    while (open.size) {
      let cur = -1, cd = Infinity;
      for (const i of open) if (walk.get(i)! < cd) { cd = walk.get(i)!; cur = i; }
      open.delete(cur); done.add(cur);
      if (cd > 3 * budget) break;
      for (const n of g.adj[cur]) {
        const t = cd + g.dist(cur, n);
        if (done.has(n) || t >= (walk.get(n) ?? Infinity)) continue;
        walk.set(n, t); open.add(n);
      }
    }
    const band: number[] = [];
    let near = -1, nearW = Infinity, best = -1, bestD = -1;
    for (const i of done) {
      if (Math.abs(g.nodes[i].y - here[1]) > 1.5) continue;
      const d = clear(i), w = walk.get(i)!;
      if (d >= WARDEN_RETREAT_M && d <= 2 * WARDEN_RETREAT_M) {
        if (w <= budget) band.push(i);
        if (w < nearW) { nearW = w; near = i; }
      }
      if (d > bestD) { bestD = d; best = i; }
    }
    const goal = band.length ? band[Math.floor(this.env.rng() * band.length)] : near >= 0 ? near : best;
    if (goal >= 0 && goal !== this.at && this.plan(goal)) this.calm = WARDEN_RETREAT_MAX_S;
  }

  /** Random neighbour of the current node, not the one just left unless dead end. */
  private pickPatrol(): void {
    if (!this.onGraph) { this.at = this.env.graph.nearest(this.p[0], this.p[1], this.p[2]); this.onGraph = true; }
    const adj = this.env.graph.adj[this.at];
    let opts = adj.length > 1 ? adj.filter(n => n !== this.prev) : adj;
    const keep = this.env.keepOut?.() ?? [];
    if (keep.length && opts.length) {
      // keep-out: only neighbours clear of every point; none clear → the one farthest from them (walks back out)
      const nodes = this.env.graph.nodes;
      const clear = (n: number) => Math.min(...keep.map((q) => Math.hypot(nodes[n].x - q[0], nodes[n].z - q[2])));
      const ok = opts.filter((n) => clear(n) >= WARDEN_KEEP_OUT_M);
      opts = ok.length ? ok : [adj.reduce((b, n) => (clear(n) > clear(b) ? n : b))];
    }
    if (opts.length) this.route = [opts[Math.floor(this.env.rng() * opts.length)]];
  }

  private face(dx: number, dz: number): void {
    if (Math.hypot(dx, dz) > 1e-6) this.yaw = Math.atan2(-dx, -dz);
  }

  /** Local obstacle avoidance: when the straight line is blocked, sidestep along a walkable angled heading that still closes distance. */
  private slide(to: Vec3, dist: number): boolean {
    const w = this.env.walkable;
    if (!w) return false;
    const dx = to[0] - this.p[0], dz = to[2] - this.p[2], d0 = Math.hypot(dx, dz);
    if (d0 < 1e-6) return false;
    const base = Math.atan2(dz, dx), probe = Math.max(dist, 0.5);
    for (const a of [0.5, -0.5, 1.0, -1.0, 1.4, -1.4]) {
      const c: Vec3 = [this.p[0] + Math.cos(base + a) * probe, this.p[1], this.p[2] + Math.sin(base + a) * probe];
      if (Math.hypot(to[0] - c[0], to[2] - c[2]) >= d0 - 0.05 || !w(this.p, c)) continue;
      this.moveDirect(c, dist);
      return true;
    }
    return false;
  }

  private moveDirect(to: Vec3, dist: number): void {
    const dx = to[0] - this.p[0], dy = to[1] - this.p[1], dz = to[2] - this.p[2], d = Math.hypot(dx, dy, dz);
    this.face(dx, dz);
    this.onGraph = false;
    if (d <= dist) { this.p = [to[0], to[1], to[2]]; return; }
    const u = dist / d;
    this.p = [this.p[0] + dx * u, this.p[1] + dy * u, this.p[2] + dz * u];
  }

  /** Walk `dist` metres along the node route; path[0] equal to the node we are already at is skipped. */
  private follow(dist: number): void {
    const nodes = this.env.graph.nodes;
    let left = dist;
    while (left > 0 && this.route.length) {
      const id = this.route[0], t = nodes[id];
      const dx = t.x - this.p[0], dy = t.y - this.p[1], dz = t.z - this.p[2], d = Math.hypot(dx, dy, dz);
      this.face(dx, dz);
      const u = d <= left ? 1 : left / d;
      const next: Vec3 = [this.p[0] + dx * u, this.p[1] + dy * u, this.p[2] + dz * u];
      // A graph edge can outlive a door closing. Validate this whole capsule step before following it.
      if (this.env.checkRouteSteps && d > 0 && this.env.walkable && !this.env.walkable(this.p, next)) {
        this.route = []; // replan / retry from this safe position; opening the door permits the next attempt
        return;
      }
      if (d <= left) {
        this.p = next;
        left -= d;
        this.route.shift();
        this.prev = this.at; this.at = id; this.onGraph = true;
      } else {
        this.p = next;
        this.onGraph = false; // between nodes
        left = 0;
      }
    }
  }
}
