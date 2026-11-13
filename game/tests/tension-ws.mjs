// Genuine /ws acceptance against our separately started, built server on 4421. No browser/audio needed.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { CollisionWorld, moveCapsule, overlaps } from '../shared/campus/collision.ts';
import { lineOfSight, NAV_CAPSULE } from '../shared/campus/nav.ts';
import { campusDoorSlab } from '../shared/doors.ts';
import { EYE_H } from '../shared/constants.ts';
import { WARDEN_CHASE_SPEED, WARDEN_EYE_H } from '../server/ai/warden.ts';

const URL = 'ws://127.0.0.1:4421/ws';
const start = performance.now(), peers = [], report = {
  status: 'running', cases: [], rooms: [], trace: [],
  method: 'Genuine WebSocket clients and 20 TPS authoritative snapshots. Debug is used only to stage the initial catch and escape; subsequent pursuits and every lighting scare are natural.',
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const elapsed = () => Math.round(performance.now() - start);
const campus = JSON.parse(readFileSync(new globalThis.URL('../shared/campus/colliders.json', import.meta.url), 'utf8'));
// Stay on the hallway side of the western classroom doors, then turn south into the west corridor.
const ESCAPE_ROUTE = [[-55.2, 73.36], [-55.2, 83.2]];
function collisionState() {
  const world = new CollisionWorld(campus.colliders);
  for (const h of campus.holes) world.addHole(h.x0, h.x1, h.z0, h.z1);
  const doors = new Map(campus.doors.map(d => [d.id, { spot: d, box: world.add(campusDoorSlab(d, false)) }]));
  return { world, doors };
}

function checkEscapeRoute() {
  const { world } = collisionState(), body = { x: -41.285, y: 0, z: 73.36, vy: 0, grounded: true };
  let samples = 0;
  for (const [x, z] of ESCAPE_ROUTE) {
    for (let guard = 0; Math.hypot(x - body.x, z - body.z) > .01 && guard < 1000; guard++) {
      const dx = x - body.x, dz = z - body.z, d = Math.hypot(dx, dz), step = Math.min(.17, d);
      moveCapsule(world, body, dx / d * step, dz / d * step, .05, NAV_CAPSULE);
      assert.equal(overlaps(world, body, NAV_CAPSULE), false, 'route must never enter a wall or shut door');
      samples++;
    }
    assert.ok(Math.hypot(x - body.x, z - body.z) < .01, `unreachable escape waypoint ${x},${z}`);
  }
  const occluded = !lineOfSight(world, { x: -41.285, y: WARDEN_EYE_H, z: 73.36 }, { x: body.x, y: body.y + EYE_H, z: body.z });
  assert.ok(occluded, 'the completed corner blocks sight from the spawn hallway');
  return { route: ESCAPE_ROUTE, waypoints: ESCAPE_ROUTE.length, samples, allDoorsClosed: true, cornerOccluded: occluded, p: [body.x, body.y, body.z] };
}

class Peer {
  constructor(label) {
    this.label = label; this.players = new Map(); this.mobs = new Map(); this.events = []; this.pending = [];
    this.snapshots = new Map(); this.seq = 0; this.c = 0;
    const collision = collisionState(); this.collision = collision.world; this.doorBoxes = collision.doors;
    this.ws = new WebSocket(URL); peers.push(this);
    this.ws.on('error', e => { this.error = e.message; });
    this.ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'welcome') this.id = m.id;
      if (m.t === 'room') {
        this.room = m;
        if (m.started && this.readyIncarnation !== m.incarnation) {
          this.readyIncarnation = m.incarnation;
          this.send({ t: 'ready', incarnation: m.incarnation });
        }
      }
      if (m.t === 'doors' || (m.t === 'snap' && m.doors)) for (const d of m.doors) {
        const door = this.doorBoxes.get(d.id);
        if (door) this.collision.move(door.box, campusDoorSlab(door.spot, d.open));
      }
      if (m.t === 'correct') { this.c = m.c; this.position = [...m.p]; this.corrections = (this.corrections ?? 0) + (m.forced ? 0 : 1); }
      if (m.t === 'snap') {
        this.tick = m.tick;
        // Room emits trip/caught before the snapshot for that same tick. Bind events to that
        // authoritative tick so a 44.95 s interval cannot pass because of packet timing.
        for (const row of this.pending.splice(0)) row.tick = m.tick;
        this.snapshots.set(m.tick, JSON.stringify(m));
        if (this.snapshots.size > 256) this.snapshots.delete(this.snapshots.keys().next().value);
        const members = new Set(this.room.players.map(p => p.id));
        for (const p of m.players) if (!members.has(p.id)) this.error = `Player ${p.id} leaked into ${this.room.code}`;
        for (const p of m.players) this.players.set(p.id, { ...this.players.get(p.id), ...p, st: p.st ?? 0 });
        for (const m1 of m.mobs) {
          const old = this.mobs.get(m1.id), next = { ...old, ...m1 };
          if (next.target && !members.has(next.target)) this.error = `Target ${next.target} leaked into ${this.room.code}`;
          if (m1.id === 1 && (next.anim !== old?.anim || next.target !== old?.target)) this.record({ type: 'warden', anim: next.anim, target: next.target, p: next.p }, m.tick);
          if (m1.id === 1 && this.continuity && old && this.lastTick && m.tick > this.lastTick) {
            const d = Math.hypot(...m1.p.map((n, i) => n - old.p[i])), dt = (m.tick - this.lastTick) / 20;
            this.maxStep = Math.max(this.maxStep ?? 0, d);
            if (d > WARDEN_CHASE_SPEED * dt + .03) this.error = `Nonwalking Warden step ${d.toFixed(3)}m / ${dt}s`;
          }
          this.mobs.set(m1.id, next);
        }
        this.lastTick = m.tick;
      } else if (m.t === 'trip' || m.t === 'caught' || m.t === 'fade') {
        if (m.t === 'fade') this.continuity = false; // a declared level reset is a legitimate spawn, not walking
        this.record({ type: m.t, ...m });
      }
    });
  }
  record(event, tick) {
    const row = { atMs: elapsed(), tick, peer: this.label, ...event };
    this.events.push(row); report.trace.push(row);
    if (tick === undefined) this.pending.push(row);
  }
  send(m) { assert.equal(this.ws.readyState, WebSocket.OPEN); this.ws.send(JSON.stringify(m)); }
  own() { return this.players.get(this.id); }
  input(p = this.own().p, yaw = this.own()?.yaw ?? 0, f = 0) { this.send({ t: 'input', seq: ++this.seq, c: this.c, p, yaw, pitch: 0, f }); }
  async ready() { await wait(() => this.id, `${this.label} welcome`); this.send({ t: 'hello', name: this.label }); }
}
async function wait(fn, label, timeout = 10_000) {
  const until = performance.now() + timeout;
  while (performance.now() < until) {
    for (const p of peers) assert.equal(p.error, undefined, `${p.label}: ${p.error}`);
    const value = fn(); if (value) return value;
    await delay(20);
  }
  assert.fail(`Timeout: ${label}`);
}
async function check(name, fn) {
  const row = { name, status: 'running' }; report.cases.push(row);
  try { row.evidence = await fn(); row.status = 'passed'; console.log(`PASS ${name}`); }
  catch (e) { row.status = 'failed'; row.error = e.stack; throw e; }
}
async function walkEscape(peer) {
  const p = peer.own().p;
  const body = { x: p[0], y: p[1], z: p[2], vy: 0, grounded: true };
  const route = ESCAPE_ROUTE, reached = [];
  const until = performance.now() + 11_000;
  let i = 0, cornerOccludedTick;
  while (i < route.length && performance.now() < until && peer.own().st === 0) {
    const [x, z] = route[i], dx = x - body.x, dz = z - body.z, d = Math.hypot(dx, dz);
    const own = peer.own(), warden = peer.mobs.get(1);
    if (i > 0 && cornerOccludedTick === undefined && warden.anim === 'chase' && !lineOfSight(peer.collision,
      { x: warden.p[0], y: warden.p[1] + WARDEN_EYE_H, z: warden.p[2] }, { x: own.p[0], y: own.p[1] + EYE_H, z: own.p[2] })) cornerOccludedTick = peer.tick;
    if (d < .1) {
      await wait(() => Math.hypot(peer.own().p[0] - x, peer.own().p[2] - z) < .15, `server accepts escape waypoint ${i + 1}`);
      reached.push({ tick: peer.tick, p: [...peer.own().p] }); i++; continue;
    }
    const speed = (peer.own().sta ?? 1) > .25 ? 6 : 3.4;
    const step = Math.min(speed * .05, d);
    moveCapsule(peer.collision, body, dx / d * step, dz / d * step, .05, NAV_CAPSULE);
    peer.input([body.x, body.y, body.z], Math.atan2(-dx, -dz), speed > 4 ? 2 : 0);
    await delay(50);
  }
  peer.input([body.x, body.y, body.z]);
  assert.equal(i, route.length, `escape route incomplete: ${i}/${route.length}, stopped at ${[body.x, body.y, body.z]}`);
  assert.ok(cornerOccludedTick !== undefined, 'authoritative player and hunter positions must show sight broken by the corner during the chase');
  await wait(() => Math.hypot(peer.own().p[0] - body.x, peer.own().p[2] - body.z) < .15, 'server accepts the final corridor waypoint');
  return { route, waypoints: i, reached, cornerOccludedTick, p: [...peer.own().p], corrections: peer.corrections ?? 0 };
}

if (process.argv.includes('--route-only')) {
  const evidence = checkEscapeRoute();
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/tension-escape-route.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} else try {
  report.routePreflight = checkEscapeRoute();
  const a = new Peer('pace-host'), mate = new Peer('pace-rescuer'), b = new Peer('isolated-runner');
  await Promise.all(peers.map(p => p.ready()));
  a.send({ t: 'create' }); b.send({ t: 'create' });
  await wait(() => a.room && b.room, 'two independent lobbies');
  assert.notEqual(a.room.code, b.room.code);
  mate.send({ t: 'join', code: a.room.code });
  await wait(() => a.room.players.length === 2 && mate.room, 'cooperative join');
  a.send({ t: 'start' }); b.send({ t: 'start' });
  await wait(() => a.own() && mate.own() && b.own() && a.mobs.has(1) && b.mobs.has(1), 'authoritative snapshots');
  report.rooms = [a, b].map(p => ({ code: p.room.code, seed: p.room.seed, members: p.room.players.map(p => p.id) }));

  await check('real WS catch, synchronized threat, rescue, and no chain catch during 20s respite', async () => {
    a.input(a.own().p, Math.PI / 2);
    mate.send({ t: 'debug', op: 'tp', x: a.own().p[0] - .5, z: a.own().p[2] });
    await wait(() => Math.abs(a.own().yaw - Math.PI / 2) < .02 && Math.hypot(mate.own().p[0] - a.own().p[0], mate.own().p[2] - a.own().p[2]) < 1, 'corridor pose');
    a.send({ t: 'debug', op: 'warden', d: 6 });
    await wait(() => a.mobs.get(1)?.anim === 'chase' && mate.mobs.get(1)?.target === a.id, 'same authoritative chase on both sockets');
    a.continuity = mate.continuity = true;
    const caught = await wait(() => a.events.find(e => e.type === 'caught' && e.tick !== undefined), 'natural catch after explicit debug setup');
    assert.equal(caught.by, 'warden');
    const rescueUntil = performance.now() + 6000;
    while (a.own().st !== 0 && performance.now() < rescueUntil) { mate.send({ t: 'act', kind: 'revive', id: a.id }); await delay(100); }
    await wait(() => a.own().st === 0, 'rescued player up');
    while ((a.tick - caught.tick) / 20 < 20) {
      assert.equal(mate.own().st, 0, 'the teammate must not be chain-caught');
      assert.equal(a.own().st, 0, 'rescue must not immediately re-catch the same player');
      assert.notEqual(a.mobs.get(1).anim, 'chase', 'the group receives a full minimum respite');
      await delay(50);
    }
    return { caughtTick: caught.tick, observedUntilTick: a.tick, rescued: a.own().st === 0, teammate: mate.own().st };
  });

  await check('different room can escape a genuine chase using accepted running and a corridor corner', async () => {
    b.input(b.own().p, -Math.PI / 2);
    await wait(() => Math.abs(b.own().yaw + Math.PI / 2) < .02, 'runner faces east');
    b.send({ t: 'debug', op: 'warden', d: 12 });
    await wait(() => b.mobs.get(1)?.anim === 'chase', 'runner chased');
    b.continuity = true;
    const evidence = await walkEscape(b);
    await wait(() => b.mobs.get(1)?.anim !== 'chase', 'sight lost / timed hunt ended', 20_000);
    assert.equal(b.own().st, 0);
    assert.equal(b.events.some(e => e.type === 'caught'), false);
    assert.equal(b.corrections ?? 0, 0, 'normal route has no rejected movement');
    return { ...evidence, escapedTick: b.tick, state: b.mobs.get(1).anim };
  });

  await check('next natural pursuit rotates to the teammate, not the rescued previous target', async () => {
    const first = a.events.find(e => e.type === 'warden' && e.anim === 'chase' && e.target === a.id);
    assert.ok(first, 'the initial chase must actually have occurred');
    const next = await wait(() => a.events.find(e => e.type === 'warden' && e.anim === 'chase' && e.tick > first.tick), 'next natural pursuit', 100_000);
    assert.equal(next.target, mate.id, 'the very next pursuit must rotate to the eligible teammate');
    assert.ok((next.tick - first.tick) / 20 >= 60, 'the next real pursuit waits at least 60 s after the previous chase began');
    assert.ok((next.tick - first.tick) / 20 <= 90, 'the next real pursuit starts within 90 s');
    return { nextTick: next.tick, target: next.target, previousTarget: a.id, intervalSeconds: (next.tick - first.tick) / 20, noDebugResummon: true };
  });

  await check('natural scare cooldown and multiroom membership stay authoritative', async () => {
    // Observe enough time for an additional natural lighting event; no debug power events are sent.
    await wait(() => a.tick >= 120 * 20 && a.events.filter(e => e.type === 'trip' && e.off > 0 && e.tick !== undefined).length >= 2
      && b.events.some(e => e.type === 'trip' && e.off > 0 && e.tick !== undefined), 'at least two natural scares in the group room and one in the escape room', 160_000);
    for (const peer of [a, b]) {
      const trips = peer.events.filter(e => e.type === 'trip' && e.off > 0);
      assert.ok(trips.length >= (peer === a ? 2 : 1), 'scare coverage must have real events');
      for (let i = 1; i < trips.length; i++) assert.ok((trips[i].tick - trips[i - 1].tick) / 20 >= 45, 'natural scares >=45s apart');
      const members = new Set(peer.room.players.map(p => p.id));
      for (const event of peer.events.filter(e => e.type === 'warden' && e.target)) assert.ok(members.has(event.target), 'no target from a different room');
      for (const member of peer.players.keys()) assert.ok(members.has(member), 'no player leakage');
    }
    const sharedTicks = [...a.snapshots.keys()].filter(tick => mate.snapshots.has(tick));
    assert.ok(sharedTicks.length >= 20, 'cooperative sockets have at least one second of matching authoritative snapshots');
    for (const tick of sharedTicks) assert.equal(a.snapshots.get(tick), mate.snapshots.get(tick), `same-room snapshot at tick ${tick}`);
    const aTrips = a.events.filter(e => e.type === 'trip' && e.off > 0).map(e => ({ tick: e.tick, at: e.at, off: e.off }));
    assert.deepEqual(aTrips, mate.events.filter(e => e.type === 'trip' && e.off > 0).map(e => ({ tick: e.tick, at: e.at, off: e.off })), 'room members receive identical scare broadcasts');
    return { synchronizedTicks: sharedTicks.length, rooms: [a, b].map(p => ({ seed: p.room.seed, tripTicks: p.events.filter(e => e.type === 'trip' && e.off > 0).map(e => e.tick), maxWalkingStep: p.maxStep ?? 0 })) };
  });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.stack; console.error(error.stack); process.exitCode = 1;
} finally {
  for (const p of peers) p.ws.close();
  await delay(200);
  for (const p of peers) if (p.ws.readyState !== WebSocket.CLOSED) p.ws.terminate();
  report.durationMs = elapsed();
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/tension-ws.json', JSON.stringify(report, null, 2));
}
