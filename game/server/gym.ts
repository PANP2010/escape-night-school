import { PLAYER_R } from '../shared/constants.ts';
import { BALL_NOISE, BALL_RADIUS, BALL_TRIP_NOISE, GYM_TRIP_S, GymSwitches, sweptBallHit, type GymBallSnap, type GymDef, type GymSnap, type GymSound } from '../shared/gym.ts';
import type { Vec3 } from '../shared/protocol.ts';

interface Ball extends GymBallSnap { born: number; soundAt: number }
export interface GymPlayer { id: number; p: Vec3; active: boolean }
export interface GymEnv {
  blocked: (x: number, z: number, radius: number) => boolean;
  noise: (p: Vec3, radius: number, player?: number) => void;
  sound: (event: GymSound) => void;
  trip: (id: number) => void;
}

/** Fixed-step room simulation. Clients submit switch IDs and movement, never puzzle/ball/trip state. */
export class GymRuntime {
  readonly switches = new GymSwitches();
  readonly balls: Ball[] = [];
  private trips = new Map<number, number>();
  private immune = new Map<number, number>();
  private nextBall: number;
  private nextId = 1;
  private def: GymDef;
  private env: GymEnv;
  constructor(def: GymDef, now: number, env: GymEnv) {
    this.def = def; this.env = env; this.nextBall = now + 6;
  }
  tripped(id: number, now: number) { return (this.trips.get(id) ?? 0) > now; }
  private hit(id: number, p: Vec3, now: number) {
    if ((this.immune.get(id) ?? 0) > now) return;
    this.trips.set(id, now + GYM_TRIP_S);
    this.immune.set(id, now + GYM_TRIP_S + 1);
    this.env.noise(p, BALL_TRIP_NOISE, id);
    this.env.sound({ t: 'gym-sound', kind: 'trip', p: [...p], player: id });
    this.env.trip(id);
  }
  /** Swept accepted player input cannot tunnel through a ball between ticks. */
  touchMove(id: number, a: Vec3, b: Vec3, now: number) {
    for (const ball of this.balls) if (sweptBallHit(a, b, ball.p, PLAYER_R + BALL_RADIUS)) this.hit(id, b, now);
  }
  press(id: number, now: number) {
    if (!this.switches.press(id, now)) return false;
    const s = this.def.switches[id];
    this.env.sound({ t: 'gym-sound', kind: this.switches.complete ? 'open' : 'switch', p: [s.x, s.y, s.z] });
    return true;
  }
  step(now: number, dt: number, players: readonly GymPlayer[]) {
    this.switches.syncTeam(players.map((p) => p.id));
    this.switches.expire(now);
    const ids = new Set(players.map((p) => p.id));
    let tripsChanged = false;
    for (const [id, until] of this.trips) if (until <= now || !ids.has(id)) { this.trips.delete(id); tripsChanged = true; }
    for (const [id, until] of this.immune) if (until <= now || !ids.has(id)) this.immune.delete(id);
    if (now >= this.nextBall) {
      const p = this.def.ballSpawn;
      const ball: Ball = { id: this.nextId++, p: [p.x, p.y, p.z], v: [0, 3.1], born: now, soundAt: now };
      this.balls.push(ball);
      this.nextBall = now + 8;
    }
    for (let k = this.balls.length - 1; k >= 0; k--) {
      const b = this.balls[k];
      if (now - b.born >= 28) { this.balls.splice(k, 1); continue; }
      // Less than half a radius per substep: thin walls and players cannot be skipped.
      const n = Math.max(1, Math.ceil(Math.hypot(...b.v) * dt / (BALL_RADIUS / 2)));
      let bounced = false;
      for (let i = 0; i < n; i++) {
        const a: Vec3 = [...b.p], dx = b.v[0] * dt / n, dz = b.v[1] * dt / n;
        if (this.env.blocked(b.p[0] + dx, b.p[2], BALL_RADIUS)) { b.v[0] *= -1; bounced = true; }
        else b.p[0] += dx;
        if (this.env.blocked(b.p[0], b.p[2] + dz, BALL_RADIUS)) { b.v[1] *= -1; bounced = true; }
        else b.p[2] += dz;
        // After clearing the narrow equipment doorway, balls fan across the court.
        if (b.p[2] > 52.4 && b.v[0] === 0) b.v[0] = b.id % 2 ? 1.25 : 2;
        for (const p of players) if (p.active && sweptBallHit(a, b.p, p.p, PLAYER_R + BALL_RADIUS)) this.hit(p.id, p.p, now);
      }
      if (bounced || now >= b.soundAt) {
        this.env.noise(b.p, BALL_NOISE);
        this.env.sound({ t: 'gym-sound', kind: bounced ? 'bounce' : 'roll', p: [...b.p] });
        b.soundAt = now + 1;
      }
    }
    return tripsChanged;
  }
  snapshot(now: number): GymSnap {
    // Quantize only visual wire values; collision positions and all authority deadlines stay exact.
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return { t: 'gym', now, solo: this.switches.solo, until: [...this.switches.until], complete: this.switches.complete,
      balls: this.balls.map((b) => ({ id: b.id, p: [r2(b.p[0]), r2(b.p[1]), r2(b.p[2])], v: [r2(b.v[0]), r2(b.v[1])] })),
      trips: [...this.trips].filter(([, until]) => until > now).map(([id, until]) => ({ id, until })) };
  }
}
