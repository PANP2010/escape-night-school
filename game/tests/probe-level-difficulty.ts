/** Deterministic ideal-path samples against the real Room/campus collision/AI. No debug safe/tp/key.
 * Known map/objectives, instant turning and perfect monitor watching make this a feasibility sample,
 * not a first-time-human difficulty estimate. Run under the sprint heavy gate. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import data from '../shared/campus/colliders.json' with { type: 'json' };
import { CollisionWorld, moveCapsule, type AABB, type Body } from '../shared/campus/collision.ts';
import { lineOfSight, NAV_CAPSULE } from '../shared/campus/nav.ts';
import { campusNavCached } from '../client/src/campus/world/navcache.ts';
import { Room, levelAreaNav } from '../server/room.ts';
import { levelSolids } from '../shared/level.ts';
import { campusDoorSlab, doorTargetIn } from '../shared/doors.ts';
import { goalPoint, guideWaypoint, shutDoorOn, type Goal } from '../client/src/guide.ts';
import { objective } from '../client/src/objective.ts';
import { F_CROUCH, F_RUN, type ServerMsg, type Vec3 } from '../shared/protocol.ts';
import { CROUCH_EYE_H, EYE_H, SPEED, TICK_MS } from '../shared/constants.ts';
import { canRun } from '../shared/stamina.ts';


const nav = campusNavCached('.cache/campus-nav.json').graph, dt = TICK_MS / 1000;
type P = { x: number; y: number; z: number };
type Mob = { p: Vec3; state: string; yaw: number; blinking?: boolean };
type Strategy = 'quiet-guide' | 'adaptive-guide' | 'run-guide' | 'baseline-run';
const strategies = (process.env.PROBE_STRATEGIES ?? 'quiet-guide,adaptive-guide').split(',') as Strategy[];
if (strategies.some(s => !['quiet-guide', 'adaptive-guide', 'run-guide', 'baseline-run'].includes(s))) throw new Error('Unknown probe strategy');
const seeds = (process.env.PROBE_SEEDS ?? '1,4,7').split(',').map(Number);
const levels = (process.env.PROBE_LEVELS ?? '1,2').split(',').map(n => Number(n) - 1);
const limit = Number(process.env.PROBE_LIMIT ?? 240), stallLimit = 20;
const round = (n: number) => +n.toFixed(3), point = (p: readonly number[]) => p.map(round);
type Snapshot = { seconds: number; position: number[]; phase: number; bag: object; fusesIn: number; target: Goal | null; waypoint: (P & { dist: number }) | null; seen: number[]; warden: unknown; monitors: unknown[] };
type Sample = { strategy: Strategy; seed: number; level: number; seconds: number; cleared: boolean; discovered: number; firstWardenChase: number | null; firstMonitorChase: number | null; caught: number; caughtBy: string[]; rejectedMoves: number; rejectedY: number; reason: string; endpoint: Snapshot; checkpoints: Snapshot[]; phaseChanges: { seconds: number; phase: number; bag: object }[]; picks: { seconds: number; id: number; kind: string }[]; rejectedExamples: unknown[] };
const samples: Sample[] = [];
for (const strategy of strategies.filter(s => s !== 'baseline-run')) for (const seed of seeds) for (const level of levels) {
  const events: ServerMsg[] = [], room = new Room(`P${seed}`, seed, nav), conn = { id: 1, name: strategy, send: (m: ServerMsg) => events.push(m), sendRaw: (s: string) => events.push(JSON.parse(s)) };
  room.started = false; room.add(conn, 0); room.handle(conn, { t: 'start' }, 0);
  // L2 is an independent natural-spawn level sample, not a claimed L1→L2 full run.
  if (level) (room as any).loadLevel(level);
  const pl = room.players.get(1)!, startTick = room.tick, eventStart = events.length, g = levelAreaNav(nav, room.level);
  const world = new CollisionWorld([...(data.colliders as AABB[]), ...levelSolids(room.level.def)]);
  for (const h of data.holes) world.addHole(h.x0, h.x1, h.z0, h.z1);
  const slabs = room.doors.map(d => world.add(campusDoorSlab(d, false)));
  const b: Body = { x: pl.p[0], y: pl.p[1], z: pl.p[2], vy: 0, grounded: true };
  const seen = new Set<number>(), checkpoints: Snapshot[] = [], phaseChanges: Sample['phaseChanges'] = [], picks: Sample['picks'] = [], rejectedExamples: unknown[] = [];
  let discovered = 0, chasing = false, rejected = 0, rejectedY = 0, reason = 'time limit', firstWardenChase: number | null = null, firstMonitorChase: number | null = null;
  let target: Goal | null = null, wp: (P & { dist: number }) | null = null, previousPhase = -1, previousItems = -1, flags = 0;
  let stallAt = 0, progressPoint = [...pl.p] as Vec3;
  const elapsed = () => round((room.tick - startTick) * dt);
  const snapshot = (): Snapshot => {
    const w = (room as any).warden as Mob | undefined, ms = (room as any).monitors as Mob[];
    return { seconds: elapsed(), position: point(pl.p), phase: objective(room.level.def, room.bag, room.fusesIn).cur, bag: { ...room.bag }, fusesIn: room.fusesIn, target, waypoint: wp, seen: [...seen], warden: w && { position: point(w.p), state: w.state, yaw: round(w.yaw) }, monitors: ms.map(m => ({ position: point(m.p), state: m.state, blinking: m.blinking })) };
  };
  let endpoint = snapshot();
  for (let i = 0; i < limit / dt; i++) {
    if (room.levelIndex !== level) { reason = 'cleared'; break; }
    if (pl.st !== 0) { reason = 'caught'; break; }
    if ((room as any).advanceAt !== undefined) { room.step(); continue; }
    for (const d of room.doors) world.move(slabs[d.id], campusDoorSlab(d, room.doorOpen[d.id]));
    const los = (a: P, c: P) => lineOfSight(world, a, c), o = objective(room.level.def, room.bag, room.fusesIn);
    // Match production camera range/LOS and 4 Hz guide/seen update cadence.
    if (i % 5 === 0 || previousPhase !== o.cur || previousItems !== room.items.length) {
      const c = { x: b.x, y: b.y + (flags & F_CROUCH ? CROUCH_EYE_H : EYE_H), z: b.z };
      for (const it of room.items) if (!seen.has(it.id) && Math.hypot(it.p[0] - c.x, it.p[1] - c.y, it.p[2] - c.z) <= 8 && los(c, { x: it.p[0], y: it.p[1] + .1, z: it.p[2] })) seen.add(it.id);
      target = goalPoint(room.level.def, o, room.items, seen, b, g);
      wp = target ? guideWaypoint(g, b, target, los, (a, c) => shutDoorOn(room.doors, room.doorOpen, a, c)) : null;
      if (previousPhase !== o.cur) phaseChanges.push({ seconds: elapsed(), phase: o.cur, bag: { ...room.bag } });
      previousPhase = o.cur; previousItems = room.items.length;
    }
    if (!target || !wp) { reason = 'no objective target'; break; }
    const routeYaw = Math.atan2(b.x - wp.x, b.z - wp.z);
    const door = doorTargetIn(room.doors, b.x, b.z, routeYaw, 1.8, b.y);
    if (door >= 0 && !room.doorOpen[door] && !room.doorLocked[door]) room.act(pl, 'use', door);
    if (target.item !== undefined && seen.has(target.item)) {
      const it = room.items.find(it => it.id === target!.item);
      if (it && room.act(pl, 'pick', it.id)) picks.push({ seconds: elapsed(), id: it.id, kind: it.kind });
    }
    if (room.level.def.blackout && o.cur === 1) room.act(pl, 'fuse', 0);
    const warden = (room as any).warden as Mob | undefined, monitors = (room as any).monitors as Mob[];
    const wardenD = warden ? Math.hypot(warden.p[0] - b.x, warden.p[2] - b.z) : Infinity, chased = warden?.state === 'chase';
    // Quiet reserves stamina; adaptive crouches near Warden until a chase calls for a sprint.
    flags = strategy === 'run-guide' || (chased && canRun(pl.stamina, pl.exhausted)) ? F_RUN : strategy === 'adaptive-guide' && wardenD < 16 ? F_CROUCH : 0;
    const speed = flags & F_RUN && canRun(pl.stamina, pl.exhausted) ? SPEED.run : flags & F_CROUCH ? SPEED.crouch : SPEED.walk;
    const dx = wp.x - b.x, dz = wp.z - b.z, d = Math.hypot(dx, dz) || 1;
    moveCapsule(world, b, dx / d * Math.min(d, speed * dt), dz / d * Math.min(d, speed * dt), dt, NAV_CAPSULE);
    // Aim from predicted camera at a genuinely visible body point, including heads above furniture.
    // AI state access and instant accurate turning are ideal-player assumptions, disclosed in output.
    const eye = { x: b.x, y: b.y + (flags & F_CROUCH ? CROUCH_EYE_H : EYE_H), z: b.z };
    const visible = monitors.flatMap(m => {
      const h = [1.65, 1, .35].find(h => Math.hypot(m.p[0] - eye.x, m.p[1] + h - eye.y, m.p[2] - eye.z) <= 40 && los(eye, { x: m.p[0], y: m.p[1] + h, z: m.p[2] }));
      return h === undefined ? [] : [{ m, h, distance: Math.hypot(m.p[0] - eye.x, m.p[2] - eye.z) }];
    }).sort((a, c) => a.distance - c.distance)[0];
    const look = visible ? Math.atan2(b.x - visible.m.p[0], b.z - visible.m.p[2]) : routeYaw;
    const pitch = visible ? Math.atan2(visible.m.p[1] + visible.h - eye.y, visible.distance) : 0;
    const to: Vec3 = [b.x, b.y, b.z], from = [...pl.p];
    room.applyInput(pl, { t: 'input', seq: i, p: to, yaw: look, pitch, f: flags, c: pl.c }, room.tick * TICK_MS);
    const yDelta = Math.abs(pl.p[1] - to[1]), xyzDelta = Math.hypot(pl.p[0] - to[0], pl.p[1] - to[1], pl.p[2] - to[2]);
    if (xyzDelta > .01) {
      rejected++; if (yDelta > .01) rejectedY++;
      if (rejectedExamples.length < 8) rejectedExamples.push({ seconds: elapsed(), from: point(from), requested: point(to), accepted: point(pl.p), phase: o.cur });
      b.x = pl.p[0]; b.y = pl.p[1]; b.z = pl.p[2];
    }
    endpoint = snapshot(); // A catch relocates the player; retain the real pre-catch failure position.
    room.step();
    const wardenChase = warden?.state === 'chase', monitorChase = monitors.some(m => m.state === 'chase');
    if (wardenChase && firstWardenChase === null) firstWardenChase = elapsed();
    if (monitorChase && firstMonitorChase === null) firstMonitorChase = elapsed();
    const chase = wardenChase || monitorChase;
    if (chase && !chasing) discovered++; chasing = chase;
    if (i % 100 === 0) { checkpoints.push(endpoint); if (checkpoints.length > 16) checkpoints.shift(); }
    if (Math.hypot(pl.p[0] - progressPoint[0], pl.p[1] - progressPoint[1], pl.p[2] - progressPoint[2]) > .8) { progressPoint = [...pl.p]; stallAt = elapsed(); }
    if (elapsed() - stallAt >= stallLimit && pl.st === 0) { reason = `route stalled ${stallLimit}s`; break; }
  }
  if (room.levelIndex !== level) reason = 'cleared'; else if (pl.st !== 0) reason = 'caught';
  const caughtEvents = events.slice(eventStart).filter((m): m is Extract<ServerMsg, { t: 'caught' }> => m.t === 'caught');
  const sample: Sample = { strategy, seed, level: level + 1, seconds: elapsed(), cleared: room.levelIndex !== level, discovered, firstWardenChase, firstMonitorChase, caught: caughtEvents.length, caughtBy: caughtEvents.map(m => m.by ?? 'unknown'), rejectedMoves: rejected, rejectedY, reason, endpoint, checkpoints, phaseChanges, picks, rejectedExamples };
  samples.push(sample);
  console.log(JSON.stringify({ strategy, seed, level: sample.level, seconds: sample.seconds, cleared: sample.cleared, reason, caughtBy: sample.caughtBy, rejected, endpoint: endpoint.position, phase: endpoint.phase, picks: picks.length }));
}
mkdirSync('test-results/level-difficulty', { recursive: true });
const filename = `test-results/level-difficulty/path-samples-${strategies.join('+')}.json`, baselinePath = 'test-results/level-difficulty/path-samples-baseline.json';
const output = { metadata: { strategies, seeds, levels: levels.map(n => n + 1), limitGameSeconds: limit, stallLimitGameSeconds: stallLimit, timing: '20 TPS simulated game time; independent natural-spawn level attempts', limitations: 'Known map/objective and AI state; instant accurate turning and perfect visible-monitor attention; not random novice or browser play time', itemSeen: 'Production 8m camera range and LOS, 4Hz update; no all-seen shortcut', debugActions: 'none', baseline: baselinePath }, samples };
if (samples.length) {
  writeFileSync(filename, JSON.stringify(output, null, 2));
  writeFileSync('test-results/level-difficulty/path-samples.json', JSON.stringify({ ...(existsSync(baselinePath) ? { baseline: JSON.parse(readFileSync(baselinePath, 'utf8')) } : {}), ...output }, null, 2));
  console.log(JSON.stringify({ file: filename, samples: samples.length, clears: samples.filter(s => s.cleared).length, l2Clears: samples.filter(s => s.level === 2 && s.cleared).length }));
}
// Preserve the original exact strategy for reproducibility, including its all-seen shortcut, every-tick
// guidance, always-run input, sequential L1/L2 room and separate stationary threat samples.
// PROBE_STRATEGIES=baseline-run intentionally ignores the new variant's seed/level filters.
function runBaseline() {

type Sample = { seed: number; level: number; seconds: number; cleared: boolean; discovered: number; caught: number; rejectedMoves: number; reason: string; endpoint: unknown; checkpoints: unknown[] };
const samples: Sample[] = [];
for (const seed of [1, 4, 7]) {
  const events: ServerMsg[] = [], room = new Room(`P${seed}`, seed, nav), conn = { id: 1, name: 'ideal', send: (m: ServerMsg) => events.push(m), sendRaw: (s: string) => events.push(JSON.parse(s)) };
  room.started = false; room.add(conn, 0); room.handle(conn, { t: 'start' }, 0);
  const pl = room.players.get(1)!;
  for (const level of [0, 1]) {
    if (room.levelIndex !== level) (room as any).loadLevel(level);
    const startTick = room.tick, eventStart = events.length, g = levelAreaNav(nav, room.level);
    const world = new CollisionWorld([...(data.colliders as AABB[]), ...levelSolids(room.level.def)]);
    for (const h of data.holes) world.addHole(h.x0, h.x1, h.z0, h.z1);
    const slabs = room.doors.map(d => world.add(campusDoorSlab(d, false)));
    const b: Body = { x: pl.p[0], y: pl.p[1], z: pl.p[2], vy: 0, grounded: true };
    let discovered = 0, chasing = false, rejected = 0, reason = 'time limit';
    let endpoint: unknown = null; const checkpoints: unknown[] = [];
    for (let i = 0; i < 240 / dt; i++) {
      if (room.levelIndex !== level) { reason = 'cleared'; break; }
      if (pl.st !== 0) { reason = 'caught'; break; }
      if ((room as any).advanceAt !== undefined) { room.step(); continue; }
      for (const d of room.doors) world.move(slabs[d.id], campusDoorSlab(d, room.doorOpen[d.id]));
      const los = (a: { x: number; y: number; z: number }, c: { x: number; y: number; z: number }) => lineOfSight(world, a, c);
      const o = objective(room.level.def, room.bag, room.fusesIn), target = goalPoint(room.level.def, o, room.items, new Set(room.items.map(i => i.id)), b, g);
      if (!target) { reason = 'no objective target'; break; }
      const wp = guideWaypoint(g, b, target, los, (a, c) => shutDoorOn(room.doors, room.doorOpen, a, c));
      const yaw = Math.atan2(b.x - wp.x, b.z - wp.z);
      const door = doorTargetIn(room.doors, b.x, b.z, yaw, 1.8, b.y);
      if (door >= 0 && !room.doorOpen[door] && !room.doorLocked[door]) room.act(pl, 'use', door);
      if (target.item !== undefined) room.act(pl, 'pick', target.item);
      if (room.level.def.blackout && o.cur === 1) room.act(pl, 'fuse', 0);
      // Perfect coordination with one monitor: strafe towards the route while keeping it in view.
      const monitors = (room as any).monitors as { p: Vec3; state: string }[];
      const nearest = monitors.filter(m => los({ x: b.x, y: b.y + 1.6, z: b.z }, { x: m.p[0], y: m.p[1] + 1.2, z: m.p[2] })).sort((a, c) => Math.hypot(a.p[0] - b.x, a.p[2] - b.z) - Math.hypot(c.p[0] - b.x, c.p[2] - b.z))[0];
      const look = nearest ? Math.atan2(b.x - nearest.p[0], b.z - nearest.p[2]) : yaw;
      const dx = wp.x - b.x, dz = wp.z - b.z, d = Math.hypot(dx, dz) || 1, speed = canRun(pl.stamina, pl.exhausted) ? SPEED.run : SPEED.walk;
      moveCapsule(world, b, dx / d * Math.min(d, speed * dt), dz / d * Math.min(d, speed * dt), dt, NAV_CAPSULE);
      const to: Vec3 = [b.x, b.y, b.z];
      room.applyInput(pl, { t: 'input', seq: i, p: to, yaw: look, pitch: nearest ? -.04 : 0, f: F_RUN, c: pl.c }, room.tick * TICK_MS);
      if (Math.hypot(pl.p[0] - to[0], pl.p[2] - to[2]) > .01) { rejected++; b.x = pl.p[0]; b.y = pl.p[1]; b.z = pl.p[2]; }
      endpoint = { seconds: +((room.tick - startTick) * dt).toFixed(2), position: [...pl.p], phase: o.cur, bag: { ...room.bag }, target, waypoint: wp, warden: (room as any).warden && { position: [...(room as any).warden.p], state: (room as any).warden.state }, monitors: monitors.map(m => ({ position: [...m.p], state: m.state })) };
      if (i % 100 === 0) { checkpoints.push(endpoint); if (checkpoints.length > 16) checkpoints.shift(); }
      room.step();
      const chase = (room as any).warden?.state === 'chase' || monitors.some(m => m.state === 'chase');
      if (chase && !chasing) discovered++; chasing = chase;
    }
    samples.push({ seed, level: level + 1, seconds: +(dt * (room.tick - startTick)).toFixed(2), cleared: room.levelIndex !== level, discovered, caught: events.slice(eventStart).filter(m => m.t === 'caught').length, rejectedMoves: rejected, reason, endpoint, checkpoints });
  }
}

// A separate real-threat sample: stand without looking after acquiring the real first key. No debug summon/safe.
const threats = [];
for (const level of [0, 1]) {
  const events: ServerMsg[] = [], room = new Room('THRT', 4, nav), conn = { id: 1, name: 'stationary', send: (m: ServerMsg) => events.push(m), sendRaw: (s: string) => events.push(JSON.parse(s)) };
  room.started = false; room.add(conn, 0); room.handle(conn, { t: 'start' }, 0);
  if (level) (room as any).loadLevel(level);
  const pl = room.players.get(1)!;
  if (!level) { const key = room.items.find(i => i.kind === 'drawer_key' && !i.decoy)!; pl.p = [key.p[0] + .8, 0, key.p[2]]; room.act(pl, 'pick', key.id); }
  // The L1 placement above isolates the encounter gate; it is reported as placement, not a route.
  let firstChase: number | null = null, firstCatch: number | null = null;
  for (let i = 0; i < 120 / dt; i++) {
    pl.yaw += .013; room.step();
    if (firstChase === null && ((room as any).warden?.state === 'chase' || (room as any).monitors.some((m: any) => m.state === 'chase'))) firstChase = +(i * dt).toFixed(2);
    if (events.some(m => m.t === 'caught')) { firstCatch = +(i * dt).toFixed(2); break; }
  }
  threats.push({ level: level + 1, seed: 4, placement: level ? 'natural spawn' : 'placed at real drawer key, picked through Room.act', firstChase, firstCatch, caught: events.filter(m => m.t === 'caught').length });
}
mkdirSync('test-results/level-difficulty', { recursive: true });
writeFileSync('test-results/level-difficulty/path-samples-baseline-diagnostics.json', JSON.stringify({ samples, threats }, null, 2));
console.log(JSON.stringify({ samples, threats }, null, 2));

}
if (strategies.includes('baseline-run')) runBaseline();
