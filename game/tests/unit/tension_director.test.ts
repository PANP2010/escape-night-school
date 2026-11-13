import { describe, expect, it } from 'vitest';
import { CollisionWorld, overlaps } from '../../shared/campus/collision.ts';
import { NAV_CAPSULE, NavGraph } from '../../shared/campus/nav.ts';
import { F_HIDE, type Vec3 } from '../../shared/protocol.ts';
import { WardenAI, WARDEN_CHASE_SPEED, WARDEN_LOSE_SIGHT_S } from '../../server/ai/warden.ts';
import {
  investigationGraph, investigationPoint, TENSION, TensionDirector, type DirectorMob, type DirectorPlayer,
} from '../../server/ai/tensionDirector.ts';

const EPS = .001;
const player = (id: number, options: Partial<DirectorPlayer> = {}): DirectorPlayer =>
  ({ id, p: [0, 0, 0], yaw: 0, f: 0, advance: 0, ...options });
const mob = (state: DirectorMob['state'] = 'patrol', target = 0, options: Partial<DirectorMob> = {}): DirectorMob =>
  ({ state, target, p: [100, 0, 100], retreating: false, ...options });
const preyIds = (plan: ReturnType<TensionDirector['plan']>) => plan.prey.map(p => p.id);

function escaped(seed = 3, id = 1, began = 10, ended = 11) {
  const director = new TensionDirector(seed);
  director.observe(began, mob('chase', id));
  director.observe(ended, mob());
  return director;
}

describe('TensionDirector deadlines and observations', () => {
  it('reserves a 60–75 s approach interval and at most 15 s of navigation lead for a 60–90 s encounter', () => {
    expect(TENSION.encounter).toEqual([60, 75]);
    expect(TENSION.approachLead).toBe(15);
    expect(TENSION.encounter[1] + TENSION.approachLead).toBeLessThanOrEqual(90);
    for (const seed of [0, 1, 2, 3, 17, 999]) {
      const director = new TensionDirector(seed);
      director.reset(100);
      const due = director.status(100).nextEncounter;
      expect(due).toBeGreaterThanOrEqual(160);
      expect(due).toBeLessThanOrEqual(175);
      expect(director.plan(due - EPS, [player(1)], mob(), true).investigate).toBeUndefined();
      expect(director.plan(due, [player(1)], mob(), true).investigate).toBe(1);
    }
  });

  it('keeps its deadline stable across quiet frames, unavailable prey and repeated plans', () => {
    const director = new TensionDirector(3), due = director.status(0).nextEncounter;
    for (const now of [0, 1, 10, due - EPS, due, due + 1]) {
      expect(director.plan(now, [], mob(), true)).toEqual({ prey: [] });
      expect(director.status(now).nextEncounter).toBe(due);
    }
    expect(director.plan(due + 2, [player(1)], mob(), true).investigate).toBe(1);
    expect(director.status(due + 2).nextEncounter).toBe(due);
    expect(director.plan(due + 2, [player(1)], mob(), true).investigate).toBeUndefined();
    expect(director.status(due + 2).nextEncounter).toBe(due);
  });

  it('does not start an approach until ready or while the existing retreat is running', () => {
    const director = new TensionDirector(3), due = director.status(0).nextEncounter;
    expect(director.plan(due, [player(1)], mob(), false)).toEqual({ prey: [] });
    expect(director.status(due).target).toBe(0);
    const retreat = director.plan(due + 1, [player(1)], mob('patrol', 0, { retreating: true }), true);
    expect(retreat.investigate).toBeUndefined();
    expect(director.status(due + 1).target).toBe(0);
    expect(director.plan(due + 2, [player(1)], mob(), true).investigate).toBe(1);
  });

  it('refreshes a selected investigation at exactly 3 s, once per deadline', () => {
    expect(TENSION.approachRefresh).toBe(3);
    const director = new TensionDirector(3), due = director.status(0).nextEncounter;
    expect(director.plan(due, [player(1)], mob(), true).investigate).toBe(1);
    expect(director.plan(due + 3 - EPS, [player(1)], mob('investigate'), true).investigate).toBeUndefined();
    expect(director.plan(due + 3, [player(1)], mob('investigate'), true).investigate).toBe(1);
    expect(director.plan(due + 3, [player(1)], mob('investigate'), true).investigate).toBeUndefined();
    expect(director.plan(due + 6, [player(1)], mob('investigate'), true).investigate).toBe(1);
    expect(director.status(due + 6).nextEncounter).toBe(due);
  });

  it('schedules from the observed chase edge, not from every chase frame', () => {
    const director = new TensionDirector(3);
    director.observe(10, mob('chase', 1));
    const due = director.status(10).nextEncounter;
    expect(due).toBeGreaterThanOrEqual(70);
    expect(due).toBeLessThanOrEqual(85);
    expect(director.status(10)).toMatchObject({ phase: 'chase', target: 1, previousTarget: 1 });
    for (const now of [10.05, 11, 12]) {
      director.plan(now, [player(1)], mob('chase', 1), true);
      director.observe(now, mob('chase', 1));
      expect(director.status(now).nextEncounter).toBe(due);
    }
  });

  it('observes a patrol → catch tick and preserves the catch pose without further commands', () => {
    const director = new TensionDirector(3);
    director.plan(10, [player(1)], mob(), true);
    director.observe(10, mob('catch', 1));
    const status = director.status(10), end = status.respiteUntil;
    expect(status).toMatchObject({ phase: 'respite', previousTarget: 1, target: 0 });
    expect(end - 10).toBeGreaterThanOrEqual(20);
    expect(end - 10).toBeLessThanOrEqual(30);
    expect(status.nextEncounter).toBeGreaterThanOrEqual(70);
    expect(status.nextEncounter).toBeLessThanOrEqual(85);
    expect(director.plan(10.05, [player(1)], mob('catch', 1), true)).toEqual({ prey: [] });
    director.observe(10.05, mob('catch', 1));
    director.observe(13, mob());
    expect(director.status(13).respiteUntil).toBe(end);
    expect(director.status(13).nextEncounter).toBe(status.nextEncounter);
  });
});

describe('TensionDirector respite and pursuit continuity', () => {
  it('gives an escaped chase 20–30 s of respite and reopens hearing exactly at its boundary', () => {
    expect(TENSION.respite).toEqual([20, 30]);
    for (const seed of [0, 1, 2, 3, 17, 999]) {
      const director = escaped(seed), end = director.status(11).respiteUntil;
      expect(end - 11).toBeGreaterThanOrEqual(20);
      expect(end - 11).toBeLessThanOrEqual(30);
      expect(director.resting(end - EPS)).toBe(true);
      expect(director.hears(end - EPS, 1)).toBe(false);
      expect(director.hears(end - EPS)).toBe(false);
      expect(director.plan(end - EPS, [player(1)], mob(), true)).toEqual({ prey: [] });
      expect(director.status(end - EPS).tension).toBe(0);
      expect(director.resting(end)).toBe(false);
      expect(director.hears(end, 1)).toBe(true);
      expect(preyIds(director.plan(end, [player(1)], mob(), true))).toEqual([]);
    }
  });

  it('allows quiet investigations after respite while withholding every new chase until the 60–75 s deadline', () => {
    for (const seed of [0, 1, 2, 3, 17, 999]) {
      const director = escaped(seed), status = director.status(11), players = [player(1, { advance: 50 }), player(2)];
      const due = status.nextEncounter;
      for (const now of [status.respiteUntil, due - 1, due - EPS]) {
        expect(director.hears(now, 2)).toBe(true);
        expect(director.plan(now, players, mob('investigate'), true)).toEqual({ prey: [] });
        expect(director.status(now).nextEncounter).toBe(due);
      }
      const plan = director.plan(due, players, mob('investigate'), true);
      expect(plan.investigate).toBe(2);
      expect(preyIds(plan)).toEqual([2]);
      expect(due - 10).toBeGreaterThanOrEqual(60);
      expect(due - 10 + TENSION.approachLead).toBeLessThanOrEqual(90);
    }
  });

  it('keeps first sightings and explicit summons available and restores first-sighting eligibility on a new level', () => {
    const director = new TensionDirector(3), players = [player(1), player(2)];
    expect(preyIds(director.plan(1, players, mob(), true))).toEqual([1, 2]);
    director.observe(10, mob('chase', 1));
    director.observe(11, mob());
    const due = director.status(11).nextEncounter;
    expect(director.plan(due - 1, players, mob(), true)).toEqual({ prey: [] });
    director.allowSummon(due - .5);
    expect(preyIds(director.plan(due - .5, players, mob('chase', 1), true))).toEqual([1]);
    director.reset(due);
    expect(director.resting(due)).toBe(false);
    expect(preyIds(director.plan(due, players, mob(), true))).toContain(2);
  });

  it('keeps an active pursuit beyond 18 s and the next encounter deadline, until the AI really loses its target', () => {
    const director = new TensionDirector(3), chasing = mob('chase', 1);
    director.observe(10, chasing);
    const due = director.status(10).nextEncounter;
    for (const now of [28 - EPS, 28, 28 + EPS, 45, due + 1, due + 30]) {
      expect(director.plan(now, [player(1), player(2)], chasing, true)).toEqual({ prey: [player(1)] });
      director.observe(now, chasing);
      expect(director.resting(now)).toBe(false);
      expect(director.status(now)).toMatchObject({ phase: 'chase', target: 1, nextEncounter: due });
    }
    const escapedAt = due + 31;
    director.observe(escapedAt, mob('investigate'));
    const end = director.status(escapedAt).respiteUntil;
    expect(end - escapedAt).toBeGreaterThanOrEqual(20);
    expect(end - escapedAt).toBeLessThanOrEqual(30);
    director.observe(escapedAt + .05, mob('investigate'));
    expect(director.status(escapedAt + .05).respiteUntil).toBe(end);
  });

  it('lets a real walking AI pursue for 30 s, then respects its six-second lost-sight escape', () => {
    const graph = new NavGraph();
    graph.chain([{ x: 0, y: 0, z: 0 }, { x: 200, y: 0, z: 0 }]);
    let clear = true;
    const warden = new WardenAI({ graph, rng: () => .5, los: () => clear }, 0);
    const director = new TensionDirector(3), runner = player(1, { p: [8, 0, 0] });
    const dt = .05;
    warden.forceChase([0, 0, 0], -Math.PI / 2, runner.id, runner.p);
    director.observe(0, warden);
    for (let tick = 1; tick <= 30 / dt; tick++) {
      runner.p = [8 + tick * WARDEN_CHASE_SPEED * dt, 0, 0];
      const now = tick * dt, before = warden.p[0];
      const plan = director.plan(now, [runner], warden, true);
      if (plan.disengage) warden.forget(plan.disengage);
      warden.step(dt, plan.prey);
      director.observe(now, warden);
      expect(warden.state, `pursuit ended at ${now}s`).toBe('chase');
      expect(warden.target).toBe(runner.id);
      expect(warden.p[0] - before).toBeCloseTo(WARDEN_CHASE_SPEED * dt, 6);
      expect(warden.caught).toEqual([]);
    }
    expect(warden.p[0]).toBeCloseTo(30 * WARDEN_CHASE_SPEED, 6);
    const lastSeen: Vec3 = [...runner.p];
    clear = false;
    runner.p = [150, 0, 30]; // movement behind the wall must not update Warden's remembered goal
    for (let tick = 1; tick <= Math.ceil(WARDEN_LOSE_SIGHT_S / dt) + 1; tick++) {
      const now = 30 + tick * dt;
      const plan = director.plan(now, [runner], warden, true);
      if (plan.disengage) warden.forget(plan.disengage);
      warden.step(dt, plan.prey);
      director.observe(now, warden);
      if (tick * dt < WARDEN_LOSE_SIGHT_S - dt) expect(warden.state).toBe('chase');
      expect(warden.goal).toEqual(lastSeen);
      expect(warden.caught).toEqual([]);
    }
    expect(warden.state).toBe('investigate');
    expect(director.status(30 + WARDEN_LOSE_SIGHT_S + dt).phase).toBe('respite');
  });

  it('disengages an unexpected chase during respite without extending that respite', () => {
    const director = escaped(), end = director.status(11).respiteUntil;
    expect(director.plan(12, [player(1)], mob('chase', 1), true)).toEqual({ prey: [], disengage: 1 });
    expect(director.status(12).respiteUntil).toBe(end);
    director.observe(12, mob());
    expect(director.status(12).respiteUntil).toBe(end);
  });

  it('allows an audible impact to interrupt respite while preserving its precise investigation and scare cooldown', () => {
    const director = new TensionDirector(3);
    expect(director.takeScare(0)).toBe(true);
    director.observe(10, mob('chase', 1));
    director.observe(11, mob());
    expect(director.resting(12)).toBe(true);
    director.alert(12, 2);
    expect(director.resting(12)).toBe(false);
    expect(director.hears(12, 2)).toBe(true);
    expect(director.hears(12, 1)).toBe(false);
    const plan = director.plan(12, [player(1), player(2)], mob('investigate'), true);
    expect(preyIds(plan)).toEqual([2]);
    expect(plan.investigate).toBeUndefined();
    expect(plan.disengage).toBeUndefined();
    expect(director.status(12)).toMatchObject({ phase: 'approach', target: 2, lastScare: 0 });
    expect(director.takeScare(12)).toBe(false);
  });

  it('does not divert or reset an already active pursuit when another player makes an impact', () => {
    const director = new TensionDirector(3), chasing = mob('chase', 1);
    director.observe(10, chasing);
    const due = director.status(10).nextEncounter;
    director.alert(12, 2);
    const plan = director.plan(12, [player(1), player(2)], chasing, true);
    expect(preyIds(plan)).toEqual([1]);
    expect(plan.disengage).toBeUndefined();
    expect(director.status(12)).toMatchObject({ phase: 'chase', target: 1, nextEncounter: due });
  });

  it('recognizes an out-of-step departure that has already returned Warden to patrol', () => {
    const director = new TensionDirector(3);
    director.observe(10, mob('chase', 1));
    director.plan(11, [], mob(), true);
    director.observe(11, mob());
    expect(director.status(11).phase).toBe('respite');
    const end = director.status(11).respiteUntil;
    director.observe(12, mob());
    expect(director.status(12).respiteUntil).toBe(end);
  });
});

describe('TensionDirector shared scare cooldown', () => {
  it('admits one actual scare at the 45 s boundary and a rejected request does not move it', () => {
    expect(TENSION.scareCooldown).toBe(45);
    const director = new TensionDirector(3);
    expect(director.scareReady(100)).toBe(true);
    expect(director.status(100).lastScare).toBe(-Infinity);
    expect(director.takeScare(100)).toBe(true);
    expect(director.takeScare(100)).toBe(false);
    expect(director.scareReady(145 - EPS)).toBe(false);
    expect(director.takeScare(145 - EPS)).toBe(false);
    expect(director.status(145 - EPS).lastScare).toBe(100);
    expect(director.scareReady(145)).toBe(true);
    expect(director.takeScare(145)).toBe(true);
    expect(director.takeScare(145)).toBe(false);
    expect(director.takeScare(190 - EPS)).toBe(false);
    expect(director.takeScare(190)).toBe(true);
  });

  it('keeps the scare cooldown across a level reset while clearing the old approach and respite', () => {
    const director = new TensionDirector(3);
    expect(director.takeScare(100)).toBe(true);
    director.observe(101, mob('chase', 1));
    director.observe(102, mob('catch', 1));
    expect(director.resting(110)).toBe(true);
    director.reset(110);
    expect(director.status(110)).toMatchObject({ phase: 'quiet', levelFrom: 110, target: 0, lastScare: 100, tension: 0 });
    expect(director.status(110).nextEncounter).toBeGreaterThanOrEqual(170);
    expect(director.status(110).nextEncounter).toBeLessThanOrEqual(185);
    expect(director.takeScare(145 - EPS)).toBe(false);
    expect(director.takeScare(145)).toBe(true);
  });

  it('denies scares during respite even when 45 s has elapsed, without consuming a new cooldown', () => {
    const director = new TensionDirector(3);
    expect(director.takeScare(0)).toBe(true);
    director.observe(40, mob('chase', 1));
    director.observe(50, mob());
    const end = director.status(50).respiteUntil;
    expect(director.scareReady(end - EPS)).toBe(false);
    expect(director.takeScare(end - EPS)).toBe(false);
    expect(director.status(end - EPS).lastScare).toBe(0);
    expect(director.takeScare(end)).toBe(true);
  });

  it('isolates cooldowns, target memory, deadlines and RNG between room instances', () => {
    const first = new TensionDirector(3), second = new TensionDirector(3), control = new TensionDirector(3);
    expect(first.status(0)).toEqual(second.status(0));
    first.takeScare(0);
    first.observe(1, mob('catch', 1));
    first.reset(2);
    expect(second.status(2)).toEqual(control.status(2));
    expect(second.scareReady(3)).toBe(true);
    expect(second.takeScare(3)).toBe(true);
    expect(first.scareReady(3)).toBe(false);
    first.observe(4, mob('chase', 1));
    second.observe(10, mob('chase', 2));
    control.observe(10, mob('chase', 2));
    expect(second.status(10).nextEncounter).toBe(control.status(10).nextEncounter);
    expect(first.status(10).previousTarget).toBe(1);
    expect(second.status(10).previousTarget).toBe(2);
  });

  it('allows an explicit debug summon to end respite without clearing the scare cooldown', () => {
    const director = new TensionDirector(3);
    expect(director.takeScare(0)).toBe(true);
    director.observe(10, mob('chase', 1));
    director.observe(11, mob());
    director.allowSummon(12);
    expect(director.resting(12)).toBe(false);
    expect(director.hears(12, 1)).toBe(true);
    expect(director.takeScare(45 - EPS)).toBe(false);
    expect(director.takeScare(45)).toBe(true);
  });
});

describe('TensionDirector target selection', () => {
  it('rotates away from the previous target even when that target has a higher advance score', () => {
    const director = escaped(), due = director.status(11).nextEncounter;
    const plan = director.plan(due, [player(1, { advance: 50 }), player(2)], mob(), true);
    expect(plan.investigate).toBe(2);
    expect(preyIds(plan)).toEqual([2]);
    expect(director.status(due).previousTarget).toBe(1);
    expect(director.status(due).target).toBe(2);
    expect(director.hears(due, 2)).toBe(true);
    expect(director.hears(due, 1)).toBe(false);
  });

  it('does not use a hidden player as a new target or as a visible alternative', () => {
    const empty = new TensionDirector(3), firstDue = empty.status(0).nextEncounter;
    expect(empty.plan(firstDue, [player(1, { f: F_HIDE, advance: 50 })], mob(), true)).toEqual({ prey: [] });
    expect(empty.status(firstDue).target).toBe(0);
    const director = escaped(), due = director.status(11).nextEncounter;
    const plan = director.plan(due, [player(1), player(2, { f: F_HIDE, advance: 50 })], mob(), true);
    expect(plan.investigate).toBe(1);
    expect(preyIds(plan)).toEqual([1]);
  });

  it('locks the current chase and preserves its witnessed hiding flags', () => {
    const director = new TensionDirector(3), hidden = player(1, { f: F_HIDE });
    director.observe(10, mob('chase', 1));
    const plan = director.plan(11, [hidden, player(2, { advance: 50 })], mob('chase', 1), true);
    expect(plan.prey).toEqual([hidden]);
    expect(plan.investigate).toBeUndefined();
    expect(plan.disengage).toBeUndefined();
  });

  it('keeps a selected approach locked when a teammate later gets a higher score', () => {
    const director = new TensionDirector(3), due = director.status(0).nextEncounter;
    expect(director.plan(due, [player(1, { advance: 30 }), player(2)], mob(), true).investigate).toBe(1);
    const plan = director.plan(due + 1, [player(1), player(2, { advance: 50 })], mob('investigate'), true);
    expect(preyIds(plan)).toEqual([1]);
    expect(plan.investigate).toBeUndefined();
    expect(director.status(due + 1).target).toBe(1);
  });

  it('releases an approach target that leaves or hides and never returns their id as prey', () => {
    for (const hidden of [false, true]) {
      const director = new TensionDirector(3), due = director.status(0).nextEncounter;
      director.plan(due, [player(1, { advance: 30 }), player(2)], mob(), true);
      const players = hidden ? [player(1, { f: F_HIDE }), player(2)] : [player(2)];
      const plan = director.plan(due + 1, players, mob('investigate'), true);
      expect(plan.investigate).toBe(2);
      expect(preyIds(plan)).toEqual([2]);
      expect(director.status(due + 1).target).toBe(2);
    }
  });

  it('clears a departing focus when no eligible player remains without rescheduling the deadline', () => {
    const director = new TensionDirector(3), due = director.status(0).nextEncounter;
    director.plan(due, [player(1)], mob(), true);
    expect(director.plan(due + 1, [], mob('investigate'), true)).toEqual({ prey: [] });
    expect(director.status(due + 1)).toMatchObject({ phase: 'quiet', target: 0, nextEncounter: due });
  });
});

describe('TensionDirector activity and advance scores', () => {
  it('prefers greater level advance when movement is equal', () => {
    const director = new TensionDirector(3), due = director.status(0).nextEncounter;
    expect(director.plan(due, [player(1), player(2, { advance: 20 })], mob(), true).investigate).toBe(2);
  });

  it('lets recent real movement outweigh a modest advance advantage', () => {
    const director = new TensionDirector(3), due = director.status(0).nextEncounter;
    director.plan(due - 1, [player(1, { advance: 30 }), player(2)], mob(), true);
    const plan = director.plan(due, [player(1, { advance: 30 }), player(2, { p: [6, 0, 0] })], mob(), true);
    expect(plan.investigate).toBe(2);
  });

  it('copies position samples so reusing a player object does not erase its movement', () => {
    const director = new TensionDirector(3), due = director.status(0).nextEncounter;
    const players = [player(1, { advance: 30 }), player(2)];
    director.plan(due - 1, players, mob(), true);
    players[1].p[0] = 6;
    expect(director.plan(due, players, mob(), true).investigate).toBe(2);
    expect(players[1].p).toEqual([6, 0, 0]);
  });

  it('keeps activity scoring separate for two rooms with the same player ids', () => {
    const first = new TensionDirector(3), second = new TensionDirector(3), due = first.status(0).nextEncounter;
    first.plan(due - 1, [player(1, { advance: 20 }), player(2)], mob(), true);
    second.plan(due - 1, [player(1, { advance: 20 }), player(2)], mob(), true);
    expect(first.plan(due, [player(1, { advance: 20 }), player(2, { p: [6, 0, 0] })], mob(), true).investigate).toBe(2);
    expect(second.plan(due, [player(1, { advance: 20 }), player(2)], mob(), true).investigate).toBe(1);
  });

  it('decays old activity so a single early movement cannot dominate indefinitely', () => {
    const director = new TensionDirector(3), due = director.status(0).nextEncounter;
    director.plan(0, [player(1), player(2, { advance: 10 })], mob(), true);
    director.plan(1, [player(1, { p: [6, 0, 0] }), player(2, { advance: 10 })], mob(), true);
    expect(director.plan(due, [player(1, { p: [6, 0, 0] }), player(2, { advance: 10 })], mob(), true).investigate).toBe(2);
  });

  it('caps sampled movement at running speed and advance at 50 m', () => {
    const moving = new TensionDirector(3), due = moving.status(0).nextEncounter;
    moving.plan(due - 1, [player(1), player(2)], mob(), true);
    expect(moving.plan(due, [player(1, { p: [6, 0, 0] }), player(2, { p: [1000, 0, 0] })], mob(), true).investigate).toBe(1);
    const advancing = new TensionDirector(3), advanceDue = advancing.status(0).nextEncounter;
    expect(advancing.plan(advanceDue, [player(1, { advance: 50 }), player(2, { advance: 1000 })], mob(), true).investigate).toBe(1);
  });

  it('drops a departed player’s activity rather than inheriting it when the id returns', () => {
    const director = new TensionDirector(3), due = director.status(0).nextEncounter;
    director.plan(0, [player(1), player(2, { advance: 1 })], mob(), true);
    director.plan(due - 2, [player(1, { p: [6, 0, 0] }), player(2, { advance: 1 })], mob(), true);
    director.plan(due - 1, [player(2, { advance: 1 })], mob(), true);
    expect(director.plan(due, [player(1, { p: [6, 0, 0] }), player(2, { advance: 1 })], mob(), true).investigate).toBe(2);
  });

  it('raises bounded pressure with time, proximity and progress, and clears it during respite', () => {
    const director = new TensionDirector(3), due = director.status(0).nextEncounter;
    director.plan(0, [player(1)], mob(), true);
    expect(director.status(0).tension).toBe(0);
    director.plan(due / 2, [player(1)], mob(), true);
    const quiet = director.status(due / 2).tension;
    director.plan(due / 2, [player(1)], mob('patrol', 0, { p: [0, 0, 0] }), true, 1);
    expect(director.status(due / 2).tension).toBeGreaterThan(quiet);
    expect(director.status(due / 2).tension).toBeLessThanOrEqual(1);
    director.observe(due / 2, mob('chase', 1));
    director.observe(due / 2 + 1, mob());
    director.plan(due / 2 + 2, [player(1)], mob('patrol', 0, { p: [0, 0, 0] }), true, 100);
    expect(director.status(due / 2 + 2).tension).toBe(0);
  });
});

describe('investigationGraph', () => {
  const capsuleClear = (world: CollisionWorld) => (a: Vec3, b: Vec3): boolean => {
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / (NAV_CAPSULE.radius * .5)));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      if (overlaps(world, { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, z: a[2] + (b[2] - a[2]) * t, vy: 0, grounded: true }, NAV_CAPSULE)) return false;
    }
    return true;
  };

  it('clones the graph without changing node ids, metadata, original edges or shared node objects', () => {
    const graph = new NavGraph();
    graph.chain([{ x: 0, y: 0, z: 0, tag: 'B:2', room: 'hall' }, { x: 10, y: 0, z: 0 }]);
    graph.addNode({ x: 5, y: 0, z: 5, tag: 'B:2', room: 's1' });
    const before = JSON.stringify({ nodes: graph.nodes, adj: graph.adj });
    const copy = investigationGraph(graph, () => true);
    expect(copy).not.toBe(graph);
    expect(copy.nodes).toEqual(graph.nodes);
    expect(copy.nodes).not.toBe(graph.nodes);
    expect(copy.adj).not.toBe(graph.adj);
    for (let i = 0; i < graph.nodes.length; i++) {
      expect(copy.nodes[i]).not.toBe(graph.nodes[i]);
      expect(copy.adj[i]).not.toBe(graph.adj[i]);
    }
    expect(copy.adj[0]).toContain(2); // the added sightline belongs to the clone only
    expect(JSON.stringify({ nodes: graph.nodes, adj: graph.adj })).toBe(before);
  });

  it('repairs the real L2 corridor route without walking through the eastern sealed desks', () => {
    const graph = new NavGraph();
    // Room-area ids in the failure: 3 → 2 → 11, travelling past the target before doubling back.
    const hall = graph.addNode({ x: 22.75, y: 3.6, z: 83.35 });
    const east = graph.addNode({ x: 57.55, y: 3.6, z: 83.35 });
    const standOff = graph.addNode({ x: 43.05, y: 3.6, z: 83.25 });
    graph.link(hall, east); graph.link(east, standOff);
    const world = new CollisionWorld([{ minX: 56.2, maxX: 57, minY: 3.6, maxY: 5.2, minZ: 82, maxZ: 83.96 }]);
    const clear = capsuleClear(world), before = JSON.stringify({ nodes: graph.nodes, adj: graph.adj });
    expect(graph.astar(hall, standOff)).toEqual([hall, east, standOff]);
    expect(clear([22.75, 3.6, 83.35], [57.55, 3.6, 83.35])).toBe(false);
    expect(clear([22.75, 3.6, 83.35], [43.05, 3.6, 83.25])).toBe(true);
    const copy = investigationGraph(graph, clear);
    expect(copy.nodes).toEqual(graph.nodes);
    expect(copy.adj[hall]).not.toContain(east);
    expect(copy.adj[east]).not.toContain(hall);
    expect(copy.adj[east]).not.toContain(standOff);
    expect(copy.adj[standOff]).not.toContain(east);
    expect(copy.astar(hall, standOff)).toEqual([hall, standOff]);
    const target = player(1, { p: [55.8, 3.6, 84.2] });
    expect(investigationPoint({ graph: copy, los: () => true, walkable: clear }, [22.75, 3.6, 83.35], target, [target])).toEqual([43.05, 3.6, 83.25]);
    expect(JSON.stringify({ nodes: graph.nodes, adj: graph.adj })).toBe(before);
  });

  it('does not add a sightline whose clear endpoints are separated by a wall or locked door', () => {
    const graph = new NavGraph();
    graph.addNode({ x: 0, y: 0, z: 0 });
    graph.addNode({ x: 10, y: 0, z: 0 });
    const clear = capsuleClear(new CollisionWorld([{ minX: 4.9, maxX: 5.1, minY: 0, maxY: 2.5, minZ: -1, maxZ: 1 }]));
    expect(clear([0, 0, 0], [0, 0, 0])).toBe(true);
    expect(clear([10, 0, 0], [10, 0, 0])).toBe(true);
    const copy = investigationGraph(graph, clear);
    expect(copy.astar(0, 1)).toBeNull();
    expect(copy.adj).toEqual([[], []]);
  });

  it('adds a clear same-storey edge at 40 m and refuses a new edge just beyond that budget', () => {
    for (const distance of [40, 40 + EPS]) {
      const graph = new NavGraph();
      graph.addNode({ x: 0, y: 0, z: 0 });
      graph.addNode({ x: distance, y: 0, z: 0 });
      const copy = investigationGraph(graph, () => true);
      expect(copy.adj[0].includes(1)).toBe(distance === 40);
      expect(copy.adj[1].includes(0)).toBe(distance === 40);
      expect(graph.adj).toEqual([[], []]);
    }
  });

  it('only adds new edges with at most .5 m of height difference', () => {
    for (const height of [.5, .5 + EPS]) {
      const graph = new NavGraph();
      graph.addNode({ x: 0, y: 0, z: 0 });
      graph.addNode({ x: 10, y: height, z: 0 });
      const copy = investigationGraph(graph, () => true);
      expect(copy.adj[0].includes(1)).toBe(height === .5);
      expect(copy.adj[1].includes(0)).toBe(height === .5);
    }
  });

  it('keeps an existing cross-storey connection only when its capsule route remains walkable', () => {
    const graph = new NavGraph();
    graph.chain([{ x: 0, y: 0, z: 0 }, { x: 0, y: 3.6, z: 10 }]);
    expect(investigationGraph(graph, () => true).astar(0, 1)).toEqual([0, 1]);
    expect(investigationGraph(graph, () => false).astar(0, 1)).toBeNull();
    expect(graph.astar(0, 1)).toEqual([0, 1]);
  });

  it('preserves an existing long route when walkable without using it to admit new over-budget edges', () => {
    const graph = new NavGraph();
    graph.chain([{ x: 0, y: 0, z: 0 }, { x: 50, y: 0, z: 0 }]);
    expect(investigationGraph(graph, () => true).astar(0, 1)).toEqual([0, 1]);
    expect(investigationGraph(graph, () => false).astar(0, 1)).toBeNull();
  });

  it('returns a fresh empty graph for empty input', () => {
    const graph = new NavGraph(), copy = investigationGraph(graph, () => true);
    expect(copy).not.toBe(graph);
    expect(copy.nodes).toEqual([]);
    expect(copy.adj).toEqual([]);
    expect(graph.nodes).toEqual([]);
    expect(graph.adj).toEqual([]);
  });
});

describe('investigationPoint', () => {
  const environment = (graph: NavGraph, options: Partial<Parameters<typeof investigationPoint>[0]> = {}) =>
    ({ graph, los: () => true, walkable: () => true, ...options });
  const corridor = (...zs: number[]) => {
    const graph = new NavGraph();
    graph.chain(zs.map(z => ({ x: 0, y: 0, z })));
    return graph;
  };

  it('accepts both 6 m and 13 m standoff boundaries and returns a reachable same-floor sightline', () => {
    expect(TENSION.standOff).toEqual([6, 13]);
    for (const distance of [6, 9, 12, 13]) {
      const graph = corridor(-20, -distance), target = player(1), from: Vec3 = [0, 0, -20];
      const point = investigationPoint(environment(graph), from, target, [target]);
      expect(point).toEqual([0, 0, -distance]);
      expect(graph.astar(graph.nearest(...from), graph.nearest(...point!))).not.toBeNull();
      expect(Math.hypot(point![0] - target.p[0], point![2] - target.p[2])).toBeGreaterThanOrEqual(6);
      expect(Math.hypot(point![0] - target.p[0], point![2] - target.p[2])).toBeLessThanOrEqual(13);
    }
  });

  it('rejects nodes just outside either distance boundary and nodes on another storey', () => {
    const target = player(1), from: Vec3 = [0, 0, -20];
    for (const distance of [6 - EPS, 13 + EPS]) {
      expect(investigationPoint(environment(corridor(-20, -distance)), from, target, [target])).toBeUndefined();
    }
    const graph = new NavGraph();
    graph.chain([{ x: 0, y: 0, z: -20 }, { x: 0, y: .5 + EPS, z: -9 }]);
    expect(investigationPoint(environment(graph), from, target, [target])).toBeUndefined();
  });

  it('requires line of sight to the target rather than selecting a point behind a wall', () => {
    const target = player(1);
    expect(investigationPoint(environment(corridor(-20, -9), { los: () => false }), [0, 0, -20], target, [target])).toBeUndefined();
  });

  it('keeps at least 6 m off every same-floor teammate, including hidden players', () => {
    const graph = corridor(-20, -12, -6), target = player(1), teammate = player(2, { p: [0, 0, -12], f: F_HIDE });
    const point = investigationPoint(environment(graph), [0, 0, -20], target, [target, teammate]);
    expect(point).toEqual([0, 0, -6]);
    expect(Math.hypot(point![0] - teammate.p[0], point![2] - teammate.p[2])).toBeGreaterThanOrEqual(6);
  });

  it('does not treat a teammate on another storey as occupying the standoff point', () => {
    const target = player(1), upstairs = player(2, { p: [0, 3.6, -9] });
    expect(investigationPoint(environment(corridor(-20, -9)), [0, 0, -20], target, [target, upstairs])).toEqual([0, 0, -9]);
  });

  it('rejects a disconnected destination even when the destination has a clear sightline', () => {
    const graph = new NavGraph(), target = player(1);
    graph.addNode({ x: 0, y: 0, z: -20 });
    graph.addNode({ x: 0, y: 0, z: -9 });
    expect(investigationPoint(environment(graph), [0, 0, -20], target, [target])).toBeUndefined();
  });

  it('rejects an intermediate route edge blocked by a closed door', () => {
    const graph = corridor(-20, -15, -9), target = player(1), segments: Vec3[][] = [];
    const env = environment(graph, { walkable: (a, b) => {
      segments.push([[...a], [...b]]);
      return !(a[2] === -15 && b[2] === -9);
    } });
    expect(investigationPoint(env, [0, 0, -20], target, [target])).toBeUndefined();
    expect(segments).toContainEqual([[0, 0, -15], [0, 0, -9]]);
  });

  it('checks the first segment from Warden’s actual off-graph position', () => {
    const graph = corridor(-20, -9), target = player(1), from: Vec3 = [-1, 0, -20];
    const env = environment(graph, { walkable: (a, b) => !(a[0] === -1 && b[0] === 0) });
    expect(investigationPoint(env, from, target, [target])).toBeUndefined();
    expect(from).toEqual([-1, 0, -20]);
  });

  it('returns no point for an empty graph or fully occupied candidates without changing any input', () => {
    const from: Vec3 = [0, 0, -20], target = player(1), teammate = player(2, { p: [0, 0, -9] });
    const graph = corridor(-20, -9), players = [target, teammate];
    const before = JSON.stringify({ from, players, nodes: graph.nodes, adj: graph.adj });
    expect(investigationPoint(environment(new NavGraph()), from, target, players)).toBeUndefined();
    expect(investigationPoint(environment(graph), from, target, players)).toBeUndefined();
    expect(JSON.stringify({ from, players, nodes: graph.nodes, adj: graph.adj })).toBe(before);
  });
});
