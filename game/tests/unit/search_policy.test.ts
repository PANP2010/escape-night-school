import { describe, expect, it } from 'vitest';
import { SEARCH_ANCHOR_LIMIT, SearchNavGraph, SearchPolicy, difficultyForPlayers } from '../../server/ai/searchPolicy.ts';
import type { WardenTarget } from '../../server/ai/warden.ts';
import { NavGraph } from '../../shared/campus/nav.ts';
import { F_HIDE, type Vec3 } from '../../shared/protocol.ts';
import { SPEED } from '../../shared/constants.ts';
import { evidenceRoute } from '../../server/ai/evidenceRoute.ts';
import { CollisionWorld, overlaps } from '../../shared/campus/collision.ts';
import { NAV_CAPSULE } from '../../shared/campus/nav.ts';

const target = (id: number, p: Vec3, f = 0): WardenTarget => ({ id, p, yaw: 0, pitch: 0, f });
function graphAt(y = 0) {
  const graph = new NavGraph();
  graph.chain(Array.from({ length: 31 }, (_, i) => ({ x: i - 10, y, z: 0 })));
  return graph;
}
function moving(policy: SearchPolicy, id = 1, y = 0) {
  policy.observe(0, [target(id, [0, y, 0])], () => true);
  policy.observe(.2, [target(id, [1, y, 0])], () => true);
}
function witness(policy: SearchPolicy, id = 1, y = 0) {
  moving(policy, id, y);
  expect(policy.witnessHide(id, [1.4, y, 0], [1, y, 0], .21)).toBe(true);
}
function inspect(policy: SearchPolicy, from: Vec3, seconds: number, options: { now?: number; eligible?: ReadonlySet<number>; clear?: () => boolean } = {}) {
  const caught: number[] = [];
  const dt = .05, start = options.now ?? .3;
  for (let i = 0; i < Math.ceil(seconds / dt); i++) caught.push(...policy.check(start + i * dt, dt, from, options.eligible ?? new Set([1]), options.clear ?? (() => true)));
  return caught;
}

describe('pure search policy', () => {
  it('scales hearing and search pressure with active player count while keeping a bounded single-player baseline', () => {
    const one = difficultyForPlayers(1), two = difficultyForPlayers(2), four = difficultyForPlayers(4);
    for (const d of [one, two, four]) {
      expect(d.hearingMultiplier).toBeGreaterThanOrEqual(1);
      expect(d.hearingMultiplier).toBeLessThanOrEqual(2);
      expect(d.predictionSeconds).toBeGreaterThan(0);
      expect(d.searchSeconds).toBeGreaterThan(d.predictionSeconds);
      expect(d.checkSeconds).toBeGreaterThanOrEqual(.3);
    }
    expect(two.hearingMultiplier).toBeGreaterThanOrEqual(one.hearingMultiplier);
    expect(four.hearingMultiplier).toBeGreaterThan(one.hearingMultiplier);
    expect(four.searchSeconds).toBeGreaterThanOrEqual(one.searchSeconds);
    const policy = new SearchPolicy();
    policy.setPlayerCount(4);
    expect(policy.difficulty).toEqual(four);
    policy.setPlayerCount(1);
    expect(policy.difficulty).toEqual(one);
  });

  it('predicts ahead from two genuine sight samples and ignores later positions behind the wall', () => {
    const policy = new SearchPolicy(), graph = graphAt();
    moving(policy);
    const predicted = policy.predict(1, .4, graph, [-5, 0, 0]);
    expect(predicted).not.toBeNull();
    expect(predicted![0]).toBeGreaterThan(1);
    expect(predicted![1]).toBe(0);
    policy.observe(.4, [target(1, [-8, 0, 10])], () => false);
    expect(policy.predict(1, .4, graph, [-5, 0, 0])).toEqual(predicted);
  });

  it('never invents velocity from hidden movement or a single sighting', () => {
    const policy = new SearchPolicy(), graph = graphAt();
    policy.observe(1, [target(1, [1, 0, 0])], () => true);
    const first = policy.predict(1, 1.1, graph, [-5, 0, 0]);
    policy.observe(1.2, [target(1, [15, 0, 0], F_HIDE)], () => false);
    expect(policy.predict(1, 1.1, graph, [-5, 0, 0])).toEqual(first);
    expect(first === null || Math.abs(first[0] - 1) <= 1).toBe(true);
  });

  it('restricts predictions to allowed reachable nodes on the remembered floor', () => {
    const policy = new SearchPolicy(), graph = graphAt(3.6);
    graph.chain([{ x: 5, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }]);
    moving(policy, 1, 3.6);
    const p = policy.predict(1, .3, graph, [-5, 3.6, 0], point => point[0] <= 3 && point[1] > 3);
    expect(p).not.toBeNull();
    expect(p![0]).toBeGreaterThan(1);
    expect(p![0]).toBeLessThanOrEqual(3);
    expect(p![1]).toBeCloseTo(3.6);
    expect(policy.predict(1, .3, graph, [-5, 3.6, 0], () => false)).toBeNull();
  });

  it('cannot turn a teleport or loop warp into an unlimited-speed interception', () => {
    const policy = new SearchPolicy(), graph = new NavGraph();
    graph.chain(Array.from({ length: 101 }, (_, x) => ({ x, y: 0, z: 0 })));
    policy.observe(0, [target(1, [0, 0, 0])], () => true);
    policy.observe(.05, [target(1, [36, 0, 0])], () => true);
    const p = policy.predict(1, .1, graph, [30, 0, 0]);
    if (p) expect(Math.abs(p[0] - 36)).toBeLessThanOrEqual(SPEED.run * 1.3 * policy.difficulty.predictionSeconds + 1);
  });

  it('forgets stale LOS and never learns an unwitnessed or stale hiding place', () => {
    const policy = new SearchPolicy(), graph = graphAt();
    expect(policy.witnessHide(1, [1.4, 0, 0], [1, 0, 0], 0)).toBe(false);
    moving(policy);
    const stale = policy.difficulty.searchSeconds + 2;
    expect(policy.predict(1, stale, graph, [-5, 0, 0])).toBeNull();
    expect(policy.witnessHide(1, [1.4, 0, 0], [1, 0, 0], stale)).toBe(false);
    expect(inspect(policy, [1, 0, 1], 2, { now: stale })).toEqual([]);
  });

  it('requires continuous nearby clear inspection before pulling a witnessed player out, once only', () => {
    const policy = new SearchPolicy();
    witness(policy);
    expect(inspect(policy, [1, 0, 1], policy.difficulty.checkSeconds - .1)).toEqual([]);
    const caught = inspect(policy, [1, 0, 1], .3, { now: .3 + policy.difficulty.checkSeconds - .1 });
    expect(caught).toEqual([1]);
    expect(inspect(policy, [1, 0, 1], 2, { now: 2 })).toEqual([]);
  });

  it('cannot inspect through a wall, a closed door, from another floor or from afar', () => {
    for (const [from, clear] of [
      [[1, 0, 1], false], [[1, 3.6, 0], true], [[10, 0, 0], true],
    ] as const) {
      const policy = new SearchPolicy();
      witness(policy);
      expect(inspect(policy, [...from], policy.difficulty.checkSeconds + .3, { clear: () => clear })).toEqual([]);
      expect(inspect(policy, [1, 0, 1], .1, { now: 2 })).toEqual([]);
    }
  });

  it('does not accumulate inspection time while the target is protected or absent', () => {
    const policy = new SearchPolicy();
    witness(policy);
    expect(inspect(policy, [1, 0, 1], policy.difficulty.checkSeconds + .3, { eligible: new Set() })).toEqual([]);
    expect(inspect(policy, [1, 0, 1], .1, { now: 2 })).toEqual([]);
  });

  it('forget and reset erase prediction, witness and partial-check memory', () => {
    for (const mode of ['forget', 'reset'] as const) {
      const policy = new SearchPolicy();
      witness(policy);
      inspect(policy, [1, 0, 1], .1);
      if (mode === 'forget') policy.forget(1); else policy.reset();
      expect(policy.predict(1, .5, graphAt(), [-5, 0, 0])).toBeNull();
      expect(policy.witnessHide(1, [1.4, 0, 0], [1, 0, 0], .6)).toBe(false);
      expect(inspect(policy, [1, 0, 1], 2, { now: .7 })).toEqual([]);
    }
  });
});

describe('room-local search navigation', () => {
  it('caps evidence anchors without changing an in-flight route, including after door refreshes', () => {
    const source = graphAt(), original = structuredClone({ nodes: source.nodes, adj: source.adj });
    const graph = new SearchNavGraph(source, () => true);
    const ids = Array.from({ length: SEARCH_ANCHOR_LIMIT }, (_, i) => graph.anchor([i * .1, 0, 1]));
    const route = graph.astar(ids[0], ids.at(-1)!);
    expect(route).not.toBeNull();
    const points = route!.map(i => ({ ...graph.nodes[i] }));
    for (let i = 0; i < 200; i++) expect(graph.anchor([100 + i, 0, 1])).toBe(-1);
    graph.refresh();
    expect(graph.anchorCount).toBe(SEARCH_ANCHOR_LIMIT);
    expect(graph.nodes).toHaveLength(source.nodes.length + SEARCH_ANCHOR_LIMIT);
    expect(route!.map(i => graph.nodes[i])).toEqual(points);
    expect(graph.astar(ids[0], ids.at(-1)!)).not.toBeNull();
    expect({ nodes: source.nodes, adj: source.adj }).toEqual(original);
  });

  it('filters locked edges locally and reconnects an unlocked door without mutating the shared graph or node ids', () => {
    const source = new NavGraph();
    source.chain([-2, -1, 1, 2].map(x => ({ x, y: 0, z: 0 })));
    const original = structuredClone({ nodes: source.nodes, adj: source.adj });
    let unlocked = false;
    const graph = new SearchNavGraph(source, (a, b) => unlocked || a[0] * b[0] > 0);
    expect(graph.astar(0, 3)).toBeNull();
    expect(source.astar(0, 3)).toEqual([0, 1, 2, 3]);
    unlocked = true;
    graph.refresh();
    expect(graph.astar(0, 3)).toEqual([0, 1, 2, 3]);
    expect(graph.nodes).toEqual(original.nodes);
    expect({ nodes: source.nodes, adj: source.adj }).toEqual(original);
  });

  it('anchors a recovery at the exact authoritative location and links only physically reachable nodes across refreshes', () => {
    const source = new NavGraph();
    source.chain([-2, -1, 1, 2].map(x => ({ x, y: 0, z: 0 })));
    let unlocked = false;
    const clear = (a: Vec3, b: Vec3) => unlocked || a[0] * b[0] > 0;
    const graph = new SearchNavGraph(source, clear);
    const p: Vec3 = [-1.3, .03, .4], id = graph.anchor(p);
    expect(graph.nodes[id]).toMatchObject({ x: p[0], y: p[1], z: p[2] });
    expect(graph.adj[id]).not.toContain(2);
    expect(graph.astar(id, 3)).toBeNull();
    expect(graph.anchor(p)).toBe(id);
    unlocked = true;
    graph.refresh();
    expect(graph.nodes[id]).toMatchObject({ x: p[0], y: p[1], z: p[2] });
    expect(graph.astar(id, 3)).not.toBeNull();
    expect(source.nodes).toHaveLength(4);
    expect(source.adj).toEqual([[1], [0, 2], [1, 3], [2]]);
  });

  it('chooses a capsule-reachable start node while keeping ordinary hidden-goal nearest queries geometric', () => {
    const source = new NavGraph();
    source.chain([{ x: -3, y: 0, z: 0 }, { x: .2, y: 0, z: 0 }]);
    const from: Vec3 = [-.1, 0, 0];
    const graph = new SearchNavGraph(source, () => true, () => from, (a, b) => a[0] * b[0] > 0);
    expect(graph.nearest(...from)).toBe(0);
    expect(graph.nearest(.2, 0, 0)).toBe(1);
    const isolated = new SearchNavGraph(source, () => false, () => from, () => false);
    const at = isolated.nearest(...from);
    expect(isolated.nodes[at]).toMatchObject({ x: from[0], y: from[1], z: from[2] });
    expect(isolated.adj[at]).toEqual([]);
  });
});

describe('local routes to remembered evidence', () => {
  const clearIn = (world: CollisionWorld) => (a: Vec3, b: Vec3) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(...a.map((v, i) => v - b[i])) / .05));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      if (overlaps(world, { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t,
        z: a[2] + (b[2] - a[2]) * t, vy: 0, grounded: true }, NAV_CAPSULE)) return false;
    }
    return true;
  };

  it('walks around a real capsule obstacle while preserving the exact evidence endpoints', () => {
    const world = new CollisionWorld([{ minX: -.15, maxX: .15, minY: 0, maxY: 3, minZ: -.6, maxZ: .6 }]);
    const from: Vec3 = [-1.5, 0, 0], goal: Vec3 = [1.5, 0, 0], clear = clearIn(world);
    expect(clear(from, goal), 'the full capsule must be unable to take the straight chord').toBe(false);
    const path = evidenceRoute(from, goal, clear, p => Math.abs(p[0]) <= 3 && Math.abs(p[2]) <= 1.8);
    expect(path).not.toBeNull();
    expect(path![0]).toEqual(from);
    expect(path!.at(-1)).toEqual(goal);
    expect(path!.length, 'a blocked straight chord requires at least one actual turn').toBeGreaterThan(2);
    expect(Math.max(...path!.map(p => Math.abs(p[2])))).toBeGreaterThanOrEqual(.6 + NAV_CAPSULE.radius - 1e-7);
    for (let i = 1; i < path!.length; i++) expect(clear(path![i - 1], path![i]), 'every simplified leg must clear the full capsule').toBe(true);
  });

  it('cannot cross a closed barrier and terminates its local search within a bounded number of collision queries', () => {
    const world = new CollisionWorld([{ minX: -.15, maxX: .15, minY: 0, maxY: 3, minZ: -100, maxZ: 100 }]);
    const clear = clearIn(world);
    let queries = 0;
    const path = evidenceRoute([-1.5, 0, 0], [1.5, 0, 0], (a, b) => { queries++; return clear(a, b); }, () => true);
    expect(path).toBeNull();
    expect(queries).toBeGreaterThan(0);
    expect(queries).toBeLessThan(12_000);
  });

  it('rejects another floor or an out-of-region endpoint before attempting any movement', () => {
    let queries = 0;
    const clear = () => { queries++; return true; };
    expect(evidenceRoute([0, 0, 0], [1, 3.6, 0], clear, () => true)).toBeNull();
    expect(evidenceRoute([0, 0, 0], [1, 0, 0], clear, p => p[0] < .5)).toBeNull();
    expect(queries).toBe(0);
  });
});
