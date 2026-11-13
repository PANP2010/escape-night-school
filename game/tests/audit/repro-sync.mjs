// Deterministic CPU/source-method probes, intentionally outside the default test gates.
// Run from game/: node tests/audit/repro-sync.mjs
// After successful completion and a fresh JSON with errors=[], exit 1 means product invariants failed.
// Caught fixture failures exit 2. Top-level import/read failures may also exit 1: inspect stderr and JSON freshness.
// No browser, websocket, renderer or real keyboard is used; this is not a passing gameplay check.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { TICK_MS, EXTRAP_MAX_MS, EXTRAP_MAX_SPEED, INTERP_DELAY_MS, SPEED } from '../../shared/constants.ts';
import { F_CROUCH, F_HIDE, ST_DOWN, ST_OK } from '../../shared/protocol.ts';
import { inReachDown } from '../../shared/interact.ts';
import { frameSlices, InterpBuffer, PlaybackClock, SnapClock, StepSmoother } from '../../client/src/interp.ts';
import { WARDEN_CHASE_SPEED } from '../../server/ai/warden.ts';

const output = new URL('../../test-results/metal-audit/sync-repro.json', import.meta.url);
const roomSource = readFileSync(new URL('../../server/room.ts', import.meta.url), 'utf8');
const gameSource = readFileSync(new URL('../../client/src/game.ts', import.meta.url), 'utf8');
const result = {
  startedAt: new Date().toISOString(),
  coverage: 'Production CPU modules plus source-method replay with synthetic fixtures; not authoritative end-to-end gameplay or visible rendering.',
  fixtureRandom: 'Math.random=0.5 only in this isolated process, fixing the initial breathing/weight-shift phase.',
  sourceSha256: {
    room: createHash('sha256').update(roomSource).digest('hex'),
    game: createHash('sha256').update(gameSource).digest('hex'),
  },
  probes: {}, failures: [], errors: [], executionCompleted: false,
};
const check = (name, assertion) => {
  try { assertion(); } catch (error) { result.failures.push({ name, message: error.message }); }
};

// Room's JSON imports are bundled by Vite, so do not import/construct a Room here or build its campus graph.
// Execute the actual checked-in method bodies, retaining source hashes; never substitute a copied revive algorithm.
function sourceMethod(source, signature, parameters, dependencies) {
  const at = source.indexOf(signature);
  assert.notEqual(at, -1, `Fixture needs updating: method signature ${signature}`);
  const start = at + signature.length;
  let depth = 1, end = start;
  // These specific bodies contain no braces in string literals. Fail syntax evaluation if their shape changes.
  for (; depth && end < source.length; end++) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
  }
  assert.equal(depth, 0, `Unclosed method ${signature}`);
  return new Function(...Object.keys(dependencies), `return function(${parameters}) {${source.slice(start, end - 1)}}`)(...Object.values(dependencies));
}
function numberConstant(source, name) {
  const match = source.match(new RegExp(`(?:export )?const ${name} = ([0-9.]+);`));
  assert.ok(match, `Fixture needs updating: numeric constant ${name}`);
  return Number(match[1]);
}

// Texture painters only need a permissive 2D context for CPU geometry/animation. No GPU or canvas is created.
const context2d = new Proxy(function () {}, {
  get: (_, key) => key === 'measureText' ? () => ({ width: 1 }) : context2d,
  apply: () => context2d,
  set: () => true,
});
const ring = { hidden: true, progress: 0, style: { setProperty: (_, value) => { ring.progress = Number(value); } } };
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => context2d }),
  getElementById: (id) => id === 'revive-ring' ? ring : null,
};

const originalRandom = Math.random;
Math.random = () => 0.5;
try {
  const initialClock = new SnapClock(TICK_MS), clockBuffer = new InterpBuffer(), clockTrace = [];
  let sampleAt2500Before = null;
  for (let tick = 0; tick <= 21; tick++) {
    const stampMs = initialClock.stamp(tick, 2000);
    clockBuffer.push({ t: stampMs, x: tick, y: 0, z: 0, yaw: 0 });
    clockTrace.push({ tick, stampMs });
    if (tick === 20) sampleAt2500Before = clockBuffer.at(2500).x;
  }
  const existingCaseClock = new SnapClock(TICK_MS), existingBacklogTrace = [];
  for (let tick = 0; tick < 28; tick++) {
    const now = 1400 + Math.floor(tick / 14) * 2;
    existingBacklogTrace.push({ tick, now, stampMs: existingCaseClock.stamp(tick, now) });
  }
  result.probes.clockBacklog = {
    type: 'Production SnapClock/InterpBuffer CPU calls',
    initialBatch: { receivedAtMs: 2000, trace: clockTrace, sampleAt2500Before, sampleAt2500After: clockBuffer.at(2500).x },
    existingUnitCase: { source: 'tests/unit/snapclock.test.ts backlog input at line 58', trace: existingBacklogTrace },
  };
  check('every initial backlog stamp increases', () => {
    for (let i = 1; i < clockTrace.length; i++) assert.ok(clockTrace[i].stampMs > clockTrace[i - 1].stampMs,
      `tick ${i}: ${clockTrace[i - 1].stampMs} → ${clockTrace[i].stampMs}`);
  });

  const REVIVE_S = numberConstant(roomSource, 'REVIVE_S');
  const REVIVE_STALE_TICKS = numberConstant(roomSource, 'REVIVE_STALE_TICKS');
  const SAFE_S = numberConstant(roomSource, 'SAFE_S');
  const revive = sourceMethod(roomSource, 'private revive(pl: Player, id: number): boolean {', 'pl, id', { inReachDown, ST_DOWN, ST_OK });
  const stepRevives = sourceMethod(roomSource, 'private stepRevives() {', '', { inReachDown, ST_DOWN, ST_OK, REVIVE_S, REVIVE_STALE_TICKS, TICK_MS });
  const tickRevive = sourceMethod(gameSource, 'private tickRevive(tgt: Cand | null, now: number) {', 'tgt, now', {
    document: globalThis.document, TICK_MS, REVIVE_HOLD_S: numberConstant(gameSource, 'REVIVE_HOLD_S'),
  });
  function hold(frameMs) {
    const helper = { p: [1, 0, 0], yaw: 0, st: ST_OK };
    const downed = { p: [0, 0, 0], yaw: 0, st: ST_DOWN, heldUntil: 600 };
    const room = { tick: 0, safeTicks: SAFE_S * 1000 / TICK_MS, players: new Map([[1, helper], [2, downed]]) };
    const sentAtMs = [], resetAtMs = [];
    const client = {
      down: false, spectate: false, reviveId: 0, reviveSince: 0, lastRevSend: 0,
      input: { down: () => true },
      net: { send: (message) => {
        if (message.t === 'act' && message.kind === 'revive') { sentAtMs.push(room.tick * TICK_MS); revive.call(room, helper, message.id); }
      } },
    };
    let firstUpMs = null;
    ring.progress = 0;
    for (let tick = 0; tick <= 9000 / TICK_MS; tick++) {
      room.tick = tick;
      const elapsedMs = tick * TICK_MS;
      if (elapsedMs % frameMs === 0) {
        // Game.start supplies the same `now` to all local simulation slices of one rendered frame.
        for (const _slice of frameSlices(frameMs / 1000)) tickRevive.call(client, { kind: 'revive', id: 2 }, 1000 + elapsedMs);
      }
      const before = !!helper.reviving;
      stepRevives.call(room);
      if (before && !helper.reviving && downed.st === ST_DOWN) resetAtMs.push(elapsedMs);
      if (downed.st === ST_OK) { firstUpMs = elapsedMs; break; }
    }
    return { frameMs, sentAtMs, resetAtMs, firstUpMs, finalState: downed.st, localRingProgress: ring.progress };
  }
  const control = hold(50), moderate = hold(500), slow = hold(1000);
  result.probes.revive = {
    type: 'source-method replay',
    fixture: 'Valid stationary in-reach players, held E, 20 TPS authority; synchronous send before stepRevives; no actual network, key events, target ray, act gate or complete Room.step.',
    staleTicks: REVIVE_STALE_TICKS, control, moderate, slow,
  };
  check('normal-refresh control revives after full hold', () => assert.equal(control.firstUpMs, REVIVE_S * 1000));
  check('500 ms refresh control revives after full hold', () => assert.equal(moderate.firstUpMs, REVIVE_S * 1000));
  check('held E at 1 fps still revives', () => assert.equal(slow.finalState, ST_OK, `Target remained ST_DOWN; ${slow.resetAtMs.length} resets in 9 seconds, ring=${slow.localRingProgress}`));

  const { Student } = await import('../../client/src/warden/student.ts');
  const student = new Student(0x3366aa);
  const bounds = () => {
    student.root.updateMatrixWorld(true);
    student.warden.mesh.computeBoundingBox();
    const box = student.warden.mesh.boundingBox.clone().applyMatrix4(student.warden.mesh.matrixWorld);
    return { rootY: student.root.position.y, minimumY: box.min.y, maximumY: box.max.y };
  };
  const pose = (crouch, down) => { for (let i = 0; i < 120; i++) student.update(1 / 60, 0, crouch, false, 0, 3, down); };
  pose(false, false);
  const standing = bounds();
  // Evaluate the actual snapshot y expression instead of duplicating its offset calculation.
  const snapY = gameSource.match(/r\.buf\.push\(\{\s*t:\s*snapT,\s*x:\s*p\.p\[0\],\s*y:\s*([^,\n]+),\s*z:/);
  assert.ok(snapY, 'Fixture needs updating: Game remote snapshot y expression');
  const snapshotY = new Function('p', 'r', 'F_CROUCH', `return ${snapY[1]}`);
  const player = { p: [0, 0, 0], yaw: 0, f: F_CROUCH, st: ST_OK, slot: 0, loop: {}, conn: { send() {} } };
  student.root.position.y = snapshotY(player, player, F_CROUCH);
  pose(true, false);
  const crouching = bounds();
  student.root.position.y = player.p[1];
  const crouchAtAuthoritativeFeet = bounds();
  const punish = sourceMethod(roomSource, "private punish(pl: Player, by: 'warden' | 'monitor') {", 'pl, by', {
    F_HIDE, ST_DOWN, CAUGHT_HOLD_S: numberConstant(roomSource, 'CAUGHT_HOLD_S'), TICK_MS,
  });
  punish.call({ tick: 0, spawnPos: () => [0, 0, 0], correct() {} }, player, 'warden');
  student.root.position.y = snapshotY(player, player, F_CROUCH);
  pose(false, true); // Game suppresses crouch pose when down, but the snapshot root still reads the retained flag.
  const downAfterCrouch = bounds();
  student.root.position.y = player.p[1];
  const downAtAuthoritativeFeet = bounds();
  result.probes.feet = {
    type: 'Production Student CPU geometry plus source snapshot expression/punish replay',
    fixture: 'Authority feet y=0, same 0.93-scale avatar, two seconds to settle each pose; bounds cover warden.mesh SkinnedMesh only, excluding separate hair/lamp/cone/label; no rendered scene.',
    snapshotYExpression: snapY[1], retainedCrouchAfterPunish: !!(player.f & F_CROUCH),
    standing, crouching, crouchAtAuthoritativeFeet, downAfterCrouch, downAtAuthoritativeFeet,
  };
  // Compare exactly the same posed geometry at the authoritative feet: isolate the coordinate error, not contact-pad accuracy.
  check('crouch root conversion adds no floor penetration relative to the same pose at authoritative feet', () =>
    assert.ok(crouching.minimumY >= crouchAtAuthoritativeFeet.minimumY - 0.01,
      `minimumY=${crouching.minimumY}; authority-root control=${crouchAtAuthoritativeFeet.minimumY}`));
  check('downed root conversion adds no floor penetration relative to the same pose at authoritative feet', () =>
    assert.ok(downAfterCrouch.minimumY >= downAtAuthoritativeFeet.minimumY - 0.01,
      `minimumY=${downAfterCrouch.minimumY}; authority-root control=${downAtAuthoritativeFeet.minimumY}`));
  student.dispose();

  const { Mobs } = await import('../../client/src/mobs.ts');
  const mobs = new Mobs(new THREE.Scene()), dt = 1 / 60, speed = WARDEN_CHASE_SPEED;
  const remote = {
    buf: new InterpBuffer(), clock: new PlaybackClock(INTERP_DELAY_MS),
    sm: new StepSmoother(1.3, 1, numberConstant(gameSource, 'REMOTE_SNAP_M'), SPEED.run), down: false,
  };
  // Replay Game.update's actual remote clock/buffer/smoother fragment; flatten its continue and erase TS non-null syntax.
  const remoteStart = gameSource.indexOf('const first = Number.isNaN(r.clock.t);');
  const remoteEndMarker = 'r.sm.step(g.x, g.z, rdt, r.buf.paceSpeed());';
  const remoteEnd = gameSource.indexOf(remoteEndMarker, remoteStart);
  assert.ok(remoteStart >= 0 && remoteEnd >= remoteStart, 'Fixture needs updating: Game remote playback fragment');
  const remoteFragment = gameSource.slice(remoteStart, remoteEnd + remoteEndMarker.length);
  assert.ok(remoteFragment.includes('if (!s) continue;'), 'Fixture needs updating: empty-buffer guard');
  const remotePlayback = new Function('r', 'rdt', 'EXTRAP_MAX_MS', 'EXTRAP_MAX_SPEED', 'TICK_MS',
    remoteFragment.replace('if (!s) continue;', 'if (!s) return;').replaceAll(')!;', ');'));
  result.sourceSha256.remotePlaybackFragment = createHash('sha256').update(remoteFragment).digest('hex');
  const advanceRemote = () => remotePlayback(remote, dt, EXTRAP_MAX_MS, EXTRAP_MAX_SPEED, TICK_MS);
  let send = 0, largestAuthoritativeStep = 0, previousSampleX = null;
  const feed = (t) => {
    const x = t / 1000 * speed;
    if (previousSampleX !== null) largestAuthoritativeStep = Math.max(largestAuthoritativeStep, x - previousSampleX);
    previousSampleX = x;
    mobs.onSnap([{ id: 1, p: [x, 0, 0], yaw: 0, anim: 'chase' }], t);
    remote.buf.push({ t, x, y: 0, z: 0, yaw: 0 });
  };
  // Times are intentionally monotone and ideal: this defect is independent of SnapClock offset correction.
  for (let now = 0; now < 3000; now += 1000 * dt) {
    for (; send <= Math.min(now, 1000); send += TICK_MS) feed(send);
    mobs.update(now, dt);
    advanceRemote();
  }
  const before = mobs.byId.get(1).mesh.position.x;
  const remoteBefore = remote.sm.x;
  for (; send <= 3000; send += TICK_MS) feed(send);
  mobs.update(3000, dt);
  advanceRemote();
  const after = mobs.byId.get(1).mesh.position.x;
  const step = after - before;
  const limit = 1.5 * speed * dt + 0.5 + SPEED.walk * EXTRAP_MAX_MS / 1000;
  result.probes.mobDeliveryGap = {
    type: 'Production Mobs CPU update',
    fixture: '60 Hz playback continues throughout; WARDEN_CHASE_SPEED, 20 Hz ideal stamps; receive until 1 s, withhold delivery until 3 s, then drain every consecutive sample. Not a server tick freeze, whole-client freeze or latest-only packet loss.',
    speed,
    frameMs: dt * 1000, largestAuthoritativeStep, before, after, step, comparisonLimit: limit,
    remoteControl: {
      type: 'Game.update source-fragment replay with production InterpBuffer/PlaybackClock/StepSmoother',
      transformation: 'The loop empty-buffer continue becomes function return; erased TypeScript postfix non-null assertion; injected constants and remote state match production.',
      sourceFragment: remoteFragment,
      sourceSha256: result.sourceSha256.remotePlaybackFragment,
      before: remoteBefore, after: remote.sm.x, step: remote.sm.x - remoteBefore,
    },
  };
  check('remote production-path control smooths the same delivery gap', () => assert.ok(remote.sm.x - remoteBefore <= limit));
  check('2-second delivery gap does not teleport a normally moving mob', () => assert.ok(step <= limit, `step=${step} m in ${dt * 1000} ms, sample step=${largestAuthoritativeStep} m, limit=${limit}`));
  mobs.onSnap([], 3050); // Release this probe's figure geometry/skeleton.
  result.executionCompleted = true;
} catch (error) {
  result.errors.push({ message: error.message, stack: error.stack });
} finally {
  Math.random = originalRandom;
}

result.reproduced = result.failures.length > 0;
mkdirSync(new URL('.', output), { recursive: true });
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (result.errors.length) {
  console.error('INCOMPLETE: probe execution failed; exit 2 is not evidence of a fixed product.');
  process.exitCode = 2;
} else if (result.reproduced) {
  console.error('REPRODUCED: product invariants failed; exit 1 is expected until these defects are fixed.');
  process.exitCode = 1;
} else {
  console.log('NOT REPRODUCED: all explicit probe invariants passed; this is still not end-to-end or visual acceptance.');
}
