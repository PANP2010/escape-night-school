import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { campusNavCached } from '../../client/src/campus/world/navcache.ts';
import { spawnRoute } from '../../client/src/campus/world/navgraph.ts';
import { seenBy } from '../../server/ai/monitor.ts';
import { SIGHTING, selectSighting, sightingVisible, type SightingPlan } from '../../server/ai/sighting.ts';
import { NavGraph } from '../../shared/campus/nav.ts';
import type { CollisionWorld } from '../../shared/campus/collision.ts';
import type { WardenAI } from '../../server/ai/warden.ts';
import { RoomManager, type Conn } from '../../server/room.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { ST_OK, ST_SPECTATE, type ServerMsg, type Vec3 } from '../../shared/protocol.ts';
import { mulberry32 } from '../../shared/rng.ts';
import { roomIntroReady } from './room-intro-fixture.ts';

interface RoomDirector {
  sighting?: { plan: SightingPlan; phase: 'walk' | 'hold' | 'release'; startedAt: number; moved: boolean };
  sightingFinished: boolean;
  tension: { status(now: number): { lastScare: number } };
  scareReady(now?: number): boolean;
  takeScare(now?: number): boolean;
  loadLevel(index: number): void;
  stepSighting(): boolean;
  sightingExit(viewers: { id: number; p: Vec3; yaw: number; f: number }[]): Vec3[];
}

/** Hold ordinary AI still at a valid hidden source so these regressions isolate Room's control handoff. */
function controlledOpening() {
  const graph = campusNavCached('.cache/campus-nav.json').graph;
  const room = new RoomManager(mulberry32(1), () => graph).create(true);
  const conn: Conn = { id: 1, name: 'witness', send: () => {}, sendRaw: () => {} };
  const ready = roomIntroReady([conn]);
  room.add(conn, 0); room.handle(conn, { t: 'start' }, 0);
  ready(room);
  const p = room.players.get(1)!, director = room as unknown as RoomDirector;
  const warden = (room as unknown as { warden: WardenAI }).warden;
  room.tick = Math.ceil(31_000 / TICK_MS);
  warden.p = [-33.95, 0, 92.85];
  const input = (c = p.c) => room.handle(conn,
    { t: 'input', seq: room.tick, c, p: [...p.p], yaw: Math.PI / 2, pitch: 0, f: 0 }, room.tick * TICK_MS);
  const step = () => { room.tick++; return director.stepSighting(); };
  return { room, conn, p, director, warden, input, step };
}

/** Real Room, campus colliders, closed doors, level navigation and ordinary client inputs. No debug safe/teleport. */
function opening(seed: number, playerCount: number) {
  const graph = campusNavCached('.cache/campus-nav.json').graph;
  const room = new RoomManager(mulberry32(seed), () => graph).create(true);
  const caught: { player: number; at: number; by: string }[] = [];
  const receive = (id: number, m: ServerMsg) => {
    if (m.t === 'caught') caught.push({ player: id, at: room.tick * TICK_MS / 1000, by: m.by });
  };
  const ids = Array.from({ length: playerCount }, (_, i) => i + 1);
  const conns: Conn[] = ids.map(id => ({
    id, name: `opening-${id}`, send: m => receive(id, m), sendRaw: raw => receive(id, JSON.parse(raw) as ServerMsg),
  }));
  for (const conn of conns) room.add(conn, 0);
  const ready = roomIntroReady(conns);
  room.handle(conns[0], { t: 'start' }, 0);
  ready(room);
  // Game.spawnCampus uses this direction after the first authoritative spawn, whereas Room.add starts yaw at zero.
  const [a, b] = spawnRoute(), yaw = Math.atan2(a[0] - b[0], a[1] - b[1]);
  const warden = (room as unknown as { warden: WardenAI }).warden;
  const director = room as unknown as RoomDirector;
  const los = (room as unknown as { sightingLos: (from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) => boolean }).sightingLos;
  const observers = ids.map(id => ({ player: id, firstSeenS: null as number | null, visibleS: 0, longestWindowS: 0, windowS: 0, maxProjectedHeightPx: 0,
    scriptFirstSeenS: null as number | null, scriptVisibleS: 0, scriptWindowS: 0, longestScriptWindowS: 0 }));
  const scriptStarts: { atS: number; candidate: string; source: Vec3; destination: Vec3; firstSnap: Vec3; roundedRelocation: number; sourceVisibleTo: number[]; destinationVisibleTo: number[] }[] = [];
  const scriptPhases: { atS: number; phase: string }[] = [];
  const controlledIntervals: { fromS: number; toS: number }[] = [];
  let controlledFrom: number | undefined, priorPhase: string | undefined;
  let minimumScriptDistance = Infinity, maximumControlledStep = 0;
  let firstTeamSeenS: number | null = null, teamVisibleS = 0, teamWindowS = 0, longestTeamWindowS = 0;
  let minimumWardenDistanceFirst20S = Infinity;
  for (let i = 0; i < 60_000 / TICK_MS; i++) {
    for (const conn of conns) {
      const p = room.players.get(conn.id)!;
      room.handle(conn, { t: 'input', seq: i, c: p.c, p: [...p.p], yaw, pitch: 0, f: 0 }, i * TICK_MS);
    }
    const previousSource = [...warden.p] as Vec3, wasControlled = !!director.sighting;
    room.step();
    const phase = director.sighting?.phase, controlled = !!director.sighting || wasControlled;
    if (director.sighting && !wasControlled) {
      const destination = director.sighting.plan.path[0];
      const viewers = [...room.players.values()].map(p => ({ id: p.conn.id, p: p.p, yaw: p.yaw, pitch: p.pitch, f: p.f }));
      scriptStarts.push({ atS: room.tick * TICK_MS / 1000, candidate: director.sighting.plan.id, source: previousSource, destination,
        firstSnap: [...warden.p], roundedRelocation: Math.hypot(Math.round(previousSource[0] * 100) / 100 - Math.round(warden.p[0] * 100) / 100,
          Math.round(previousSource[2] * 100) / 100 - Math.round(warden.p[2] * 100) / 100),
        sourceVisibleTo: viewers.filter(v => sightingVisible(v, previousSource, los)).map(v => v.id),
        destinationVisibleTo: viewers.filter(v => sightingVisible(v, destination, los)).map(v => v.id) });
      controlledFrom = room.tick * TICK_MS / 1000;
    }
    if (phase !== priorPhase) { scriptPhases.push({ atS: room.tick * TICK_MS / 1000, phase: phase ?? 'ordinary' }); priorPhase = phase; }
    if (wasControlled) maximumControlledStep = Math.max(maximumControlledStep, Math.hypot(warden.p[0] - previousSource[0], warden.p[2] - previousSource[2]));
    if (!director.sighting && wasControlled && controlledFrom !== undefined) {
      controlledIntervals.push({ fromS: controlledFrom, toS: room.tick * TICK_MS / 1000 }); controlledFrom = undefined;
    }
    const scripted = phase === 'walk' || phase === 'hold';
    let teamSeen = false;
    for (const row of observers) {
      const p = room.players.get(row.player)!;
      // A conservative 1.75 m figure in the actual 75° vertical camera at 720p; use full range for the estimate.
      const distance = Math.hypot(warden.p[0] - p.p[0], warden.p[1] - p.p[1], warden.p[2] - p.p[2]);
      const projectedHeightPx = 1.75 * 720 / (2 * Math.tan(75 * Math.PI / 360) * Math.max(distance, 0.01));
      const sees = p.st === ST_OK && projectedHeightPx > 40 && seenBy({ id: row.player, p: p.p, yaw: p.yaw, pitch: p.pitch, f: p.f }, warden.p, los);
      if (sees) {
        row.maxProjectedHeightPx = Math.max(row.maxProjectedHeightPx, projectedHeightPx);
        row.firstSeenS ??= room.tick * TICK_MS / 1000;
        row.visibleS += TICK_MS / 1000;
        row.windowS += TICK_MS / 1000;
        row.longestWindowS = Math.max(row.longestWindowS, row.windowS);
        teamSeen = true;
      } else row.windowS = 0;
      if (sees && scripted) {
        row.scriptFirstSeenS ??= room.tick * TICK_MS / 1000;
        row.scriptVisibleS += TICK_MS / 1000;
        row.scriptWindowS += TICK_MS / 1000;
        row.longestScriptWindowS = Math.max(row.longestScriptWindowS, row.scriptWindowS);
      } else row.scriptWindowS = 0;
      if (controlled) minimumScriptDistance = Math.min(minimumScriptDistance, Math.hypot(warden.p[0] - p.p[0], warden.p[2] - p.p[2]));
      if (room.tick * TICK_MS <= 20_000) {
        minimumWardenDistanceFirst20S = Math.min(minimumWardenDistanceFirst20S, Math.hypot(warden.p[0] - p.p[0], warden.p[2] - p.p[2]));
      }
    }
    if (teamSeen) {
      firstTeamSeenS ??= room.tick * TICK_MS / 1000;
      teamVisibleS += TICK_MS / 1000;
      teamWindowS += TICK_MS / 1000;
      longestTeamWindowS = Math.max(longestTeamWindowS, teamWindowS);
    } else teamWindowS = 0;
  }
  if (controlledFrom !== undefined) controlledIntervals.push({ fromS: controlledFrom, toS: 60 });
  return { inputSeed: seed, playerCount, roomSeed: room.seed, yaw, firstTeamSeenS, teamVisibleS, longestTeamWindowS, minimumWardenDistanceFirst20S,
    scriptStarts, scriptPhases, controlledIntervals, minimumScriptDistance, maximumControlledStep, observers, caught };
}

describe('safe scripted sighting in the current L1 campus', () => {
  it('requires an explicit current-epoch camera after corrections, legacy inputs and stale look-only inputs', () => {
    const { room, conn, p, director, warden, input, step } = controlledOpening();
    const source = [...warden.p];
    input();
    expect(p.cameraKnown).toBe(true);
    const oldEpoch = p.c;
    room.handle(conn, { t: 'debug', op: 'tp', x: p.p[0], z: p.p[2] }, room.tick * TICK_MS);
    expect(p.c).toBeGreaterThan(oldEpoch);
    expect(p.cameraKnown).toBe(false);
    input();
    expect(p.cameraKnown).toBe(true);
    input(oldEpoch); // look-only compatibility must not retain permission to relocate the figure
    expect(p.cameraKnown).toBe(false);
    expect(step()).toBe(false);
    expect(warden.p).toEqual(source);
    room.handle(conn, { t: 'input', seq: room.tick, p: [...p.p], yaw: Math.PI / 2, pitch: 0, f: 0 }, room.tick * TICK_MS);
    expect(p.cameraKnown).toBe(false);
    room.tick += 20;
    expect(step()).toBe(false);
    input();
    room.tick += 20;
    expect(step()).toBe(true);
    expect(director.sighting).toBeDefined();
  });

  it('keeps an active figure harmless while a camera epoch is unknown or a free spectator is present', () => {
    const { room, conn, p, director, warden, input, step } = controlledOpening();
    input(); expect(step()).toBe(true);
    const entry = [...warden.p];
    room.handle(conn, { t: 'debug', op: 'tp', x: p.p[0], z: p.p[2] }, room.tick * TICK_MS);
    for (let i = 0; i < 30; i++) { expect(step()).toBe(true); expect(warden.p).toEqual(entry); }
    input();
    const observer: Conn = { id: 2, name: 'free-camera', send: () => {}, sendRaw: () => {} };
    room.add(observer, room.tick * TICK_MS);
    expect(room.players.get(2)?.st).toBe(ST_SPECTATE);
    for (let i = 0; i < 30; i++) { expect(step()).toBe(true); expect(warden.p).toEqual(entry); }
    expect(warden.caught).toEqual([]);
    expect(director.sighting?.moved).toBe(false);
    room.remove(observer, room.tick * TICK_MS);
    expect(step()).toBe(true);
    expect(warden.p).not.toEqual(entry);
    expect(p.st).toBe(ST_OK);
  });

  it('walks out without attacks and releases only after 20 s at an unseen navigation node at least 15 m away', () => {
    const { room, p, director, warden, input, step } = controlledOpening();
    input(); expect(step()).toBe(true);
    const geometry = room as unknown as { areaNav(): NavGraph; sightingLos: Parameters<typeof sightingVisible>[2] };
    let releaseFrom: number | undefined, moved = 0;
    for (let i = 0; i < 1600 && director.sighting; i++) {
      const previous = [...warden.p];
      step();
      moved += Math.hypot(warden.p[0] - previous[0], warden.p[2] - previous[2]);
      expect(Math.hypot(warden.p[0] - previous[0], warden.p[2] - previous[2])).toBeLessThanOrEqual(.071);
      expect(warden.caught).toEqual([]);
      expect(p.st).toBe(ST_OK);
      if (director.sighting?.phase === 'release') releaseFrom ??= room.tick * TICK_MS / 1000;
    }
    expect(director.sighting, 'a clear campus exit must eventually give control back').toBeUndefined();
    expect(releaseFrom).toBeDefined();
    expect(room.tick * TICK_MS / 1000 - releaseFrom!).toBeGreaterThanOrEqual(20);
    expect(moved).toBeGreaterThan(10);
    expect(Math.hypot(warden.p[0] - p.p[0], warden.p[2] - p.p[2])).toBeGreaterThanOrEqual(15);
    expect(sightingVisible({ id: 1, p: p.p, yaw: p.yaw, pitch: p.pitch, f: p.f }, warden.p, geometry.sightingLos)).toBe(false);
    expect(geometry.areaNav().nodes.some(n => Math.hypot(n.x - warden.p[0], n.y - warden.p[1], n.z - warden.p[2]) < .0001)).toBe(true);
  });

  it('plans a longer safe departure when a shorter navigation edge would cross a player', () => {
    const { room, director, warden } = controlledOpening();
    const graph = new NavGraph();
    const [a, b, c, d] = [[-7, 0, 0], [16, 0, 0], [-7, 0, 13], [-18, 0, 13]].map(p => graph.addNode({ x: p[0], y: p[1], z: p[2] }));
    graph.link(a, b); graph.link(a, c); graph.link(c, d);
    // Isolate the route clearance from campus geometry: both branches are walkable and hidden.
    Object.assign(room, { areaNav: () => graph, campusMoveOk: () => true, sightingLos: () => false });
    warden.p = [-7, 0, 0];
    expect(director.sightingExit([{ id: 1, p: [0, 0, 0], yaw: 0, f: 0 }])).toEqual([[-7, 0, 0], [-7, 0, 13], [-18, 0, 13]]);
  });

  it('one, three and four ordinary players each see a sustained figure in the first minute, with no spawn catch in the first 20 s', () => {
    const measurements = [1, 3, 4].flatMap(n => [1, 2, 3, 6, 11, 42].map(seed => opening(seed, n)));
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/safe-sighting-room.json', JSON.stringify({
      scenario: 'One/three/four players stationary at L1 spawns, every tick sends Game.spawnCampus yaw, light off, no debug commands; visibility requires server view cone, campus/door LOS, projected 720p height >40px.',
      durationS: 60, measurements,
    }, null, 2));
    for (const row of measurements) {
      const label = `seed ${row.inputSeed}, ${row.playerCount} players`;
      expect(row.caught.filter(c => c.at <= 20), `${label}: spawn catches`).toEqual([]);
      expect(row.scriptStarts, `${label}: scripted appearance was never staged`).toHaveLength(1);
      expect(row.scriptStarts[0].sourceVisibleTo, `${label}: disappeared in a teammate's view`).toEqual([]);
      expect(row.scriptStarts[0].destinationVisibleTo, `${label}: appeared in a teammate's view`).toEqual([]);
      expect(row.scriptStarts[0].firstSnap, `${label}: first relocation snapshot already moved away from the hidden entry`).toEqual(row.scriptStarts[0].destination);
      expect(row.scriptStarts[0].roundedRelocation, `${label}: rounded wire relocation must trigger the client's >3m collapse`).toBeGreaterThan(3);
      expect(row.minimumScriptDistance).toBeGreaterThanOrEqual(SIGHTING.minDistance);
      expect(row.maximumControlledStep, `${label}: teleport while ending the performance`).toBeLessThanOrEqual(0.101);
      for (const interval of row.controlledIntervals) expect(row.caught.filter(c => c.at >= interval.fromS && c.at <= interval.toS), `${label}: caught during the non-attacking appearance`).toEqual([]);
      expect(row.firstTeamSeenS, `${label}: never visible`).not.toBeNull();
      expect(row.firstTeamSeenS!).toBeLessThanOrEqual(60);
      for (const observer of row.observers) {
        expect(observer.firstSeenS, `${label}, player ${observer.player}: never visible`).not.toBeNull();
        expect(observer.firstSeenS!).toBeLessThanOrEqual(60);
        expect(observer.longestWindowS, `${label}, player ${observer.player}: visibility was only a one-tick flash`).toBeGreaterThanOrEqual(1);
        expect(observer.scriptFirstSeenS, `${label}, player ${observer.player}: only a natural encounter was visible`).not.toBeNull();
        expect(observer.longestScriptWindowS, `${label}, player ${observer.player}: scripted figure was visible for less than a second`).toBeGreaterThanOrEqual(1);
      }
    }
  }, 300_000);

  it('shares the 45 s cooldown across scare sources and level loads', () => {
    const graph = campusNavCached('.cache/campus-nav.json').graph;
    const room = new RoomManager(mulberry32(4), () => graph).create();
    const director = room as unknown as RoomDirector;
    expect(director.takeScare(10)).toBe(true);
    expect(director.takeScare(10 + SIGHTING.cooldown - 0.001)).toBe(false);
    expect(director.tension.status(10).lastScare).toBe(10);
    expect(director.takeScare(10 + SIGHTING.cooldown)).toBe(true);
    director.loadLevel(3); // L4 broadcast remains in charge, without resetting the shared scare budget.
    expect(director.scareReady(10 + 2 * SIGHTING.cooldown - 0.001)).toBe(false);
    expect(director.takeScare(10 + 2 * SIGHTING.cooldown)).toBe(true);
  });

  it('waits beyond 60 s when watched, then stages safely when the player looks away', () => {
    const graph = campusNavCached('.cache/campus-nav.json').graph;
    const room = new RoomManager(mulberry32(1), () => graph).create(true);
    const conn: Conn = { id: 1, name: 'late-witness', send: () => {}, sendRaw: () => {} };
    const watcher: Conn = { id: 2, name: 'source-watcher', send: () => {}, sendRaw: () => {} };
    const ready = roomIntroReady([conn, watcher]);
    room.add(conn, 0); room.add(watcher, 0); room.handle(conn, { t: 'start' }, 0);
    ready(room);
    const warden = (room as unknown as { warden: WardenAI }).warden, director = room as unknown as RoomDirector;
    const p = room.players.get(1)!;
    // An authored, capsule-connected north corridor point; a random initial node can be behind a closed classroom door.
    warden.p = [-33.95, 0, 92.85];
    const geometry = room as unknown as { areaNav(): NavGraph; campusMoveOk(w: CollisionWorld, a: Vec3, b: Vec3): boolean;
      sightingLos(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): boolean };
    const env = { graph: geometry.areaNav(), los: geometry.sightingLos, walkable: (a: Vec3, b: Vec3) => geometry.campusMoveOk(room.world, a, b) };
    const q = room.players.get(2)!;
    q.p = [-27.5, 0, 92.85];
    expect(env.walkable(q.p, q.p), 'source observer must stand in a clear corridor').toBe(true);
    expect(selectSighting(env, { level: 1, elapsed: 61, players: [{ id: 1, p: p.p, yaw: Math.PI / 2, f: 0 }, { id: 2, p: q.p, yaw: -Math.PI / 2, f: 0 }], warden,
      ready: true, scareReady: true, protected: false, controlBusy: false }), 'the late fixture must have a valid hidden connected candidate').toBeDefined();
    room.handle(conn, { t: 'input', seq: 0, c: p.c, p: [...p.p], yaw: Math.PI / 2, pitch: 0, f: 0 }, 0);
    room.handle(watcher, { t: 'input', seq: 0, c: q.c, p: [...q.p], yaw: Math.PI / 2, pitch: 0, f: 0 }, 0);
    expect(sightingVisible({ id: 2, p: q.p, yaw: q.yaw, f: 0 }, warden.p, env.los)).toBe(true);
    const source = [...warden.p];
    // Exercise just this room controller while the source remains watched; ordinary AI motion is irrelevant here.
    for (let tick = 1; tick <= 61_000 / TICK_MS; tick++) { room.tick = tick; expect(director.stepSighting()).toBe(false); }
    expect(director.sighting).toBeUndefined();
    expect(warden.p).toEqual(source);
    room.handle(watcher, { t: 'input', seq: 1, c: q.c, p: [...q.p], yaw: -Math.PI / 2, pitch: 0, f: 0 }, 61_000);
    for (let i = 0; i < 40 && !director.sighting; i++) { room.tick++; director.stepSighting(); }
    expect(director.sighting, 'a missed safe deadline must defer, not permanently cancel the opening').toBeDefined();
    expect(director.sighting!.startedAt).toBeGreaterThan(60);
  });

  it('stops its performance when a player approaches, and never converts the scripted figure into a close-range catch', () => {
    const graph = campusNavCached('.cache/campus-nav.json').graph;
    const room = new RoomManager(mulberry32(1), () => graph).create(true);
    const caught: ServerMsg[] = [];
    const conn: Conn = { id: 1, name: 'approaching-witness', send: m => { if (m.t === 'caught') caught.push(m); }, sendRaw: () => {} };
    const ready = roomIntroReady([conn]);
    room.add(conn, 0); room.handle(conn, { t: 'start' }, 0);
    ready(room);
    const p = room.players.get(1)!, director = room as unknown as RoomDirector;
    room.handle(conn, { t: 'input', seq: 0, c: p.c, p: [...p.p], yaw: Math.PI / 2, pitch: 0, f: 0 }, 0);
    for (let i = 0; i < 900 && !director.sighting; i++) room.step();
    expect(director.sighting).toBeDefined();
    const warden = (room as unknown as { warden: WardenAI }).warden, entry = [...warden.p];
    // Adversarial authoritative state: closer than the ordinary catch radius, without asking the selector to accept it.
    p.p = [warden.p[0] + 0.25, warden.p[1], warden.p[2]];
    room.emitNoise(p.p[0], p.p[2], 20, 'item', p.p[1], conn.id);
    for (let i = 0; i < 200; i++) {
      room.step();
      expect(warden.p).toEqual(entry);
      expect(warden.caught).toEqual([]);
      expect(p.st).toBe(ST_OK);
    }
    expect(director.sighting?.moved).toBe(false);
    expect(caught).toEqual([]);
  });
});
