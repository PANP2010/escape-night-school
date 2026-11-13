import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { Game } from '../../client/src/game.ts';
import { InterpBuffer, PlaybackClock, SnapClock, StepSmoother } from '../../client/src/interp.ts';
import { Student } from '../../client/src/warden/student.ts';
import { RoomManager, type Conn } from '../../server/room.ts';
import { TICK_MS } from '../../shared/constants.ts';
import { F_CROUCH, type ServerMsg } from '../../shared/protocol.ts';
import { mulberry32 } from '../../shared/rng.ts';
import { inactiveGameCollaborators } from './game_fixture.ts';

afterEach(() => vi.unstubAllGlobals());

describe('remote teammate feet height', () => {
  it('keeps authoritative feet height through standing, crouch flag deltas and a crouched warp', () => {
    const ctx: any = new Proxy(function () {}, { get: (_, k) => k === 'measureText' ? () => ({ width: 1 }) : ctx, apply: () => ctx, set: () => true });
    vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) });
    const room = new RoomManager(mulberry32(3)).create();
    const got: ServerMsg[] = [];
    const conn: Conn = { id: 2, name: 'teammate', send: (m) => got.push(m), sendRaw: (s) => got.push(JSON.parse(s)) };
    room.add(conn, 0);
    const player = room.players.get(2)!;
    const feet = [...player.p] as [number, number, number];
    const snapFeet = feet.map((v) => Math.round(v * 100) / 100);
    const st = new Student(0x3366aa);
    const remote = { st, mesh: st.root, buf: new InterpBuffer(), clock: new PlaybackClock(100), sm: new StepSmoother(), f: 0, down: false, out: false };
    // Exercise the production message handler without constructing a renderer/campus scene.
    const game = Object.assign(Object.create(Game.prototype), {
      ...inactiveGameCollaborators(),
      myId: 1, snaps: 0, snapClock: new SnapClock(TICK_MS), peers: new Map(),
      remotes: new Map([[2, remote]]), warpEpochs: new Map(), mobs: { onSnap: vi.fn() },
    }) as Game;
    try {
      for (const [i, f] of [0, F_CROUCH, F_CROUCH, 0].entries()) {
        room.handle(conn, { t: 'input', seq: i + 1, p: [...feet], yaw: 0, pitch: 0, f }, (i + 1) * 50);
        room.step();
        const snap = got.filter((m): m is Extract<ServerMsg, { t: 'snap' }> => m.t === 'snap').at(-1)!;
        expect(snap.players[0].p).toEqual(snapFeet); // crouching changes eye/pose, not the collision body's feet
        if (i === 2) expect(snap.players[0].f).toBeUndefined(); // same flags use the protocol's unchanged delta
        game.onMsg(snap);
        const sample = remote.buf.at(remote.buf.lastT())!;
        expect(sample.y).toBe(snapFeet[1]);
        expect(remote.f).toBe(f);
        st.root.position.set(sample.x, sample.y, sample.z);
        for (let k = 0; k < 60; k++) st.update(1 / 30, 0, !!f, false, 0, 3);
        st.root.updateMatrixWorld(true);
        // Sample the actual shoe sole, not just the root, to catch a second half-metre lowering in the render path.
        const sole = ['footL', 'footR'].map((n) => {
          const foot = st.warden.bones[n as 'footL' | 'footR'];
          return new THREE.Vector3(0, -0.093, 0.035).applyMatrix4(foot.matrixWorld).y;
        });
        expect(Math.min(...sole) - feet[1]).toBeGreaterThan(-0.1);
        expect(Math.max(...sole) - feet[1]).toBeLessThan(0.12);
      }
      remote.f = F_CROUCH;
      game.onMsg({ t: 'warp', id: 2, c: 1, p: [feet[0], feet[1] + 7.2, feet[2]], yaw: 0 });
      expect(remote.mesh.position.y).toBe(feet[1] + 7.2);
    } finally { st.dispose(); }
  });
});
