/** 平面图 (client/src/map.ts): the level's rooms in world metres, the room someone stands in, north-up canvas mapping. */
import { describe, expect, test } from 'vitest';
import { CAMPUS } from '../../client/src/campus/world/campus.ts';
import { drawMap, headingOnMap, levelMap, mapFit, mapSize, roomAt, tickable } from '../../client/src/map.ts';
import { LEVELS } from '../../shared/level.ts';

const planOf = (i: number) => levelMap(LEVELS[i], CAMPUS.buildings.find((b) => b.id === LEVELS[i].building)!);

describe('levelMap', () => {
  test.each([0, 1])('L%i: every room lies in the area, corridors and a stairwell are drawn', (i) => {
    const m = planOf(i), a = LEVELS[i].area;
    expect(m.rooms.length).toBeGreaterThan(5);
    for (const r of m.rooms) {
      expect(r.x0).toBeGreaterThanOrEqual(a.x0);
      expect(r.x1).toBeLessThanOrEqual(a.x1);
      expect(r.z0).toBeGreaterThanOrEqual(a.z0);
      expect(r.z1).toBeLessThanOrEqual(a.z1);
    }
    expect(m.rooms.some((r) => r.kind === 'corridor')).toBe(true);
    expect(m.rooms.some((r) => r.kind === 'stairs')).toBe(true);
  });

  test('L1: the exit is in the 西南角 stairwell, every stair-key spot in a room that can be ticked, the spawns in a corridor', () => {
    const m = planOf(0), def = LEVELS[0];
    const at = (x: number, z: number) => m.rooms.find((r) => x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1);
    expect(at(def.exit.x, def.exit.z)?.kind).toBe('stairs');
    for (const s of def.items[0].spots) {
      const i = roomAt(m, s.x, s.z);
      expect(i, s.label).toBeGreaterThanOrEqual(0);
      expect(m.rooms[i].kind).toBe('classroom');
    }
    for (const p of def.spawns) {
      expect(roomAt(m, p.x, p.z)).toBe(-1);
      expect(at(p.x, p.z)?.kind).toBe('corridor');
    }
  });

  test('L2: the fuse box hangs in the corridor, the fuse spots are in classrooms', () => {
    const m = planOf(1), def = LEVELS[1], fb = def.blackout!.fuseBox;
    const nearCorridor = m.rooms.some((r) => r.kind === 'corridor' && fb.x > r.x0 && fb.x < r.x1 && fb.z > r.z0 - 0.3 && fb.z < r.z1 + 0.3);
    expect(nearCorridor).toBe(true);
    for (const s of def.items.find((it) => it.kind === 'fuse')!.spots) expect(m.rooms[roomAt(m, s.x, s.z)]?.kind, s.label).toBe('classroom');
  });

  test('roomAt skips corridors and stairs', () => {
    const m = planOf(0);
    for (const [i, r] of m.rooms.entries()) {
      const c = roomAt(m, (r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2);
      expect(c).toBe(tickable(r) ? i : -1);
    }
  });
});

describe('canvas mapping', () => {
  const area = LEVELS[0].area;
  test('north up, east right, the area inside the pad', () => {
    const f = mapFit(area, 500, 360, 14);
    expect(f.x(area.x0)).toBeGreaterThanOrEqual(14 - 1e-9);
    expect(f.x(area.x1)).toBeLessThanOrEqual(500 - 14 + 1e-9);
    expect(f.y(area.z1)).toBeGreaterThanOrEqual(14 - 1e-9);
    expect(f.y(area.z0)).toBeLessThanOrEqual(360 - 14 + 1e-9);
    expect(f.y(area.z1)).toBeLessThan(f.y(area.z0)); // north (+z) is up
    expect(f.x(area.x1)).toBeGreaterThan(f.x(area.x0));
  });
  test('mapSize keeps the aspect and the box', () => {
    for (const def of LEVELS) for (const [W, H] of [[1040, 504], [760, 257]]) {
      const z = mapSize(def.area, W, H, 14), a = def.area;
      expect(z.w).toBeLessThanOrEqual(W + 1);
      expect(z.h).toBeLessThanOrEqual(H + 1);
      expect((z.w - 28) / (z.h - 28)).toBeCloseTo((a.x1 - a.x0) / (a.z1 - a.z0), 1);
    }
  });
  test('headingOnMap points the way W walks (game.ts update: forward = (-sin yaw, -cos yaw))', () => {
    for (const yaw of [0, 0.7, Math.PI / 2, 2, Math.PI, -1.2, -Math.PI / 2]) {
      const fwd = { x: -Math.sin(yaw), z: -Math.cos(yaw) }, a = headingOnMap(yaw);
      // canvas: angle 0 = up (-y), clockwise; +x east is right, +z north is up
      expect(Math.sin(a)).toBeCloseTo(fwd.x, 9);
      expect(-Math.cos(a)).toBeCloseTo(-fwd.z, 9);
    }
    expect(Math.cos(headingOnMap(0))).toBeCloseTo(-1, 9); // yaw 0 looks south: down on the plan
  });
});

describe('exit label', () => {
  const bounds = (x: number, y: number, hw: number, hh: number) => ({ x0: x - hw, x1: x + hw, y0: y - hh, y1: y + hh });
  type Bounds = ReturnType<typeof bounds>;
  const overlaps = (a: Bounds, b: Bounds) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

  /** Record the actual draw calls, including chalk outlines; Chinese glyphs occupy one font-size em. */
  const tracePlan = (i: number, maxW: number, maxH: number, m = planOf(i)) => {
    const def = LEVELS[i], { w, h } = mapSize(m.area, maxW, maxH, 14);
    const crosses: Bounds[] = [], labels: { text: string; box: Bounds }[] = [], rings: { x: number; y: number; r: number }[] = [];
    let path: { x: number; y: number }[] = [];
    const ctx = {
      font: '', strokeStyle: '', lineWidth: 1,
      clearRect() {}, fillRect() {}, strokeRect() {}, setLineDash() {},
      beginPath() { path = []; },
      moveTo(x: number, y: number) { path.push({ x, y }); },
      lineTo(x: number, y: number) { path.push({ x, y }); },
      arc(x: number, y: number, r: number) { rings.push({ x, y, r }); },
      stroke() {
        if (ctx.strokeStyle !== '#ff5a4a' || path.length !== 4) return;
        const pad = ctx.lineWidth / 2;
        crosses.push({ x0: Math.min(...path.map((p) => p.x)) - pad, x1: Math.max(...path.map((p) => p.x)) + pad,
          y0: Math.min(...path.map((p) => p.y)) - pad, y1: Math.max(...path.map((p) => p.y)) + pad });
      },
      measureText(text: string) { return { width: Number(ctx.font.match(/(\d+)px/)![1]) * text.length }; },
      strokeText() {},
      fillText(text: string, x: number, y: number) {
        const fs = Number(ctx.font.match(/(\d+)px/)![1]), pad = ctx.lineWidth / 2;
        labels.push({ text, box: bounds(x, y, ctx.measureText(text).width / 2 + pad, fs / 2 + pad) });
      },
    };
    drawMap(ctx as unknown as CanvasRenderingContext2D, m, {
      mates: [], explored: new Set(), doors: [], barriers: def.barriers, exit: def.exit,
    }, w, h);
    return { crosses, labels, rings, def, f: mapFit(m.area, w, h, 14), w, h };
  };

  test.each([0, 1].flatMap((i) => [[1040, 504], [760, 257], [560, 170], [452, 257], [275, 247]]
    .map(([maxW, maxH]) => ({ i, level: i + 1, maxW, maxH }))))
  ('L$level: the exit label clears every blocked-way cross at $maxW × $maxH', ({ i, maxW, maxH }) => {
    const { crosses, labels, rings, def, f, w, h } = tracePlan(i, maxW, maxH);
    const exit = labels.find((label) => label.text === '出口')!;
    expect(exit).toBeDefined();
    expect(crosses).toHaveLength(def.barriers.length); // do not solve the collision by hiding a blocked way
    for (const cross of crosses) expect(overlaps(exit.box, cross), JSON.stringify({ label: exit.box, cross })).toBe(false);
    expect(exit.box.x0).toBeGreaterThanOrEqual(0);
    expect(exit.box.x1).toBeLessThanOrEqual(w);
    expect(exit.box.y0).toBeGreaterThanOrEqual(0);
    expect(exit.box.y1).toBeLessThanOrEqual(h);
    expect(rings).toEqual([{ x: f.x(def.exit.x), y: f.y(def.exit.z), r: Math.max(8, def.exit.r * f.s * 0.6) }]);
    // L1's landing opens north into its corridor stub; L2's west exit opens east along the corridor.
    if (i === 0) expect(exit.box.y1).toBeLessThan(rings[0].y - rings[0].r);
    else expect(exit.box.x0).toBeGreaterThan(rings[0].x + rings[0].r);
  });

  test('another storey’s closer corridor cannot pull the exit name away from its own passage', () => {
    const m = planOf(0), exit = LEVELS[0].exit, current = tracePlan(0, 275, 247);
    m.floors.push({ level: 2, y: 3.6, h: 3.6 });
    // A corridor directly above the stair landing would pull the label east instead of north.
    m.rooms.push({ id: 'upper-passage', name: '走廊', kind: 'corridor', level: 2, y: 3.6,
      x0: exit.x - 0.2, x1: exit.x + 2, z0: exit.z - 0.5, z1: exit.z + 0.5 });
    const stacked = tracePlan(0, 275, 247, m), label = stacked.labels.find((l) => l.text === '出口')!;
    expect(label.box).toEqual(current.labels.find((l) => l.text === '出口')!.box);
    expect(label.box.y1).toBeLessThan(stacked.rings[0].y - stacked.rings[0].r);
    expect(stacked.crosses).toHaveLength(LEVELS[0].barriers.length);
    for (const cross of stacked.crosses) expect(overlaps(label.box, cross)).toBe(false);
  });
});
