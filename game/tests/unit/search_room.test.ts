import { describe, expect, it, vi } from 'vitest';
import { campusNavCached } from '../../client/src/campus/world/navcache.ts';
import { RoomManager, SAFE_S, type Conn, type Room } from '../../server/room.ts';
import { WARDEN_SIGHT_HALF_ANGLE, type WardenAI } from '../../server/ai/warden.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { overlaps } from '../../shared/campus/collision.ts';
import { NAV_CAPSULE, type NavGraph } from '../../shared/campus/nav.ts';
import { inBounds } from '../../shared/level.ts';
import { F_HIDE, ST_DOWN, ST_OK, ST_SPECTATE, type ServerMsg, type Vec3 } from '../../shared/protocol.ts';
import { mulberry32 } from '../../shared/rng.ts';
import { evidenceRoute } from '../../server/ai/evidenceRoute.ts';
import { SEARCH_ANCHOR_LIMIT, type SearchNavGraph } from '../../server/ai/searchPolicy.ts';

const DT = TICK_MS / 1000;
type RoomInternals = { warden: WardenAI; campusMoveOk: (w: Room['world'], a: Vec3, b: Vec3) => boolean; loadLevel: (i: number) => void };
function setup(count = 2, lobby = false, level = 0, seed = 57) {
  const graph = campusNavCached('.cache/campus-nav.json').graph;
  const room = new RoomManager(mulberry32(seed), () => graph).create(lobby, level);
  const messages = Array.from({ length: count }, () => [] as ServerMsg[]);
  const conns: Conn[] = messages.map((got, i) => ({ id: i + 1, name: `search-${i + 1}`, send: m => got.push(structuredClone(m)), sendRaw: s => got.push(JSON.parse(s)) }));
  for (const c of conns) room.add(c, 0);
  const internal = room as unknown as RoomInternals;
  const players = [...room.players.values()];
  // Keep helpers out of perception. The target is deliberately unprotected in each hunt fixture.
  for (const p of players.slice(1)) p.safeUntil = 100_000;
  const run = (seconds: number, afterStep?: () => void) => { for (let i = 0; i < Math.ceil(seconds / DT); i++) { room.step(); afterStep?.(); } };
  return { room, graph, internal, get warden() { return internal.warden; }, messages, conns, players, target: players[0], run };
}
function assertLegalStep(t: ReturnType<typeof setup>, before: Vec3) {
  const after = t.warden.p;
  expect(inBounds(t.room.level, ...after), `mob out of level: ${after}`).toBe(true);
  expect(overlaps(t.room.world, { x: after[0], y: after[1], z: after[2], vy: 0, grounded: true }, NAV_CAPSULE), `mob overlaps campus: ${after}`).toBe(false);
  expect(t.internal.campusMoveOk(t.room.world, before, after), `illegal capsule segment ${before} → ${after}`).toBe(true);
}
function doorChase(t: ReturnType<typeof setup>, id = 1, locked = false) {
  const d = t.room.doors[id];
  t.target.p = [d.x, d.y0 ?? 0, d.z + (id === 5 ? 1.54 : 1.3)];
  t.target.yaw = 0;
  if (!locked) {
    t.players[1].p = [d.x + 1.4, d.y0 ?? 0, d.z + 1.4];
    expect(t.room.toggleDoor(t.players[1], id)).toBe(true);
  }
  const candidates: Vec3[] = [3, 3.2, 3.5, 4, 4.5].map(distance => [d.x, d.y0 ?? 0, d.z - distance]);
  const start: Vec3 = locked ? [d.x, d.y0 ?? 0, d.z - 3.5] : candidates.find(p => t.internal.campusMoveOk(t.room.world, p, [d.x, d.y0 ?? 0, d.z + .4]))!;
  expect(start, 'an open, straight capsule path from the classroom to the real door').toBeDefined();
  expect(overlaps(t.room.world, { x: start[0], y: start[1], z: start[2], vy: 0, grounded: true }, NAV_CAPSULE), 'summoned chase must start outside campus furniture').toBe(false);
  t.warden.forceChase(start, Math.PI, 1, t.target.p);
  if (!locked) {
    t.run(.15);
    expect(t.warden.target, `after summon: ${JSON.stringify({ p: t.warden.p, goal: t.warden.goal, recoveries: t.room.searchRecoveries })}`).toBe(1);
    expect(t.room.toggleDoor(t.players[1], id)).toBe(true);
    expect(t.room.doorOpen[id]).toBe(false);
  }
  return d;
}
function enterWitnessedLocker(t: ReturnType<typeof setup>) {
  const h = t.room.level.def.hides[0];
  const approaches: Vec3[] = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => [h.x + dx, h.y ?? t.target.p[1], h.z + dz]);
  const approach = approaches.find(p => inBounds(t.room.level, ...p) && !overlaps(t.room.world,
    { x: p[0], y: p[1], z: p[2], vy: 0, grounded: true }, NAV_CAPSULE));
  expect(approach, 'the real locker must have a clear entrance').toBeDefined();
  const candidates: Vec3[] = Array.from({ length: 24 }, (_, i) => {
    const angle = i * Math.PI / 12;
    return [approach![0] + 2.8 * Math.cos(angle), approach![1], approach![2] + 2.8 * Math.sin(angle)];
  });
  const start = candidates.find(p => inBounds(t.room.level, ...p) && !overlaps(t.room.world, { x: p[0], y: p[1], z: p[2], vy: 0, grounded: true }, NAV_CAPSULE)
    && t.internal.campusMoveOk(t.room.world, p, approach!)
    && !t.room.noiseBlocked(p[0], p[1] + 1.6, p[2], approach![0], approach![1] + 1.6, approach![2]));
  expect(start, 'a physically clear line to this real locker approach').toBeDefined();
  t.target.p = approach!;
  t.warden.forceChase(start!, Math.atan2(start![0] - approach![0], start![2] - approach![2]), 1, approach!);
  t.run(.1);
  expect(t.warden.target).toBe(1);
  expect(t.room.hideIn(t.target, 0)).toBe(true);
  expect(t.room.search.hidingGoal(1, t.room.tick * DT), 'the entry must actually be witnessed in the real campus').toEqual(approach);
  return approach!;
}

describe('search policy in the genuine campus room', () => {
  it('keeps natural route-recovery rest but an explicit debug summon can catch immediately afterward', () => {
    const t = setup();
    t.target.p = [-48, 0, 73.36];
    t.target.yaw = Math.PI / 2;
    const contact: Vec3 = [...t.target.p];
    const state = t.room as unknown as { searchRestUntil: number };
    const until = state.searchRestUntil = t.room.tick + Math.ceil(20 / DT);
    const before: Vec3 = [...t.warden.p];
    const step = vi.spyOn(t.warden, 'step');
    t.run(.2);
    expect(step).not.toHaveBeenCalled();
    expect(t.warden.p).toEqual(before);
    expect(state.searchRestUntil).toBe(until);
    expect(t.target.st).toBe(ST_OK);

    const started = t.room.tick;
    t.room.handle(t.conns[0], { t: 'debug', op: 'warden', d: 1.5 }, started * TICK_MS);
    while (t.room.tick < started + 40 && t.target.st === ST_OK) t.room.step();
    expect(step).toHaveBeenCalled();
    expect(t.room.tick).toBeLessThan(until);
    expect(t.target.st).toBe(ST_DOWN);
    expect(t.target.p).toEqual(contact);
    expect(t.players[1].st).toBe(ST_OK);
    expect(t.messages[0].find((m) => m.t === 'caught')).toMatchObject({ id: t.target.conn.id, by: 'warden', at: contact });
  }, 120_000);

  it('discards an unsafe legacy follower proposal and catch before publishing, preserving position and voice clock', () => {
    const t = setup(), door = doorChase(t, 5, true), original = t.warden;
    const before: Vec3 = [...t.warden.p];
    const voice = t.warden as unknown as { clock: number };
    voice.clock = 123;
    vi.spyOn(t.warden, 'step').mockImplementationOnce(() => {
      t.warden.p = [...t.target.p];
      t.warden.state = 'catch';
      t.warden.caught = [t.target.conn.id];
    });
    t.room.step();
    expect(t.warden).toBe(original);
    expect(t.warden.p).toEqual(before);
    expect(voice.clock).toBe(123);
    expect(t.room.searchRecoveries).toBe(1);
    expect(t.target.st).toBe(ST_OK);
    expect(t.room.doorOpen[door.id]).toBe(false);
    expect(t.messages[0].some(m => m.t === 'caught')).toBe(false);
    t.run(.5);
    expect(t.warden.p, 'recovery rest must preserve the exact last legal position').toEqual(before);
  }, 120_000);

  it('cleans saturated evidence only at a non-retreating patrol boundary, at the exact old position', () => {
    const t = setup();
    const state = t.room as unknown as { searchNav: SearchNavGraph; stepWarden: (off: boolean) => void };
    t.target.p = [-40, 0, 73.36];
    t.warden.forceChase([-49, 0, 73.36], -Math.PI / 2, 1, t.target.p);
    const oldGraph = state.searchNav;
    for (let i = 0; i < SEARCH_ANCHOR_LIMIT; i++) oldGraph.anchor([-49 + i * .001, 0, 73.36]);
    expect(oldGraph.anchorCount).toBe(SEARCH_ANCHOR_LIMIT);
    state.stepWarden(false);
    expect(state.searchNav, 'a hunt must retain every native route index').toBe(oldGraph);
    t.warden.state = 'patrol';
    const before: Vec3 = [...t.warden.p], reset = vi.spyOn(t.warden, 'reset');
    state.stepWarden(true);
    expect(state.searchNav).not.toBe(oldGraph);
    expect(reset).toHaveBeenCalledOnce();
    const anchor = state.searchNav.nodes[reset.mock.calls[0][0]];
    expect([anchor.x, anchor.y, anchor.z], 'maintenance cannot snap to a nearby source node').toEqual(before);
    expect(state.searchNav.anchorCount).toBeLessThan(SEARCH_ANCHOR_LIMIT / 2);
    assertLegalStep(t, before);
    expect(t.room.searchRecoveries).toBe(0);
  }, 120_000);

  it('an audible campus run reaches the real authoritative catch after patrol and investigation', () => {
    // The protected standing peer keeps the genuine catch observable as a rescue window, rather than a solo wipe.
    const t = setup(2, false, 0, 5), original = t.warden;
    const findSpot = () => t.graph.nodes.find(n => {
      const w = t.warden, distance = Math.hypot(n.x - w.p[0], n.z - w.p[2]);
      const angle = Math.atan2(-(n.x - w.p[0]), -(n.z - w.p[2])) - w.yaw;
      const offset = Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle)));
      return Math.abs(n.y - w.p[1]) < .3 && distance > 5 && distance < 14 && offset > WARDEN_SIGHT_HALF_ANGLE + .1
        && inBounds(t.room.level, n.x, n.y, n.z)
        && !t.room.noiseBlocked(n.x, n.y + 1.6, n.z, w.p[0], w.p[1] + 1.6, w.p[2]);
    });
    let spot: ReturnType<typeof findSpot>;
    for (let i = 0; i < 2000 && !(i >= 100 && (spot = findSpot())); i++) t.room.step();
    expect(spot).toBeDefined();
    t.target.p = [spot!.x, spot!.y, spot!.z];
    const targetClear = !overlaps(t.room.world, { x: spot!.x, y: spot!.y, z: spot!.z, vy: 0, grounded: true }, NAV_CAPSULE);
    const begin = t.room.tick;
    t.room.emitNoise(spot!.x, spot!.z, 20, 'run', spot!.y, 1);
    const path: unknown[] = [];
    for (let i = 0; i < 400 && t.target.st !== ST_DOWN; i++) {
      t.room.step();
      if (i % 10 === 0 && i <= 100) {
        const graph = (t.room as unknown as { searchNav: NavGraph & { source: NavGraph } }).searchNav;
        const exact = (p: Vec3) => graph.nodes.findIndex(n => Math.hypot(n.x - p[0], n.y - p[1], n.z - p[2]) < .0001);
        const from = exact(t.warden.p), goal = exact(t.target.p);
        path.push({ seconds: (t.room.tick - begin) * DT, p: [...t.warden.p], state: t.warden.state, target: t.warden.target,
          goal: t.warden.goal && [...t.warden.goal], originalState: original.state, originalP: [...original.p], recoveries: t.room.searchRecoveries,
          anchors: graph.nodes.slice(graph.source.nodes.length).map((n, offset) => ({ id: graph.source.nodes.length + offset, ...n,
            adj: graph.adj[graph.source.nodes.length + offset] })), exactFrom: from, exactGoal: goal, astar: from >= 0 && goal >= 0 ? graph.astar(from, goal) : null,
          native: { route: [...(t.warden as unknown as { route: number[] }).route], at: (t.warden as unknown as { at: number }).at } });
      }
    }
    const localRoute = t.target.st !== ST_DOWN ? evidenceRoute(t.warden.p, t.target.p,
      (a, b) => t.internal.campusMoveOk(t.room.world, a, b), p => inBounds(t.room.level, ...p)) : undefined;
    const detail = { target: t.target.p, targetClear, replaced: original !== t.warden, localRoute, path };
    if (original !== t.warden || t.target.st !== ST_DOWN) console.info('SEARCH_AUTHORITATIVE_DIAGNOSTIC', JSON.stringify(detail));
    expect(targetClear, 'the selected real nav node must be a legal player capsule').toBe(true);
    expect(t.target.st, `actual server catch missing: ${JSON.stringify(detail)}`).toBe(ST_DOWN);
    expect(t.messages[0].filter(m => m.t === 'caught')).toHaveLength(1);
    expect(t.players[1].st).toBe(ST_OK);
    expect(t.messages[0].filter(m => m.t === 'fade')).toEqual([]);
  }, 120_000);

  it('patrols five real campus seed/level fixtures without recovery or illegal motion', () => {
    for (const [seed, level] of [[1, 0], [7, 0], [19, 0], [1, 1], [7, 1]]) {
      const t = setup(2, true, level, seed);
      t.room.handle(t.conns[0], { t: 'start' }, 0);
      for (let i = 0; i < 20 / DT; i++) {
        const before: Vec3 = [...t.warden.p];
        t.room.step();
        assertLegalStep(t, before);
      }
      expect(t.room.searchRecoveries, `seed=${seed}, level=${level}: ordinary patrol should not rely on recovery`).toBe(0);
    }
  }, 120_000);

  it('uses the last true LOS velocity after a campus wall hides the player, then actually walks toward the prediction', () => {
    const t = setup();
    t.target.p = [-40, 0, 73.36];
    t.warden.forceChase([-49, 0, 73.36], -Math.PI / 2, 1, t.target.p);
    for (let i = 0; i < 12; i++) {
      t.target.p = [t.target.p[0] + .25, 0, 73.36];
      t.room.step();
    }
    const lastVisible = [...t.target.p];
    t.target.p = [-35.65, 0, 68];
    expect(t.room.noiseBlocked(t.warden.p[0], 1.6, t.warden.p[2], t.target.p[0], 1.6, t.target.p[2]), 'genuine classroom wall/closed door must hide the player').toBe(true);
    t.room.step();
    const predicted = t.warden.goal && [...t.warden.goal];
    expect(predicted).not.toBeNull();
    expect(predicted![0], 'lead the last visible rightward velocity').toBeGreaterThan(lastVisible[0] + .5);
    t.target.p = [-50, 0, 67];
    t.room.step();
    expect(t.warden.goal, 'another unseen position cannot retarget the intercept').toEqual(predicted);
    let furthest = t.warden.p[0];
    for (let i = 0; i < 7 / DT; i++) {
      const before: Vec3 = [...t.warden.p];
      t.room.step();
      assertLegalStep(t, before);
      furthest = Math.max(furthest, t.warden.p[0]);
    }
    expect(furthest, 'the predicted goal must affect real movement after replanning').toBeGreaterThan(lastVisible[0] + .5);
  }, 120_000);

  it('reopens an unlocked chase door only nearby, broadcasts its state, and reaches the player with legal capsule steps', () => {
    const t = setup(), d = doorChase(t);
    const sounds: { src?: number; kind: string }[] = [];
    t.room.noise.subscribe(events => sounds.push(...events));
    t.messages.forEach(got => got.splice(0));
    let openedAt: Vec3 | undefined, caught = false;
    for (let i = 0; i < 16 / DT && !caught; i++) {
      const before: Vec3 = [...t.warden.p];
      t.room.step();
      if (t.room.doorOpen[d.id] && !openedAt) openedAt = [...t.warden.p];
      assertLegalStep(t, before);
      caught = t.target.st === ST_DOWN;
    }
    expect(openedAt, 'an unlocked door must not permanently stop pursuit').toBeDefined();
    expect(Math.hypot(openedAt![0] - d.x, openedAt![2] - d.z)).toBeLessThanOrEqual(3.2);
    for (const got of t.messages) expect(got.some(m => m.t === 'snap' && m.doors?.some(q => q.id === d.id && q.open && !q.locked))).toBe(true);
    expect(caught, 'Warden physically crosses the opened doorway and catches').toBe(true);
    expect(t.room.searchRecoveries, 'normal chase should not need a recovery').toBe(0);
    expect(sounds.some(ev => ev.kind === 'door' && ev.src === 0), 'the AI door still emits a physical sound with a distinct source').toBe(true);
  }, 120_000);

  it('refuses to close a real door around Warden standing in its doorway', () => {
    const t = setup(), d = t.room.doors[1];
    t.players[1].p = [d.x + 1.4, 0, d.z + 1.4];
    expect(t.room.toggleDoor(t.players[1], d.id)).toBe(true);
    t.warden.forceChase([d.x, 0, d.z], 0, 1, t.target.p);
    expect(t.room.toggleDoor(t.players[1], d.id)).toBe(false);
    expect(t.room.doorOpen[d.id]).toBe(true);
    t.warden.forceChase([d.x, 0, d.z - 1], 0, 1, t.target.p);
    expect(t.room.toggleDoor(t.players[1], d.id)).toBe(true);
    expect(t.room.doorOpen[d.id]).toBe(false);
  }, 120_000);

  it('never opens or crosses an actually locked campus door, including after old route nodes are consumed', () => {
    const t = setup(), d = doorChase(t, 5, true);
    expect(t.room.doorLocked[d.id]).toBe(true);
    let furthest = -Infinity;
    for (let i = 0; i < 20 / DT; i++) {
      const before: Vec3 = [...t.warden.p];
      t.room.step();
      assertLegalStep(t, before);
      furthest = Math.max(furthest, t.warden.p[2]);
      expect(t.room.doorOpen[d.id]).toBe(false);
      expect(t.warden.p[2], 'closed slab must stop the whole capsule').toBeLessThan(d.box.z0 - NAV_CAPSULE.radius + .02);
      expect(t.target.st).toBe(ST_OK);
      expect(overlaps(t.room.world, { x: t.warden.p[0], y: t.warden.p[1], z: t.warden.p[2], vy: 0, grounded: true }, NAV_CAPSULE)).toBe(false);
    }
    expect(furthest).toBeGreaterThan(d.z - 3.6);
    expect(t.messages[0].filter(m => m.t === 'caught')).toEqual([]);
  }, 120_000);

  it('cannot open a permanently region-locked door even if the team owns its key', () => {
    const t = setup();
    const d = t.room.doors.find(q => t.room.regionLocked.has(q.id) && Math.abs((q.y0 ?? 0) - t.target.p[1]) < .2)!;
    expect(d).toBeDefined();
    t.room.teamKeys.add(d.id);
    t.warden.forceChase([d.x - 1, d.y0 ?? 0, d.z], 0, 1, [d.x + 1, d.y0 ?? 0, d.z]);
    t.target.safeUntil = t.room.tick + 200;
    t.run(3);
    expect(t.room.doorLocked[d.id]).toBe(true);
    expect(t.room.doorOpen[d.id]).toBe(false);
  }, 120_000);

  it('a real locker entered without any sight sample remains secret and cannot be caught by target pressure', () => {
    const t = setup(4), h = t.room.level.def.hides[0];
    expect(h.kind).toBe('locker');
    t.target.p = [h.x + .8, h.y ?? 0, h.z];
    expect(t.room.hideIn(t.target, 0)).toBe(true);
    expect(t.target.f & F_HIDE).toBe(F_HIDE);
    const d = t.room.doors[1];
    t.warden.forceChase([d.x, 0, d.z + 1.3], 0, 1, t.target.p);
    t.run(12);
    expect(t.target.st).toBe(ST_OK);
    expect(t.target.hide?.id).toBe(0);
    expect(t.messages[0].some(m => m.t === 'caught')).toBe(false);
  }, 120_000);

  it('checks a witnessed real locker from its clear approach, with a pause, without entering its solid furniture', () => {
    const t = setup(), approach = enterWitnessedLocker(t);
    t.run(.1);
    expect(t.target.st, 'witnessing entry cannot catch instantly').toBe(ST_OK);
    let checkedNear = 0;
    const path: Vec3[] = [];
    for (let i = 0; i < 8 / DT && t.target.st === ST_OK; i++) {
      const before: Vec3 = [...t.warden.p];
      t.room.step();
      if (i % 20 === 0) path.push([...t.warden.p]);
      assertLegalStep(t, before);
      if (Math.hypot(t.warden.p[0] - approach[0], t.warden.p[2] - approach[2]) < 1.8) checkedNear++;
    }
    expect(checkedNear, `an observable check pause near the cabinet; ${JSON.stringify({ path, approach, goal: t.warden.goal, state: t.warden.state, recoveries: t.room.searchRecoveries })}`).toBeGreaterThanOrEqual(6);
    expect(t.target.st).toBe(ST_DOWN);
    expect(t.target.hide).toBeUndefined();
    expect(t.messages[0].filter(m => m.t === 'caught')).toHaveLength(1);
    expect(t.room.searchRecoveries, 'ordinary cabinet inspection should not need a recovery').toBe(0);
  }, 120_000);

  it('leaving a witnessed locker approach restarts the room inspection timer', () => {
    const t = setup(), approach = enterWitnessedLocker(t);
    const part = t.room.search.difficulty.checkSeconds * .55;
    t.warden.forceChase([...approach], 0, 1, approach);
    t.run(part);
    expect(t.target.hide).toBeDefined();
    // A real, clear corridor position well outside inspection reach; the memory must remain but its hold resets.
    t.warden.forceChase([-45, 0, 73.36], 0, 1, approach);
    t.run(DT);
    t.warden.forceChase([...approach], 0, 1, approach);
    t.run(part);
    expect(t.target.hide, 'separate partial visits must not add up to an inspection').toBeDefined();
    expect(t.target.st).toBe(ST_OK);
    t.run(t.room.search.difficulty.checkSeconds);
    expect(t.target.hide, 'a full continuous return visit must finish the inspection').toBeUndefined();
  }, 120_000);

  it('remembers the actual second-floor entrance when the L2 locker definition omits y', () => {
    const t = setup(2, false, 1), approach = enterWitnessedLocker(t);
    expect(t.room.level.def.hides[0].y).toBeUndefined();
    expect(t.target.p[1]).toBeCloseTo(3.6);
    expect(t.room.search.hidingGoal(1, t.room.tick * DT)?.[1]).toBeCloseTo(3.6);
    t.warden.forceChase([...approach], 0, 1, approach);
    t.run(t.room.search.difficulty.checkSeconds + .2);
    expect(t.target.hide).toBeUndefined();
    expect(t.target.st).toBe(ST_DOWN);
  }, 120_000);

  it('opening grace and explicit mob-safe mode prevent search, hearing, door opening and catch', () => {
    const t = setup(2, true), d = t.room.doors[5];
    t.room.handle(t.conns[0], { t: 'start' }, 0);
    t.target.p = [d.x, 0, d.z + 1.4];
    const start = [...t.warden.p];
    t.room.emitNoise(t.target.p[0], t.target.p[2], 200, 'run', 0, 1);
    t.run(4);
    expect(t.target.st).toBe(ST_OK);
    expect(t.warden.target).toBe(0);
    expect(t.room.doorOpen[d.id]).toBe(false);
    t.room.handle(t.conns[0], { t: 'debug', op: 'safe', s: 10, mob: 1 }, 0);
    t.warden.forceChase([d.x, 0, d.z + 1], 0, 1, t.target.p);
    t.room.emitNoise(t.target.p[0], t.target.p[2], 200, 'item', 0, 1);
    t.run(4);
    expect(t.target.st).toBe(ST_OK);
    expect(t.messages[0].some(m => m.t === 'caught')).toBe(false);
    expect(start).toHaveLength(3);
  }, 120_000);

  it('a genuine revive clears the timeout and stays protected from search-assisted catches for SAFE_S', () => {
    const t = setup();
    t.room.handle(t.conns[0], { t: 'debug', op: 'down', s: 30 }, 0);
    t.players[1].p = [t.target.p[0] + .5, t.target.p[1], t.target.p[2]];
    for (let i = 0; i < 4 / DT && t.target.st !== ST_OK; i++) { expect(t.room.act(t.players[1], 'revive', 1)).toBe(true); t.room.step(); }
    expect(t.target.st).toBe(ST_OK);
    expect(t.target.heldUntil).toBeUndefined();
    const from = t.room.tick;
    for (let i = 0; i < (SAFE_S - .1) / DT; i++) {
      t.warden.forceChase([t.target.p[0], t.target.p[1], t.target.p[2] - 1], Math.PI, 1, t.target.p);
      t.room.emitNoise(t.target.p[0], t.target.p[2], 100, 'run', t.target.p[1], 1);
      t.room.step();
      expect(t.target.st).toBe(ST_OK);
    }
    expect(t.target.safeUntil).toBeGreaterThan(t.room.tick);
    expect(t.messages[0].filter(m => m.t === 'caught')).toEqual([]);
    expect(t.room.tick - from).toBeGreaterThanOrEqual(95);
  }, 120_000);

  it('spectators do not become pressure targets and leaving never preserves an actionable hunt', () => {
    const t = setup(4);
    for (const p of t.players.slice(1)) { p.st = ST_SPECTATE; p.safeUntil = undefined; }
    const d = t.room.doors[1];
    t.target.p = [d.x, 0, d.z + 1.3];
    t.warden.forceChase([d.x + 4, 0, d.z + 1.3], Math.PI / 2, 1, t.target.p);
    t.run(.2);
    expect(t.warden.target).toBe(1);
    t.room.remove(t.conns[0], 1);
    t.run(3);
    expect(t.warden.target).toBe(0);
    expect(t.players.slice(1).every(p => p.st === ST_SPECTATE)).toBe(true);
  }, 120_000);

  it('a four-survivor team hears a real corridor noise farther away, while spectators and protected sources add no evidence', () => {
    const heard = (count: number, spectators: boolean, protectedSource = false) => {
      const t = setup(count);
      t.warden.p = [-45, 0, 73.36];
      t.warden.state = 'patrol';
      t.target.p = [-32.5, 0, 73.36];
      if (protectedSource) t.target.safeUntil = 100_000;
      if (spectators) for (const p of t.players.slice(1)) p.st = ST_SPECTATE;
      expect(t.room.noiseBlocked(-45, 1, 73.36, -32.5, 1, 73.36), 'the hearing fixture must be a clear real corridor').toBe(false);
      t.room.emitNoise(-32.5, 73.36, 10, 'run', 0, 1);
      t.room.noise.flush(t.room.tick);
      return { state: t.warden.state, multiplier: t.room.search.difficulty.hearingMultiplier };
    };
    expect(heard(1, false).state).toBe('patrol');
    expect(heard(4, false).state).toBe('investigate');
    expect(heard(4, true)).toEqual(heard(1, false));
    expect(heard(4, false, true).state).toBe('patrol');
  }, 120_000);

  it('real L4 point-name evidence respects opening, source protection, mob-safe, recovery rest and authoritative hiding', () => {
    for (const mode of ['normal', 'opening', 'protected', 'mob-safe', 'rest', 'hidden'] as const) {
      const t = setup(1, false, 3);
      t.target.p = [-28, 10.8, 130];
      t.room.tick = 1199;
      if (mode === 'opening') (t.room as unknown as { huntFrom: number }).huntFrom = 1300;
      if (mode === 'protected') t.target.safeUntil = 1300;
      if (mode === 'mob-safe') t.room.handle(t.conns[0], { t: 'debug', op: 'safe', s: 20, mob: 1 }, 0);
      if (mode === 'rest') (t.room as unknown as { searchRestUntil: number }).searchRestUntil = 1300;
      if (mode === 'hidden') {
        const h = t.room.level.def.hides[0];
        t.target.p = [h.x + .6, h.y ?? 7.2, h.z];
        expect(t.room.hideIn(t.target, 0)).toBe(true);
      }
      const station = t.room.broadcastStation!;
      station.call = { id: 1, until: 70 };
      station.nextAt = 1000;
      const heard = vi.spyOn(t.warden, 'hear');
      t.room.step();
      if (mode === 'normal') expect(heard).toHaveBeenCalledTimes(1);
      else expect(heard, `${mode} must suppress point-name evidence`).not.toHaveBeenCalled();
      if (mode === 'hidden') {
        const message = t.messages[0].find(m => m.t === 'broadcast' && m.call?.shielded);
        expect(message).toBeDefined();
        expect(message?.t === 'broadcast' && message.call?.p).toBeUndefined();
      }
      heard.mockRestore();
    }
  }, 120_000);
});
