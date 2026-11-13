import { difficultyMode, type DifficultyId } from '../../shared/difficultyModes.ts';
import { F_HIDE, type BossSnap, type Vec3 } from '../../shared/protocol.ts';

export interface BossPlayer { id: number; p: Vec3; f: number }
export type BossLos = (a: Vec3, b: Vec3) => boolean;
export const BOSS_RADIUS = 2.5, BOSS_LENGTH = 24, BOSS_WIDTH = 2.8;

/** Cast from the monitor's sampled position. Attacks lock before windup and never track a fleeing player. */
export class BossAI {
  readonly p: Vec3;
  readonly id: number;
  yaw = 0;
  phase: BossSnap['phase'] = 'rest';
  skill: BossSnap['skill'] = 'chalk-circle';
  caught: number[] = [];
  private target: Vec3;
  private remaining = 3;
  private casts = 0;
  private readonly mode;
  private readonly los: BossLos;

  constructor(start: Vec3, difficulty: DifficultyId, los: BossLos, id = 2) {
    this.id = id;
    this.p = [...start]; this.target = [...start]; this.mode = difficultyMode(difficulty); this.los = los;
  }

  private visible(p: Vec3): boolean {
    return Math.abs(p[1] - this.p[1]) < 1.5 && this.los(
      [this.p[0], this.p[1] + 1.3, this.p[2]], [p[0], p[1] + 1, p[2]]);
  }

  private hit(p: Vec3): boolean {
    if (!this.visible(p)) return false;
    if (this.skill === 'chalk-circle') return Math.hypot(p[0] - this.target[0], p[2] - this.target[2]) <= BOSS_RADIUS;
    const dx = this.target[0] - this.p[0], dz = this.target[2] - this.p[2], d = Math.hypot(dx, dz);
    if (d < 1e-6) return false;
    const x = p[0] - this.p[0], z = p[2] - this.p[2], along = (x * dx + z * dz) / d;
    return along >= 0 && along <= BOSS_LENGTH && Math.abs(x * dz - z * dx) / d <= BOSS_WIDTH / 2;
  }

  step(dt: number, players: readonly BossPlayer[]): void {
    this.caught = [];
    const eligible = players.filter(p => !(p.f & F_HIDE));
    this.remaining = Math.max(0, this.remaining - dt);
    if (this.remaining > 1e-8) return;
    if (this.phase === 'windup') {
      this.phase = 'active'; this.remaining = .4;
      this.caught = eligible.filter(p => this.hit(p.p)).map(p => p.id);
      return;
    }
    if (this.phase === 'active') { this.phase = 'recover'; this.remaining = 1.6; return; }
    if (this.phase === 'recover') { this.phase = 'rest'; this.remaining = this.mode.bossCooldown; return; }
    const nearest = eligible.filter(p => this.visible(p.p) && Math.hypot(p.p[0] - this.p[0], p.p[2] - this.p[2]) <= BOSS_LENGTH)
      .sort((a, b) => Math.hypot(a.p[0] - this.p[0], a.p[2] - this.p[2]) - Math.hypot(b.p[0] - this.p[0], b.p[2] - this.p[2]))[0];
    if (!nearest) { this.remaining = .25; return; }
    this.target = [...nearest.p];
    this.yaw = Math.atan2(this.p[0] - nearest.p[0], this.p[2] - nearest.p[2]);
    this.skill = this.casts++ % 2 ? 'rollcall-sweep' : 'chalk-circle';
    this.phase = 'windup'; this.remaining = this.mode.bossWindup;
  }

  snapshot(): BossSnap {
    return { id: this.id, name: '值周代号025', phase: this.phase, skill: this.skill, origin: [...this.p], target: [...this.target],
      remaining: Math.round(this.remaining * 100) / 100, radius: BOSS_RADIUS, length: BOSS_LENGTH, width: BOSS_WIDTH };
  }
}
