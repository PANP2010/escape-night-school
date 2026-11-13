import { describe, expect, it } from 'vitest';
import { campusNavCached } from '../../client/src/campus/world/navcache.ts';
import { Room, royaleZoneTiming } from '../../server/room.ts';
import type { WardenAI } from '../../server/ai/warden.ts';
import type { SearchNavGraph } from '../../server/ai/searchPolicy.ts';
import type { NavGraph } from '../../shared/campus/nav.ts';
import { CollisionWorld } from '../../shared/campus/collision.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { ST_OK, ST_SPECTATE, type ServerMsg, type Vec3 } from '../../shared/protocol.ts';
import { ZONE_GRACE_S, ZONE_OUT_ELIM_S, ZONE_PHASE_S, inRoyaleArea, inZone, type ZonePhase } from '../../shared/royale.ts';
import { generateLevel, inBounds, LEVELS } from '../../shared/level.ts';
import { roomIntroReady } from './room-intro-fixture.ts';

const graph = campusNavCached('.cache/campus-nav.json').graph;

type Internals = {
  royaleZonePhase: number;
  royaleOutTime: Map<number, number>;
  royaleAlive: Set<number>;
  doors: { id: number; x: number; z: number }[];
  royaleZones: ReadonlyArray<ZonePhase>;
  completed: boolean;
};

/** A started royale room on the real campus nav (as in production), `count` players, ids 1..count. */
const setup = (count = 3) => {
  const room = new Room('A2C', 42, graph, 0, 'standard', { mode: 'royale' });
  const messages: ServerMsg[][] = Array.from({ length: count }, () => []);
  for (let i = 0; i < count; i++) {
    room.add({ id: i + 1, name: `P${i + 1}`, send: (m) => messages[i].push(structuredClone(m)), sendRaw: (s) => messages[i].push(JSON.parse(s)) }, 0);
  }
  room.started = false; // a Room is born started; lobby rooms flip it off until the host presses start
  const players = [...room.players.values()];
  const ready = roomIntroReady(players.map((p) => p.conn));
  room.handle(players[0].conn, { t: 'start' }, 0);
  ready(room);
  messages.forEach((m) => m.splice(0));
  const it = room as unknown as Internals;
  /** Park a player at a world x/z (server-side position; no client message involved). */
  const park = (i: number, x: number, z: number) => { players[i].p = [x, 0, z]; };
  const inside = (i: number) => park(i, it.royaleZones[0].center[0], it.royaleZones[0].center[1]);
  return { room, it, messages, players, park, inside };
};
const secs = (room: Room, s: number) => { for (let i = 0; i < Math.round((s * 1000) / TICK_MS); i++) room.step(); };
const lastZone = (msgs: ServerMsg[]) => msgs.filter((m): m is Extract<ServerMsg, { t: 'snap' }> => m.t === 'snap' && !!m.zone).at(-1)?.zone;
const OUTSIDE: [number, number] = [-120, 200]; // ~161 m from the initial centre [0, 100], radius 145

type Navigation = {
  areaNav: () => NavGraph;
  searchNav: SearchNavGraph;
  searchPatrolGraph: boolean;
  warden: WardenAI;
  refreshLockedDoors: () => void;
  campusMoveOk: (world: Room['world'], a: Vec3, b: Vec3) => boolean;
};
const point = (nav: NavGraph, id: number): Vec3 => { const n = nav.nodes[id]; return [n.x, n.y, n.z]; };

it('campus segment broad phases retain thin walls and changing capsule heights', () => {
  const room = new Room('A1B', 42), state = room as unknown as { segmentClear: (w: CollisionWorld[], a: Vec3, b: Vec3) => boolean };
  const wall = new CollisionWorld([{ minX: .95, maxX: 1.05, minY: 0, maxY: 2.5, minZ: -.1, maxZ: .1 }]);
  const ceiling = new CollisionWorld([{ minX: .95, maxX: 1.05, minY: 2.5, maxY: 3, minZ: -.1, maxZ: .1 }]);
  const step = new CollisionWorld([{ minX: .95, maxX: 1.05, minY: 0, maxY: .2, minZ: -.1, maxZ: .1 }]);
  expect(state.segmentClear([wall], [0, 0, 0], [2, 0, 0])).toBe(false);
  expect(state.segmentClear([wall], [2, 0, 0], [0, 0, 0])).toBe(false);
  expect(state.segmentClear([ceiling], [0, 0, 0], [2, 0, 0])).toBe(true);
  expect(state.segmentClear([ceiling], [0, 2, 0], [2, 0, 0])).toBe(false);
  expect(state.segmentClear([new CollisionWorld(), step], [0, 0, 0], [2, 0, 0])).toBe(true);
});

describe('royale AI uses the real whole-campus navigation', () => {
  it('connects A building to the reachable library node near (60, 140)', () => {
    const { room } = setup(2), nav = (room as unknown as Navigation).areaNav();
    expect(nav.nodes).toHaveLength(graph.nodes.length);
    const from = nav.nearest(-36.45, 0, 72.55), to = nav.nearest(60, 0, 140);
    expect(Math.hypot(nav.nodes[to].x - 60, nav.nodes[to].z - 140)).toBeLessThan(3);
    const path = nav.astar(from, to);
    expect(path).not.toBeNull();
    expect(path!.some(i => nav.nodes[i].tag === 'out')).toBe(true);
  });

  it('walks a remembered investigation out of A building and gets at least 20 m closer in 30 s', () => {
    const { room, players } = setup(2), state = room as unknown as Navigation, nav = state.searchNav;
    // No live player senses provide the destination: this is explicit last-known evidence, not long-range sight.
    for (const player of players) player.safeUntil = 100_000;
    const goal = point(graph, graph.nearest(60, 0, 140));
    state.searchPatrolGraph = false;
    nav.refresh();
    state.warden.reset(nav.nearest(-36.45, 0, 72.55));
    const start: Vec3 = [...state.warden.p], distance = (p: Vec3) => Math.hypot(p[0] - goal[0], p[2] - goal[2]);
    (state.warden as unknown as { investigate: (p: Vec3) => void }).investigate(goal);
    expect(state.warden.state).toBe('investigate');
    let leftLevel = false;
    for (let tick = 0; tick < 30_000 / TICK_MS; tick++) {
      const before: Vec3 = [...state.warden.p];
      room.step();
      expect(state.campusMoveOk(room.world, before, state.warden.p), `illegal AI segment ${before} → ${state.warden.p}`).toBe(true);
      leftLevel ||= !inBounds(room.level, ...state.warden.p);
    }
    expect(leftLevel).toBe(true);
    expect(distance(start) - distance(state.warden.p)).toBeGreaterThanOrEqual(20);
    expect(room.searchRecoveries).toBe(0);
    if (process.env.ESC_NAV_EVIDENCE) console.log('A1 investigation', { start, end: state.warden.p, goal, closer: distance(start) - distance(state.warden.p) });
  });

  it('keeps an outside-L1 library door dynamic for patrol, investigation and physical movement', () => {
    const { room, players } = setup(2), state = room as unknown as Navigation, nav = state.searchNav;
    const a = nav.nearest(52.45, .02, 135.55), b = nav.nearest(50.65, 0, 136.05), door = 174;
    expect(Math.hypot(nav.nodes[a].x - 52.45, nav.nodes[a].z - 135.55)).toBeLessThan(.1);
    expect(room.doorLocked[door]).toBe(false);
    expect(nav.adj[a]).not.toContain(b); // patrol does not silently pass a closed door
    state.searchPatrolGraph = false;
    nav.refresh();
    expect(nav.adj[a]).toContain(b); // an investigation may plan to open it
    expect(state.campusMoveOk(room.world, point(nav, a), point(nav, b))).toBe(false);
    room.doorLocked[door] = true;
    state.refreshLockedDoors();
    expect(nav.adj[a]).not.toContain(b); // a locked door cannot be planned through
    room.giveKey(players[0].conn.id, door);
    players[0].p = point(nav, a);
    expect(room.toggleDoor(players[0], door)).toBe(true);
    expect(room.doorOpen[door]).toBe(true);
    state.searchPatrolGraph = true;
    nav.refresh();
    expect(nav.adj[a]).toContain(b);
    expect(state.campusMoveOk(room.world, point(nav, a), point(nav, b))).toBe(true);
    players[0].p = [53.05, .02, 135.55]; // step clear of the door capsule before closing it
    expect(room.toggleDoor(players[0], door)).toBe(true);
    expect(nav.adj[a]).not.toContain(b);
    expect(state.campusMoveOk(room.world, point(nav, a), point(nav, b))).toBe(false);
  });

  for (const [index, def] of LEVELS.entries()) it(`campaign ${index + 1} keeps its own bounded navigation`, () => {
    const room = new Room('A1C', 42, graph, index), nav = (room as unknown as Navigation).areaNav();
    expect(nav.nodes.length).toBeGreaterThan(20);
    expect(nav.nodes.length).toBeLessThan(graph.nodes.length);
    expect(nav.nodes.every(n => inBounds(room.level, n.x, n.y, n.z)), def.name).toBe(true);
  });
});

describe('royaleZoneTiming', () => {
  it('uses the shipped constants by default and in production', () => {
    expect(royaleZoneTiming({}, true)).toEqual({ graceS: ZONE_GRACE_S, phaseS: ZONE_PHASE_S });
    expect(royaleZoneTiming({ ESCAPE_ZONE_GRACE_S: '5', ESCAPE_ZONE_PHASE_S: '4' }, false)).toEqual({ graceS: ZONE_GRACE_S, phaseS: ZONE_PHASE_S });
  });
  it('lets a debug build shorten the timings; junk values are ignored', () => {
    expect(royaleZoneTiming({ ESCAPE_ZONE_GRACE_S: '5', ESCAPE_ZONE_PHASE_S: '4' }, true)).toEqual({ graceS: 5, phaseS: 4 });
    expect(royaleZoneTiming({ ESCAPE_ZONE_GRACE_S: 'abc', ESCAPE_ZONE_PHASE_S: '0' }, true)).toEqual({ graceS: ZONE_GRACE_S, phaseS: ZONE_PHASE_S });
  });
});

describe('royale zone: server-authoritative phases', () => {
  // Keep each real-campus room under its own test deadline rather than sharing one across all 12 seeds.
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])('spawns every player inside the first circle, so nobody starts out of the zone (seed %i)', (seed) => {
    // 8 players on the real campus nav: without the filter in royaleDistribute some nav nodes lie outside the r145 circle (seed 2 put a player at -102,-27.7), so a player could start out of the zone
    const room = new Room('A2S', seed, graph, 0, 'standard', { mode: 'royale' });
    for (let id = 1; id <= 8; id++) room.add({ id, name: `P${id}`, send: () => {}, sendRaw: () => {} }, 0);
    room.started = false;
    const players = [...room.players.values()];
    const ready = roomIntroReady(players.map((p) => p.conn));
    room.handle(players[0].conn, { t: 'start' }, 0);
    ready(room);
    const zone0 = (room as unknown as Internals).royaleZones[0];
    for (const p of players) expect(inZone(p.p[0], p.p[2], zone0), `seed ${seed}, player ${p.conn.id} at ${p.p[0]},${p.p[2]}`).toBe(true);
  });

  it('holds the first circle for the whole grace period, then switches to the first shrink', () => {
    const { room, it, messages, inside } = setup(2);
    for (const i of [0, 1]) inside(i);
    secs(room, ZONE_GRACE_S - 1);
    expect(it.royaleZonePhase).toBe(0);
    expect(lastZone(messages[0])).toMatchObject({ phase: 0, radius: it.royaleZones[0].radius, alive: 2 });
    expect(lastZone(messages[0])!.remainingMs).toBeLessThanOrEqual(1100);
    secs(room, 1.2);
    expect(it.royaleZonePhase).toBe(1);
    const z = lastZone(messages[0])!;
    expect(z).toMatchObject({ phase: 1, radius: it.royaleZones[1].radius, center: [...it.royaleZones[1].center] });
    expect(z.remainingMs).toBeGreaterThan((ZONE_PHASE_S - 2) * 1000);
  });

  it('advances one phase per ZONE_PHASE_S and stops at the final circle', () => {
    const { room, it, players } = setup(2);
    const keepSafe = () => { for (let i = 0; i < 2; i++) { const z = it.royaleZones[it.royaleZonePhase]; players[i].p = [z.center[0], 0, z.center[1]]; } };
    secs(room, ZONE_GRACE_S + 0.5);
    const seen = [it.royaleZonePhase];
    for (let k = 0; k < 5; k++) {
      for (let s = 0; s < ZONE_PHASE_S; s++) { keepSafe(); secs(room, 1); }
      seen.push(it.royaleZonePhase);
    }
    expect(seen).toEqual([1, 2, 3, 4, 4, 4]); // 4 shrinks, then the last circle stays
    expect(it.royaleZones).toHaveLength(5);
    expect(it.royaleAlive.size).toBe(2);
  });

  it('a player inside the circle keeps outTime at 0', () => {
    const { room, it, players, inside } = setup(3);
    for (const i of [0, 1, 2]) inside(i);
    secs(room, 3);
    for (const p of players) expect(it.royaleOutTime.get(p.conn.id)).toBe(0);
  });

  it('eliminates a player 8 s after leaving the circle, announces rank/alive, keeps the others alive', () => {
    const { room, it, messages, players, park, inside } = setup(3);
    park(0, ...OUTSIDE); inside(1); inside(2);
    secs(room, ZONE_OUT_ELIM_S - 0.5);
    expect(it.royaleAlive.has(players[0].conn.id)).toBe(true);
    expect(it.royaleOutTime.get(players[0].conn.id)).toBeGreaterThan(ZONE_OUT_ELIM_S - 0.7);
    expect(players[0].st).toBe(ST_OK);
    secs(room, 0.7);
    expect(it.royaleAlive.has(players[0].conn.id)).toBe(false);
    expect(players[0].st).toBe(ST_SPECTATE);
    for (const m of messages) expect(m.filter((x) => x.t === 'royale-eliminated')).toEqual([{ t: 'royale-eliminated', id: 1, rank: 3, alive: 2 }]);
    for (const i of [1, 2]) { expect(it.royaleAlive.has(players[i].conn.id)).toBe(true); expect(players[i].st).toBe(ST_OK); }
    expect(lastZone(messages[1])!.alive).toBe(2);
    expect(it.completed).toBe(false);
  });

  it('re-entering the circle clears the timer; leaving again starts from zero', () => {
    const { room, it, players, park, inside } = setup(3);
    inside(1); inside(2);
    park(0, ...OUTSIDE); secs(room, 6);
    expect(it.royaleOutTime.get(1)).toBeGreaterThan(5.5);
    inside(0); secs(room, 0.2);
    expect(it.royaleOutTime.get(1)).toBe(0);
    park(0, ...OUTSIDE); secs(room, 6);
    expect(it.royaleAlive.has(1)).toBe(true); // 6 + 6 s total outside, but never 8 s in a row
    expect(players[0].st).toBe(ST_OK);
    secs(room, 2.2);
    expect(it.royaleAlive.has(1)).toBe(false);
  });

  it('when the circle shrinks past a player, they are safe until the switch and out 8 s after it', () => {
    const { room, it, players, park, inside } = setup(3);
    const [z0, z1] = it.royaleZones;
    // a spot inside the first circle and outside the first shrink, found along the line from circle 1's centre towards circle 0's
    const dx = z0.center[0] - z1.center[0], dz = z0.center[1] - z1.center[1], len = Math.hypot(dx, dz) || 1;
    const d = z1.radius + 10, spot: [number, number] = [z1.center[0] + (dx / len) * d, z1.center[1] + (dz / len) * d];
    expect(inZone(spot[0], spot[1], z0)).toBe(true);
    expect(inZone(spot[0], spot[1], z1)).toBe(false);
    park(0, ...spot);
    for (const i of [1, 2]) park(i, z1.center[0], z1.center[1]); // inside every circle
    secs(room, ZONE_GRACE_S - 1);
    expect(it.royaleOutTime.get(1)).toBe(0);
    secs(room, 2);
    expect(it.royaleZonePhase).toBe(1);
    secs(room, ZONE_OUT_ELIM_S - 1.5);
    expect(it.royaleAlive.has(1)).toBe(true);
    expect(it.royaleOutTime.get(1)).toBeGreaterThan(5);
    secs(room, 1.7);
    expect(it.royaleAlive.has(1)).toBe(false);
    expect(it.royaleAlive.size).toBe(2);
    inside(1); // (silences unused-helper lint; positions of 2 and 3 already inside)
    expect(players[1].st).toBe(ST_OK);
  });

  it('the last survivor wins: ranking is broadcast and the zone stops stepping', () => {
    const { room, it, messages, park, inside } = setup(2);
    park(0, ...OUTSIDE); inside(1);
    secs(room, ZONE_OUT_ELIM_S + 0.5);
    expect(it.completed).toBe(true);
    for (const m of messages) {
      expect(m.filter((x) => x.t === 'royale-settle')).toEqual([{ t: 'royale-settle', ranking: [{ id: 1, rank: 2 }, { id: 2, rank: 1 }] }]);
    }
    park(1, ...OUTSIDE); // after the match nothing more happens
    secs(room, ZONE_OUT_ELIM_S + 1);
    expect(it.royaleAlive.has(2)).toBe(true);
  });

  it('a player who disconnects for good leaves the alive list (HUD count + win condition)', () => {
    const { room, it, messages, players, inside } = setup(3);
    for (const i of [0, 1, 2]) inside(i);
    room.remove(players[2].conn, 1000);
    expect(it.royaleAlive.has(3)).toBe(false);
    expect(it.royaleOutTime.has(3)).toBe(false);
    expect(messages[0].filter((x) => x.t === 'royale-eliminated')).toEqual([{ t: 'royale-eliminated', id: 3, rank: 3, alive: 2 }]);
    room.remove(players[1].conn, 1100);
    expect(it.completed).toBe(true);
    expect(messages[0].filter((x) => x.t === 'royale-settle')).toHaveLength(1);
    expect(it.royaleAlive.has(1)).toBe(true);
  });
});

describe('royale debug tp: the play area is the whole campus, not the stand-in level 1 region', () => {
  const xz = (p: { p: ArrayLike<number> }): [number, number] => [p.p[0], p.p[2]];

  it('puts a player at the circle centre and at the far campus corners (all well outside level 1\'s 50 × 34 m region)', () => {
    const { room, players, messages } = setup(2);
    for (const to of [[0, 100], [-123, -32], [123, 201], [-123, 201], [123, -32]] as [number, number][]) {
      messages[0].length = 0;
      room.handle(players[0].conn, { t: 'debug', op: 'tp', x: to[0], z: to[1] }, 10);
      expect(xz(players[0])).toEqual(to);
      expect(messages[0].at(-1)).toMatchObject({ t: 'correct', forced: true, p: players[0].p });
    }
  });

  it('a tp across the campus decides the zone check: out of the circle counts down and eliminates, back inside clears it', () => {
    const { room, it, players, inside } = setup(2);
    inside(1);
    const far = [[-123, -32], [123, -32], [-123, 201], [123, 201]].sort((a, b) => Math.hypot(b[0], b[1] - 100) - Math.hypot(a[0], a[1] - 100))[0];
    room.handle(players[0].conn, { t: 'debug', op: 'tp', x: far[0], z: far[1] }, 10);
    expect(inZone(players[0].p[0], players[0].p[2], it.royaleZones[0])).toBe(false);
    secs(room, 3);
    expect(it.royaleOutTime.get(1)).toBeGreaterThan(2.5);
    room.handle(players[0].conn, { t: 'debug', op: 'tp', x: it.royaleZones[0].center[0], z: it.royaleZones[0].center[1] }, 10);
    secs(room, 0.2);
    expect(it.royaleOutTime.get(1)).toBe(0);
    room.handle(players[0].conn, { t: 'debug', op: 'tp', x: far[0], z: far[1] }, 10);
    secs(room, ZONE_OUT_ELIM_S + 0.5);
    expect(it.royaleAlive.has(1)).toBe(false);
    expect(players[0].st).toBe(ST_SPECTATE);
  });

  it('still refuses a position beyond the campus: the player stays put and is snapped back', () => {
    const { room, players, messages } = setup(2);
    const p0 = [...players[0].p];
    for (const [x, z] of [[200, 100], [-200, 100], [0, 300], [0, -80]]) {
      messages[0].length = 0;
      room.handle(players[0].conn, { t: 'debug', op: 'tp', x, z }, 10);
      expect(players[0].p).toEqual(p0);
      expect(messages[0].at(-1)).toMatchObject({ t: 'correct', p: p0, forced: true });
    }
  });

  it('a campaign room keeps its level region: the same far tp is refused there', () => {
    const room = new Room('A2K', 42, graph, 0, 'standard', {});
    room.add({ id: 1, name: 'P1', send: () => {}, sendRaw: () => {} }, 0);
    const pl = [...room.players.values()][0], p0 = [...pl.p];
    room.handle(pl.conn, { t: 'debug', op: 'tp', x: -123, z: -32 }, 10);
    expect(pl.p).toEqual(p0);
  });
});

describe('royale input: walking is judged against the whole campus, not the stand-in level 1 region', () => {
  const l1 = generateLevel(0, 42);
  type Node = (typeof graph.nodes)[number];
  /** Short flat nav edges outside level 1's x -65..-15 box (one per direction pair), each with the distance from its midpoint to the nearest door. */
  const edges = (room: Room) => {
    const doors = (room as unknown as Internals).doors, out: { a: Node; b: Node; door: number }[] = [];
    for (let i = 0; i < graph.nodes.length; i++) for (const j of graph.adj[i]) {
      const a = graph.nodes[i], b = graph.nodes[j], d = Math.hypot(a.x - b.x, a.z - b.z);
      if (j < i || Math.abs(a.y - b.y) > 0.05 || d < 0.6 || d > 1.4 || inBounds(l1, a.x, a.y, a.z) || inBounds(l1, b.x, b.y, b.z)) continue;
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      out.push({ a, b, door: Math.min(...doors.map((dd) => Math.hypot(dd.x - mx, dd.z - mz))) });
    }
    return out;
  };
  /** Stand `pl` on `a` and send an honest input one step on to `b`; true when the server took it (no correction). */
  let seq = 0;
  const step = (room: Room, pl: ReturnType<typeof setup>['players'][number], a: Node, b: Node) => {
    pl.p = [a.x, a.y, a.z];
    pl.budget = 0.5; pl.budgetAt = 1000; pl.lastInput = 1000;
    const c0 = pl.c;
    room.handle(pl.conn, { t: 'input', seq: ++seq, c: pl.c, p: [b.x, b.y, b.z], yaw: 0, pitch: 0, f: 0 }, 2000);
    return pl.c === c0 && pl.p[0] === b.x && pl.p[1] === b.y && pl.p[2] === b.z;
  };

  it('the play area holds every campus nav node, library basement (feet y -3.6) and top storey (14.4) included', () => {
    const outside = graph.nodes.filter((n) => !inRoyaleArea(n.x, n.y, n.z));
    expect(outside).toEqual([]);
  });

  it('a royale player can take every short flat step on the campus nav that no door is in the way of, on all storeys', () => {
    const { room, players } = setup(2);
    const free = edges(room).filter((e) => e.door > 1.5);
    expect(free.length).toBeGreaterThan(60);
    expect(free.some((e) => e.a.y < -3)).toBe(true); // library basement
    expect(free.some((e) => e.a.y > 10)).toBe(true); // top storeys
    const refused = free.filter((e) => !step(room, players[0], e.a, e.b)).map((e) => [e.a, e.b]);
    expect(refused).toEqual([]);
  });

  it('a closed door still stops the step, so the test above can tell a refusal from an accept', () => {
    const { room, players } = setup(2);
    const through = edges(room).sort((p, q) => p.door - q.door)[0];
    expect(through.door).toBeLessThan(0.5);
    expect(step(room, players[0], through.a, through.b)).toBe(false);
  });

  it('a campaign room still pushes the same free step back: level 1 is the whole map there', () => {
    const { room } = setup(2);
    const free = edges(room).find((e) => e.door > 1.5 && e.a.x > 40)!;
    const camp = new Room('A2K', 42, graph, 0, 'standard', {});
    const got: ServerMsg[] = [];
    camp.add({ id: 1, name: 'P1', send: (m) => got.push(structuredClone(m)), sendRaw: () => {} }, 0);
    const pl = [...camp.players.values()][0];
    expect(step(camp, pl as never, free.a, free.b)).toBe(false);
    expect(got.filter((m) => m.t === 'correct')).toHaveLength(1);
    expect(pl.p).toEqual([free.a.x, free.a.y, free.a.z]);
  });
});
