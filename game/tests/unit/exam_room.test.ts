import { beforeAll, describe, expect, it, vi } from 'vitest';
import { campusNavCached } from '../../client/src/campus/world/navcache.ts';
import { EXAM_PENALTY_S, LEVEL_FADE_S, Room, RoomManager, levelAreaNav, type Conn } from '../../server/room.ts';
import { CollisionWorld, groundHeight, overlaps } from '../../shared/campus/collision.ts';
import { lineOfSight, NAV_CAPSULE, type NavGraph } from '../../shared/campus/nav.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { campusDoorSlab } from '../../shared/doors.ts';
import { generateExam } from '../../shared/exam.ts';
import { inBounds, levelSolids, LEVELS } from '../../shared/level.ts';
import { L7 } from '../../shared/levels/l7.ts';
import { L6 } from '../../shared/levels/l6.ts';
import { linesFor } from '../../shared/lines.ts';
import { F_HIDE, parseClientMsg, ST_DOWN, ST_OK, ST_SPECTATE, type ClientMsg, type ServerMsg, type Vec3 } from '../../shared/protocol.ts';
import { mulberry32 } from '../../shared/rng.ts';

type ExamState = Extract<ServerMsg, { t: 'exam' }>;
const makeConn = (id: number) => {
  const got: ServerMsg[] = [];
  const c: Conn = { id, name: `exam-${id}`, send: (m) => got.push(m), sendRaw: (s) => got.push(JSON.parse(s)) };
  return { c, got };
};
const lastExam = (got: ServerMsg[]): ExamState => {
  const m = got.findLast((m): m is ExamState => m.t === 'exam');
  if (!m) throw new Error('Expected an authoritative shared paper');
  return m;
};
const setup = (nav?: NavGraph) => {
  const room = new Room('EXAM', 48, nav, 5);
  const a = makeConn(1), b = makeConn(2);
  room.add(a.c, 0); room.add(b.c, 0);
  const beside: Vec3 = [L6.exam!.paper.x, 10.8, L6.exam!.paper.z + 0.74];
  room.players.get(1)!.p = [...beside]; room.players.get(2)!.p = [...beside];
  return { room, a, b, beside };
};
type Fixture = ReturnType<typeof setup>;
const answer = ({ room, a }: Fixture, question: number, choice: number) =>
  room.handle(a.c, { t: 'exam', op: 'answer', question, choice, revision: lastExam(a.got).revision }, 0);
const fill = (fx: Fixture, wrong = false) => {
  const choices = generateExam(fx.room.seed).map((q) => q.correct);
  choices.forEach((choice, question) => answer(fx, question, wrong && question === 0 ? (choice + 1) % 4 : choice));
};
const submit = ({ room, a }: Fixture) => room.handle(a.c, { t: 'exam', op: 'submit', revision: lastExam(a.got).revision }, 0);
const advance = (room: Room, seconds: number) => { for (let i = 0; i < Math.ceil(seconds * 1000 / TICK_MS); i++) room.step(); };

describe('exam wire input validation', () => {
  it('accepts only a known operation, five question indices, four choice indices and safe revisions', () => {
    const good = { t: 'exam', op: 'answer', question: 4, choice: 3, revision: 0 };
    expect(parseClientMsg(JSON.stringify(good))).toEqual(good);
    expect(parseClientMsg('{"t":"exam","op":"submit","revision":12}')).toEqual({ t: 'exam', op: 'submit', revision: 12 });
    for (const extra of [{ question: -1 }, { question: 5 }, { question: 1.1 }, { question: '1' }, { choice: -1 }, { choice: 4 }, { choice: 0.5 }, { choice: null }, { revision: -1 }, { revision: 0.2 }, { revision: '0' }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { op: 'pass' }]) {
      expect(parseClientMsg(JSON.stringify({ ...good, ...extra })), JSON.stringify(extra)).toBeNull();
    }
    expect(parseClientMsg('{"t":"exam","op":"submit"}')).toBeNull();
  });
});

describe('authoritative shared exam paper', () => {
  it('registers the real sixth chapter while the default RoomManager starts at chapter one', () => {
    const ordinary = new RoomManager(mulberry32(3)).create(true);
    expect(ordinary.levelIndex).toBe(0);
    expect(LEVELS).toHaveLength(8);
    expect(LEVELS[5]).toBe(L6);
    const room = new RoomManager(mulberry32(3)).create(true, 5), a = makeConn(1);
    room.add(a.c, 0);
    expect(room.levelIndex).toBe(5); expect(room.level.def).toBe(L6);
    expect(a.got.find((m) => m.t === 'room')).toMatchObject({ level: 5, started: false });
    expect(a.got.some((m) => m.t === 'exam')).toBe(false);
    room.handle(a.c, { t: 'start' }, 0);
    expect(lastExam(a.got)).toMatchObject({ answers: [null, null, null, null, null], revision: 0, passed: false, cooldown: 0 });
    expect(a.got.findLast((m) => m.t === 'room')).toMatchObject({ level: 5, started: true });
  });

  it('places separate real lockers on both storeys and prevents using another storey or occupied locker', () => {
    const { room, a, b } = setup(), third = makeConn(3), lowerId = 0;
    const h = L6.hides[lowerId], upperId = L6.hides.findIndex((u) => u.x === h.x && u.z === h.z && u.y === 14.4);
    room.add(third.c, 0);
    const lower = room.players.get(1)!, upper = room.players.get(2)!, waiting = room.players.get(3)!;
    lower.p = [h.x + 0.6, 10.8, h.z]; upper.p = [h.x + 0.6, 14.4, h.z]; waiting.p = [...lower.p];
    room.handle(a.c, { t: 'act', kind: 'hide', id: lowerId }, 0);
    room.handle(b.c, { t: 'act', kind: 'hide', id: lowerId }, 0);
    expect(lower.hide?.id).toBe(lowerId); expect(upper.hide).toBeUndefined();
    room.handle(b.c, { t: 'act', kind: 'hide', id: upperId }, 0);
    expect(upper.hide?.id).toBe(upperId);
    expect(lower.p).toEqual([h.x, 10.8, h.z]); expect(upper.p).toEqual([h.x, 14.4, h.z]);
    room.handle(third.c, { t: 'act', kind: 'hide', id: lowerId }, 0); expect(waiting.hide).toBeUndefined();
    room.handle(a.c, { t: 'act', kind: 'unhide', id: lowerId }, 0);
    room.handle(third.c, { t: 'act', kind: 'hide', id: lowerId }, 0);
    expect(waiting.hide?.id).toBe(lowerId); expect(upper.hide?.id).toBe(upperId);
  });

  it('broadcasts one shared answer array and resolves concurrent writes with revisions', () => {
    const fx = setup(), { room, a, b } = fx;
    answer(fx, 0, 2);
    expect(lastExam(a.got)).toEqual(lastExam(b.got));
    expect(lastExam(b.got)).toMatchObject({ answers: [2, null, null, null, null], revision: 1 });
    const count = a.got.length;
    room.handle(b.c, { t: 'exam', op: 'answer', question: 0, choice: 1, revision: 0 }, 0);
    expect(a.got).toHaveLength(count); // stale sender is resynced; no broadcast or lost team update
    expect(lastExam(b.got)).toMatchObject({ answers: [2, null, null, null, null], revision: 1 });
    room.handle(b.c, { t: 'exam', op: 'answer', question: 1, choice: 3, revision: 1 }, 0);
    expect(lastExam(a.got)).toMatchObject({ answers: [2, 3, null, null, null], revision: 2 });
    const revision = lastExam(a.got).revision;
    const senderCount = a.got.length, teammateCount = b.got.length;
    answer(fx, 0, 2);
    expect(lastExam(a.got).revision).toBe(revision); // idempotent click is no mutation
    expect(a.got).toHaveLength(senderCount + 1); // still acknowledge so a waiting client can clear its pending state
    expect(b.got).toHaveLength(teammateCount); // no redundant broadcast to the team
    expect(lastExam(a.got)).toEqual(lastExam(b.got));
  });

  it('rejects remote, different-floor, hidden, downed, spectator and wall-obstructed edits and submits', () => {
    const fx = setup(), { room, a, beside } = fx, pl = room.players.get(a.c.id)!;
    fill(fx, true);
    const initial = lastExam(a.got), count = a.got.length;
    const blocked = () => {
      room.handle(a.c, { t: 'exam', op: 'answer', question: 0, choice: (initial.answers[0]! + 1) % 4, revision: initial.revision }, 0);
      room.handle(a.c, { t: 'exam', op: 'submit', revision: initial.revision }, 0);
      expect(a.got).toHaveLength(count);
      expect(lastExam(a.got)).toEqual(initial);
    };
    pl.p = [beside[0] + 20, beside[1], beside[2]]; blocked();
    pl.p = [beside[0], 14.4, beside[2]]; blocked();
    pl.p = [...beside]; pl.st = ST_DOWN; blocked();
    pl.st = ST_SPECTATE; blocked(); pl.st = ST_OK;
    pl.hide = { id: 0, out: [...beside], crouch: false }; blocked(); pl.hide = undefined;
    pl.f = F_HIDE; blocked(); pl.f = 0;
    // Within normal reach, but on the far side of the lectern room's solid north wall.
    pl.p = [beside[0], 10.8, 71.5]; blocked();
  });

  it('validates direct calls too, and ignores exam operations in ordinary levels', () => {
    const fx = setup();
    for (const [question, choice] of [[-1, 0], [5, 0], [0.2, 0], [0, -1], [0, 4], [0, 0.5]]) answer(fx, question, choice);
    expect(lastExam(fx.a.got).answers).toEqual([null, null, null, null, null]);
    const room = new Room('L1', 2), a = makeConn(1); room.add(a.c, 0);
    room.handle(a.c, { t: 'exam', op: 'answer', question: 0, choice: 1, revision: 0 }, 0);
    expect(a.got.some((m) => m.t === 'exam')).toBe(false);
  });

  it('does not mistake an unknown direct operation for the explicit submit action', () => {
    const fx = setup(); fill(fx);
    const before = lastExam(fx.a.got), sent = fx.a.got.length;
    fx.room.handle(fx.a.c, { t: 'exam', op: 'pass', revision: before.revision } as unknown as ClientMsg, 0);
    expect(fx.a.got).toHaveLength(sent);
    expect(lastExam(fx.a.got)).toEqual(before);
    expect(before.passed).toBe(false);
    submit(fx);
    expect(lastExam(fx.a.got).passed).toBe(true);
  });

  it('requires all five answers before grading and does not punish an incomplete submission', () => {
    const fx = setup(), fail = vi.spyOn(fx.room, 'puzzleFailed');
    answer(fx, 0, 1); submit(fx);
    expect(lastExam(fx.a.got)).toMatchObject({ answers: [1, null, null, null, null], passed: false, revision: 1, cooldown: 0 });
    expect(lastExam(fx.a.got).feedback).toContain('未作答');
    expect(lastExam(fx.a.got).blackout).toBeUndefined(); expect(fail).not.toHaveBeenCalled();
  });

  it('grades only on submit, shares the pass, and makes a passed paper immutable', () => {
    const fx = setup(); fill(fx);
    expect(lastExam(fx.a.got).passed).toBe(false);
    submit(fx);
    const passed = lastExam(fx.a.got);
    expect(passed).toMatchObject({ passed: true, revision: 6, cooldown: 0 });
    expect(lastExam(fx.b.got)).toEqual(passed);
    answer(fx, 0, (passed.answers[0]! + 1) % 4); submit(fx);
    expect(lastExam(fx.a.got)).toEqual(passed);
    expect(JSON.stringify(passed)).not.toContain('correct');
  });

  it('physically locks the exit until an accepted submission, opens it for late joiners, and relocks on a wipe', () => {
    const fx = setup(), { room, a } = fx, pl = room.players.get(a.c.id)!, gate = L6.exam!.exitGate!;
    const z = (gate.z0 + gate.z1) / 2;
    const from: Vec3 = [gate.x1 + 0.65, gate.y, z], to: Vec3 = [gate.x0 - 0.65, gate.y, z];
    let seq = 0;
    const cross = (now: number) => {
      pl.p = [...from];
      room.handle(a.c, { t: 'input', seq: ++seq, p: [...to], yaw: Math.PI / 2, pitch: 0, f: 0 }, now);
    };
    room.bag.stair_key = 1;
    fill(fx); // even five correct choices and a stair key do not open the physical door
    cross(1000);
    expect(pl.p).toEqual(from);
    expect(a.got.findLast((m) => m.t === 'correct')).toMatchObject({ ack: 1, p: from });
    pl.p = [...fx.beside]; submit(fx);
    cross(2000);
    expect(pl.p).toEqual(to);
    expect(a.got.filter((m) => m.t === 'correct' && m.ack === 2)).toHaveLength(0);
    const late = makeConn(3); room.add(late.c, 2000);
    expect(lastExam(late.got).passed).toBe(true);

    for (const p of room.players.values()) p.st = ST_SPECTATE;
    room.step(); advance(room, LEVEL_FADE_S);
    expect(lastExam(a.got).passed).toBe(false);
    cross(3000);
    expect(pl.p).toEqual(from);
    expect(a.got.findLast((m) => m.t === 'correct')).toMatchObject({ ack: 3, p: from });
  });

  it('punishes one completed wrong submission once, locks all edits for ten seconds, and restores on tick', () => {
    const fx = setup(), { room, a, b } = fx, fail = vi.spyOn(room, 'puzzleFailed');
    fill(fx, true); submit(fx);
    const penalty = lastExam(a.got);
    expect(penalty).toMatchObject({ passed: false, revision: 6, cooldown: EXAM_PENALTY_S, blackout: { floor: 3, seconds: 10 } });
    expect(lastExam(b.got)).toEqual(penalty); expect(fail).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 25; i++) {
      room.handle(b.c, { t: 'exam', op: 'submit', revision: i % 2 ? 5 : 6 }, 0);
      room.handle(b.c, { t: 'exam', op: 'answer', question: 0, choice: (penalty.answers[0]! + 1) % 4, revision: 6 }, 0);
    }
    expect(lastExam(b.got)).toEqual(penalty); expect(fail).toHaveBeenCalledTimes(1);
    advance(room, 9.95);
    room.handle(a.c, { t: 'exam', op: 'submit', revision: 6 }, 0);
    expect(lastExam(a.got).cooldown).toBeCloseTo(0.05);
    expect(fail).toHaveBeenCalledTimes(1);
    room.step();
    const restored = lastExam(a.got);
    expect(restored).toMatchObject({ answers: penalty.answers, passed: false, cooldown: 0, revision: 7 });
    expect(restored.blackout).toBeUndefined(); expect(lastExam(b.got)).toEqual(restored);
    expect(a.got.some((m) => m.t === 'trip')).toBe(false);
    answer(fx, 0, generateExam(room.seed)[0].correct); submit(fx);
    expect(lastExam(a.got).passed).toBe(true);
  });

  it('does not add generic random floor trips to the exam lighting mechanism', () => {
    const fx = setup();
    advance(fx.room, 145);
    expect(fx.a.got.some((m) => m.t === 'trip')).toBe(false);
    expect(lastExam(fx.a.got)).toMatchObject({ cooldown: 0, passed: false });
  });

  it('keeps the penalty after its submitter disconnects and only rearms it on a new post-cooldown submission', () => {
    const fx = setup(), { room, a, b } = fx, fail = vi.spyOn(room, 'puzzleFailed');
    fill(fx, true); submit(fx);
    const penalty = lastExam(b.got);
    room.remove(a.c, 100);
    advance(room, 9.9);
    room.handle(b.c, { t: 'exam', op: 'submit', revision: penalty.revision }, 1000);
    expect(lastExam(b.got)).toMatchObject({ revision: penalty.revision, cooldown: 0.1, blackout: { floor: 3, seconds: 0.1 } });
    expect(fail).toHaveBeenCalledTimes(1);
    advance(room, 0.1);
    const restored = lastExam(b.got);
    expect(restored).toMatchObject({ revision: penalty.revision + 1, cooldown: 0, answers: penalty.answers });
    expect(restored.blackout).toBeUndefined();
    room.handle(b.c, { t: 'exam', op: 'answer', question: 0, choice: generateExam(room.seed)[0].correct, revision: penalty.revision }, 1000);
    expect(lastExam(b.got)).toEqual(restored); // an edit queued before restoration cannot overwrite the fresh revision
    room.handle(b.c, { t: 'exam', op: 'submit', revision: restored.revision }, 1000);
    expect(lastExam(b.got)).toMatchObject({ revision: restored.revision + 1, passed: false, cooldown: 10, blackout: { floor: 3, seconds: 10 } });
    expect(fail).toHaveBeenCalledTimes(2);
  });

  it('sends late joiners the shared answers and exact remaining penalty, including spectator joins', () => {
    const fx = setup(); fill(fx, true); submit(fx); advance(fx.room, 3.25);
    fx.room.lateObserve = true;
    const late = makeConn(3); fx.room.add(late.c, 1000);
    expect(fx.room.players.get(3)!.st).toBe(ST_SPECTATE);
    expect(lastExam(late.got)).toMatchObject({ answers: lastExam(fx.a.got).answers, cooldown: 6.75, blackout: { floor: 3, seconds: 6.75 }, revision: 6 });
    fx.room.players.get(3)!.p = [...fx.beside];
    fx.room.handle(late.c, { t: 'exam', op: 'answer', question: 0, choice: 0, revision: 6 }, 0);
    expect(lastExam(fx.a.got).revision).toBe(6);
  });

  it('gates exit on passing even if a stair key is forged, and waits for every living teammate', () => {
    const fx = setup(), { room, a, b } = fx;
    const exit: Vec3 = [L6.exit.x, L6.exit.y, L6.exit.z];
    room.bag.stair_key = 1;
    for (const p of room.players.values()) p.p = [...exit];
    room.step(); expect(a.got.some((m) => m.t === 'fade')).toBe(false);
    for (const p of room.players.values()) p.p = [...fx.beside];
    fill(fx); submit(fx);
    room.players.get(a.c.id)!.p = [...exit]; room.step();
    expect(a.got.some((m) => m.t === 'fade')).toBe(false);
    const other = room.players.get(b.c.id)!;
    other.p = [...exit]; other.st = ST_DOWN;
    room.step(); expect(a.got.some((m) => m.t === 'fade')).toBe(false);
    other.st = ST_OK; room.step();
    expect(a.got.filter((m) => m.t === 'fade')).toEqual([{ t: 'fade', secs: LEVEL_FADE_S, restart: false }]);
    advance(room, LEVEL_FADE_S);
    expect(room.levelIndex).toBe(6); expect(room.level.def).toBe(L7);
    expect(room.completed).toBe(false);
    expect(a.got.filter((m) => m.t === 'complete')).toEqual([]);
    expect(lastExam(a.got).passed).toBe(true);
  });

  it('sends a passed paper to a late spectator and does not add that observer to the exit quorum', () => {
    const fx = setup(); fill(fx); submit(fx);
    fx.room.lateObserve = true;
    const late = makeConn(3); fx.room.add(late.c, 1000);
    expect(fx.room.players.get(3)!.st).toBe(ST_SPECTATE);
    expect(lastExam(late.got)).toEqual(lastExam(fx.a.got));
    for (const id of [1, 2]) fx.room.players.get(id)!.p = [L6.exit.x, L6.exit.y, L6.exit.z];
    fx.room.step();
    expect(late.got.findLast((m) => m.t === 'fade')).toMatchObject({ restart: false });
    advance(fx.room, LEVEL_FADE_S);
    expect(fx.room.players.get(3)!.st).toBe(ST_OK);
    expect(fx.room.level.def).toBe(L7);
    expect(lastExam(late.got).passed).toBe(true);
    expect(late.got.filter((m) => m.t === 'complete')).toEqual([]);
  });

  it('advances beyond the exam when a following chapter is registered', () => {
    const released = [...LEVELS], next = { ...L6, name: '下一关', exam: undefined };
    try {
      LEVELS[6] = next;
      const fx = setup(); fill(fx); submit(fx);
      for (const p of fx.room.players.values()) p.p = [L6.exit.x, L6.exit.y, L6.exit.z];
      fx.room.step();
      expect(fx.a.got.findLast((m) => m.t === 'fade')).toMatchObject({ restart: false });
      advance(fx.room, LEVEL_FADE_S);
      expect(fx.room.levelIndex).toBe(6);
      expect(fx.room.level.def).toBe(next);
      expect(fx.room.completed).toBe(false);
      expect(fx.a.got.some((m) => m.t === 'complete')).toBe(false);
    } finally {
      LEVELS.splice(0, LEVELS.length, ...released);
    }
  });

  it('ignores spectators in the passed exit quorum and resets a wipe without accepting in-flight old revisions', () => {
    const fx = setup(); fill(fx); submit(fx);
    fx.room.players.get(1)!.p = [L6.exit.x, L6.exit.y, L6.exit.z];
    fx.room.players.get(2)!.st = ST_SPECTATE;
    fx.room.step();
    expect(fx.a.got.findLast((m) => m.t === 'fade')).toMatchObject({ restart: false });

    const wipe = setup(); fill(wipe, true); submit(wipe);
    const oldRevision = lastExam(wipe.a.got).revision;
    for (const p of wipe.room.players.values()) p.st = ST_SPECTATE;
    wipe.room.step();
    expect(wipe.a.got.findLast((m) => m.t === 'fade')).toMatchObject({ restart: true });
    // Even a valid player placed next to the paper cannot change it during the fade.
    wipe.room.players.get(1)!.st = ST_OK;
    answer(wipe, 0, generateExam(wipe.room.seed)[0].correct);
    expect(lastExam(wipe.a.got).revision).toBe(oldRevision);
    advance(wipe.room, LEVEL_FADE_S);
    const reset = lastExam(wipe.a.got);
    expect(wipe.room.levelIndex).toBe(5);
    expect(reset).toMatchObject({ answers: [null, null, null, null, null], passed: false, cooldown: 0 });
    expect(reset.blackout).toBeUndefined(); expect(reset.revision).toBeGreaterThan(oldRevision);
    wipe.room.players.get(1)!.p = [...wipe.beside];
    wipe.room.handle(wipe.a.c, { t: 'exam', op: 'answer', question: 0, choice: 0, revision: oldRevision }, 0);
    expect(lastExam(wipe.a.got)).toEqual(reset);
  });
});

describe('exam punishment on the real campus navigation graph', () => {
  let nav: NavGraph;
  beforeAll(() => { nav = campusNavCached('.cache/campus-nav.json').graph; }, 120_000);

  it('spawns exactly one monitor and puts Warden behind the nearest valid door on a collision-free connected node', () => {
    const fx = setup(nav), { room } = fx;
    const warden = (room as unknown as { warden: { p: Vec3 } }).warden;
    const previous = [...warden.p];
    fill(fx, true); submit(fx);
    const p = warden.p;
    expect(p).not.toEqual(previous);
    const d = room.doors[67];
    expect(p[0]).toBeGreaterThan(d.x + NAV_CAPSULE.radius);
    expect(Math.hypot(p[0] - d.x, p[2] - d.z)).toBeLessThan(4);
    expect(p[1]).toBeCloseTo(10.8);
    expect(inBounds(room.level, ...p)).toBe(true);
    const body = { x: p[0], y: p[1], z: p[2], vy: 0, grounded: true };
    const doors = new CollisionWorld(room.doors.map((d) => campusDoorSlab(d, room.doorOpen[d.id])));
    for (const w of [room.world, doors, new CollisionWorld(levelSolids(L6))]) expect(overlaps(w, body, NAV_CAPSULE)).toBe(false);
    expect(groundHeight(room.world, p[0], p[2], NAV_CAPSULE.radius, p[1] + NAV_CAPSULE.stepHeight)).toBeCloseTo(p[1]);
    const area = levelAreaNav(nav, room.level), at = area.nearest(...p);
    expect(area.nodes[at]).toMatchObject({ x: p[0], y: p[1], z: p[2] });
    expect(area.reachable(at).size).toBeGreaterThan(1);
    const eye = { x: fx.beside[0], y: fx.beside[1] + 1.6, z: fx.beside[2] };
    expect(lineOfSight(doors, eye, { x: p[0], y: p[1] + 1.6, z: p[2] })).toBe(false);
    room.step();
    const snap = fx.a.got.findLast((m): m is Extract<ServerMsg, { t: 'snap' }> => m.t === 'snap')!;
    expect(snap.mobs.filter((m) => m.kind === 'monitor')).toHaveLength(1);
    expect(snap.mobs.find((m) => m.id === 1)).toMatchObject({ kind: 'warden', target: 1 });
    const lines = fx.a.got.filter((m): m is Extract<ServerMsg, { t: 'event' }> => m.t === 'event');
    expect(lines).toHaveLength(1);
    expect(linesFor('fail').map((l) => l.id)).toContain(lines[0].id); // summon cannot add a debug spot line over the failure line
    // Pursuit may physically open an unlocked door. Check the current slabs, including the opening leaf,
    // rather than colliding against a frozen copy of the doorway from before the authoritative opening.
    let crossed = false;
    for (let i = 0; i < 60; i++) {
      const body = { x: warden.p[0], y: warden.p[1], z: warden.p[2], vy: 0, grounded: true };
      if (!room.doorOpen[d.id]) expect(warden.p[0]).toBeGreaterThan(d.x + NAV_CAPSULE.radius);
      const liveDoors = new CollisionWorld(room.doors.map(door => campusDoorSlab(door, room.doorOpen[door.id])));
      for (const w of [room.world, liveDoors, new CollisionWorld(levelSolids(L6))]) expect(overlaps(w, body, NAV_CAPSULE)).toBe(false);
      crossed ||= warden.p[0] < d.x - NAV_CAPSULE.radius;
      room.step();
    }
    const opened = fx.a.got.find((m): m is Extract<ServerMsg, { t: 'snap' }> => m.t === 'snap' && !!m.doors?.some(door => door.id === d.id && door.open));
    expect(opened, 'the AI opening must be delivered as a real door delta').toBeDefined();
    const openingPosition = opened!.mobs.find(m => m.id === 1)!.p;
    expect(Math.hypot(openingPosition[0] - d.x, openingPosition[2] - d.z)).toBeLessThanOrEqual(2.2);
    expect(room.doorOpen[d.id]).toBe(true);
    expect(crossed, 'the same pursuit must physically cross the opened doorway').toBe(true);
    expect(fx.a.got.some((m) => m.t === 'trip')).toBe(false); // forced chase cannot start a second, longer blackout
  });

  it('skips a region-locked nearest door and a doorway without a usable far-side nav node', () => {
    const fx = setup(nav), { room } = fx;
    room.regionLocked.add(67);
    fill(fx, true); submit(fx);
    const p = (room as unknown as { warden: { p: Vec3 } }).warden.p;
    // The next-nearest door 68 lacks a matching far-side node; 58 is the nearest usable doorway.
    const d = room.doors[58];
    expect(p[2]).toBeLessThan(d.z - NAV_CAPSULE.radius);
    expect(Math.hypot(p[0] - d.x, p[2] - d.z)).toBeLessThan(4);
    expect(p[1]).toBeCloseTo(10.8);
    const body = { x: p[0], y: p[1], z: p[2], vy: 0, grounded: true };
    const doors = new CollisionWorld(room.doors.map((door) => campusDoorSlab(door, room.doorOpen[door.id])));
    for (const w of [room.world, doors, new CollisionWorld(levelSolids(L6))]) expect(overlaps(w, body, NAV_CAPSULE)).toBe(false);
    expect(inBounds(room.level, ...p)).toBe(true);
  });
});
