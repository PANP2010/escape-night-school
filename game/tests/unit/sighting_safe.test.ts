import { describe, expect, it } from 'vitest';
import { SIGHTING, selectSighting, sightingVisible, type SightingPoint, type SightingViewer } from '../../server/ai/sighting.ts';
import { box, CollisionWorld } from '../../shared/campus/collision.ts';
import { lineOfSight, NavGraph } from '../../shared/campus/nav.ts';
import { F_HIDE, type Vec3 } from '../../shared/protocol.ts';

/** A corridor opening: the teacher crosses behind two walls and is visible only through their middle gap. */
const crossing: SightingPoint = {
  id: 'test-crossing', level: 1, kind: 'crossing', path: [[-12, 0, -8], [-12, 0, 0], [-12, 0, 8]], speed: 2,
};
const viewer = (id = 1, p: Vec3 = [0, 0, 0], yaw = Math.PI / 2): SightingViewer => ({ id, p, yaw, pitch: 0, f: 0 });

function setup(players: SightingViewer[] = [viewer()]) {
  const graph = new NavGraph();
  graph.chain([[12, 0, 0], [12, 0, -12], [-12, 0, -12], [-12, 0, -8]].map(p => ({ x: p[0], y: p[1], z: p[2] })));
  graph.chain(crossing.path.map(p => ({ x: p[0], y: p[1], z: p[2] })));
  const world = new CollisionWorld([box(-6, -6, 0.3, 8, 3), box(-6, 6, 0.3, 8, 3)]);
  const los = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => lineOfSight(world, a, b);
  const env = { graph, los, walkable: (_a: Vec3, _b: Vec3) => true };
  const ctx = {
    level: 1, elapsed: 30, players,
    warden: { p: [12, 0, 0] as Vec3, state: 'patrol' as const, retreating: false },
    ready: true, scareReady: true, protected: false, controlBusy: false,
  };
  return { env, ctx, pick: () => selectSighting(env, ctx, [crossing]) };
}

describe('scripted sighting destination safety', () => {
  it('accepts a reachable hidden-to-visible-to-hidden crossing at a safe distance', () => {
    const { env, ctx, pick } = setup();
    expect(sightingVisible(ctx.players[0], crossing.path[0], env.los)).toBe(false);
    expect(sightingVisible(ctx.players[0], crossing.path[1], env.los)).toBe(true);
    expect(sightingVisible(ctx.players[0], crossing.path[2], env.los)).toBe(false);
    expect(pick()?.id).toBe(crossing.id);
  });

  it('rejects a destination off screen for player one when player two can see it', () => {
    const away = viewer(1, [-24, 0, 8], Math.PI), witness = viewer(3);
    const withoutWatchingTeammate = setup([away, witness]);
    expect(withoutWatchingTeammate.pick()?.id).toBe(crossing.id);
    const r = setup([away, viewer(2, [-24, 0, -8], -Math.PI / 2), witness]);
    expect(sightingVisible(away, crossing.path[0], () => true)).toBe(false); // genuinely outside the frustum
    expect(sightingVisible(r.ctx.players[0], crossing.path[0], r.env.los)).toBe(false);
    expect(sightingVisible(r.ctx.players[1], crossing.path[0], r.env.los)).toBe(true);
    expect(r.pick()).toBeUndefined();
  });

  it('also rejects a visible endpoint even when that observer is hiding or cannot be the chosen witness', () => {
    const spectator = { ...viewer(2, [-24, 0, -8], -Math.PI / 2), f: F_HIDE, canWitness: false };
    const r = setup([viewer(), spectator]);
    expect(sightingVisible(spectator, crossing.path[0], r.env.los)).toBe(true);
    expect(r.pick()).toBeUndefined();
  });

  it('never makes the source disappear while any teammate sees him', () => {
    const r = setup([viewer(), viewer(2, [24, 0, 0])]);
    expect(sightingVisible(r.ctx.players[1], r.ctx.warden.p, r.env.los)).toBe(true);
    expect(r.pick()).toBeUndefined();
  });

  it('keeps a distant visible source in place beyond the former 45 m visibility cutoff', () => {
    const r = setup([viewer(), viewer(2, [60, 0, 0])]);
    expect(sightingVisible(r.ctx.players[1], r.ctx.warden.p, r.env.los)).toBe(true);
    expect(r.pick()).toBeUndefined();
  });

  it('checks the whole route for close players, including its visible midpoint', () => {
    const r = setup([viewer(), viewer(2, [-8, 0, 0], -Math.PI / 2)]);
    expect(Math.hypot(crossing.path[1][0] - r.ctx.players[1].p[0], crossing.path[1][2] - r.ctx.players[1].p[2])).toBeLessThan(SIGHTING.minDistance);
    expect(r.pick()).toBeUndefined();
  });

  it('rejects a route through solid geometry even when the eye ray has a clear view', () => {
    const r = setup();
    r.env.walkable = (a, b) => !(a[0] === -12 && b[0] === -12 && a[2] !== b[2]);
    expect(sightingVisible(r.ctx.players[0], crossing.path[1], r.env.los)).toBe(true);
    expect(r.pick()).toBeUndefined();
  });

  it('does not count a fully occluded route as a sighting', () => {
    const r = setup();
    r.env.los = () => false;
    expect(r.pick()).toBeUndefined();
  });

  it('keeps the wide relocation veto without counting a crossing outside the camera as witnessed', () => {
    const r = setup([viewer(1, [0, 0, 0], Math.PI / 12)]);
    expect(sightingVisible(r.ctx.players[0], crossing.path[1], r.env.los)).toBe(true);
    expect(r.pick()).toBeUndefined();
  });

  it('requires a witness inside the vertical camera bounds', () => {
    const r = setup([{ ...viewer(), pitch: Math.PI / 4 }]);
    expect(sightingVisible(r.ctx.players[0], crossing.path[1], r.env.los)).toBe(true);
    expect(r.pick()).toBeUndefined();
  });

  it('does not count a distant figure too small for the opening reveal', () => {
    const r = setup([viewer(1, [9, 0, 0])]);
    expect(sightingVisible(r.ctx.players[0], crossing.path[1], r.env.los)).toBe(true);
    expect(r.pick()).toBeUndefined();
  });

  it('vetoes a figure visible through a slit between the former knee and eye samples', () => {
    const world = new CollisionWorld([
      { minX: -6.15, maxX: -5.85, minZ: -20, maxZ: 20, minY: 0, maxY: 1.34 },
      { minX: -6.15, maxX: -5.85, minZ: -20, maxZ: 20, minY: 1.36, maxY: 3.5 },
    ]);
    expect(sightingVisible(viewer(), [-12, 0, 0], (a, b) => lineOfSight(world, a, b))).toBe(true);
  });

  it('rejects cross-storey sightings and never snaps them to a node on the players floor', () => {
    const r = setup();
    const upstairs: SightingPoint = { ...crossing, path: crossing.path.map(p => [p[0], 3.6, p[2]] as Vec3) };
    expect(selectSighting(r.env, r.ctx, [upstairs])).toBeUndefined();
  });

  it('requires an active witness rather than using a protected observer as the target', () => {
    const r = setup([{ ...viewer(), canWitness: false }]);
    expect(r.pick()).toBeUndefined();
  });
});

describe('scripted sighting scheduling controls', () => {
  for (const [field, value] of [['ready', false], ['scareReady', false], ['protected', true], ['controlBusy', true]] as const) {
    it(`defers when ${field}=${value}, retaining the ordinary teacher`, () => {
      const r = setup();
      r.ctx[field] = value;
      expect(r.pick()).toBeUndefined();
    });
  }
  it('waits until the opening protection has passed and keeps at least a 45 s scare cooldown', () => {
    expect(SIGHTING.cooldown).toBeGreaterThanOrEqual(45);
    const r = setup();
    r.ctx.elapsed = 0;
    expect(r.pick()).toBeUndefined();
  });
  for (const state of ['chase', 'catch'] as const) {
    it(`does not interrupt ${state}`, () => {
      const r = setup();
      expect(selectSighting(r.env, { ...r.ctx, warden: { ...r.ctx.warden, state } }, [crossing])).toBeUndefined();
    });
  }
  it('does not interrupt post-catch retreat', () => {
    const r = setup();
    r.ctx.warden.retreating = true;
    expect(r.pick()).toBeUndefined();
  });
  it('leaves L4 broadcast control and L8 final pursuit in charge', () => {
    const r = setup();
    for (const level of [4, 8]) {
      const candidate = { ...crossing, level };
      expect(selectSighting(r.env, { ...r.ctx, level }, [candidate])).toBeUndefined();
    }
  });
});
