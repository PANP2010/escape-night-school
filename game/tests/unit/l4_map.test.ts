import { describe, expect, test, vi } from 'vitest';
import { CAMPUS } from '../../client/src/campus/world/campus.ts';
import { drawMap, levelMap, mapFloorAt, roomAt, type MapState } from '../../client/src/map.ts';
import { L1 } from '../../shared/levels/l1.ts';
import { L2 } from '../../shared/levels/l2.ts';
import { L4 } from '../../shared/levels/l4.ts';

const office = CAMPUS.buildings.find((b) => b.id === L4.building)!;
const plan = levelMap(L4, office);
const W = 1000, H = 500;

/** Records actual canvas calls, including the paint at the time of each call. No DOM or browser globals. */
function canvas() {
  const fills: { x: number; y: number; w: number; h: number; color: string }[] = [];
  const labels: { text: string; x: number; y: number; color: string }[] = [];
  const strokes: string[] = [];
  const mock = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '',
    clearRect: vi.fn(), strokeRect: vi.fn(), setLineDash: vi.fn(), beginPath: vi.fn(),
    arc: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(),
    save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(), fill: vi.fn(),
    stroke: vi.fn(() => { strokes.push(mock.strokeStyle); }),
    fillRect: vi.fn((x: number, y: number, w: number, h: number) => { fills.push({ x, y, w, h, color: mock.fillStyle }); }),
    fillText: vi.fn((text: string, x: number, y: number) => { labels.push({ text, x, y, color: mock.fillStyle }); }),
    strokeText: vi.fn(), measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
  };
  return { ctx: mock as unknown as CanvasRenderingContext2D, mock, fills, labels, strokes };
}

function state(y: number, overrides: Partial<MapState> = {}): MapState {
  return { floorY: y, mates: [], explored: new Set(), doors: [], barriers: L4.barriers, exit: L4.exit, ...overrides };
}

function render(y: number, overrides: Partial<MapState> = {}) {
  const c = canvas();
  drawMap(c.ctx, plan, state(y, overrides), W, H);
  return c;
}

describe('L4 storey-aware map and exploration', () => {
  test('keeps both floors with stable, distinct room indices and real building heights', () => {
    expect(plan.floors.map((f) => f.level)).toEqual([3, 4]);
    expect(plan.floors[0].y).toBeCloseTo(7.2);
    expect(plan.floors[1].y).toBeCloseTo(10.8);
    for (const floor of plan.floors) {
      const rooms = plan.rooms.filter((r) => r.level === floor.level);
      expect(rooms).toHaveLength(13);
      expect(rooms.every((r) => r.y === floor.y)).toBe(true);
      expect(rooms.some((r) => r.kind === 'corridor')).toBe(true);
      expect(rooms.some((r) => r.kind === 'stairs')).toBe(true);
      for (const r of rooms) {
        expect(r.x0).toBeGreaterThanOrEqual(L4.area.x0);
        expect(r.x1).toBeLessThanOrEqual(L4.area.x1);
        expect(r.z0).toBeGreaterThanOrEqual(L4.area.z0);
        expect(r.z1).toBeLessThanOrEqual(L4.area.z1);
      }
    }
  });

  test('identical XZ visits tick 团委 on 3F and 工会 on 4F, never the other floor', () => {
    const third = roomAt(plan, -26.75, 132.1, 7.2), fourth = roomAt(plan, -26.75, 132.1, 10.8);
    expect(third).toBeGreaterThanOrEqual(0);
    expect(fourth).toBeGreaterThanOrEqual(0);
    expect(fourth).not.toBe(third);
    expect(plan.rooms[third]).toMatchObject({ id: 'tuanwei', name: '团委', level: 3 });
    expect(plan.rooms[fourth]).toMatchObject({ id: 'gonghui', name: '工会', level: 4 });
    expect(roomAt(plan, -26.75, 132.1, 7.19)).toBe(third);
    expect(roomAt(plan, -26.75, 132.1, 10.79)).toBe(fourth);
    for (const y of [7.2, 10.8]) {
      expect(roomAt(plan, -20, 130, y)).toBe(-1);
      expect(roomAt(plan, -9, 134.3, y)).toBe(-1);
    }
  });

  test('even repeated room ids on different floors retain separate exploration indices', () => {
    const thirds = plan.rooms.find((r) => r.id === 'chucang' && r.level === 3)!;
    const x = (thirds.x0 + thirds.x1) / 2, z = (thirds.z0 + thirds.z1) / 2;
    const third = roomAt(plan, x, z, 7.2), fourth = roomAt(plan, x, z, 10.8);
    expect(plan.rooms[third].id).toBe('chucang');
    expect(plan.rooms[fourth].id).toBe('chucang');
    expect(third).not.toBe(fourth);
    expect(plan.rooms[third].level).toBe(3);
    expect(plan.rooms[fourth].level).toBe(4);
  });

  test('floor selection follows actual variable-height floor stacks and stair height', () => {
    const tall = levelMap(L4, { ...office, floors: [{ level: 1, h: 4 }, { level: 2, h: 5 }, { level: 3, h: 6 }, { level: 4, h: 3 }] });
    expect(tall.floors).toEqual([{ level: 3, y: 9, h: 6 }, { level: 4, y: 15, h: 3 }]);
    expect(mapFloorAt(tall, 9)?.level).toBe(3);
    expect(mapFloorAt(tall, 11.9)?.level).toBe(3);
    expect(mapFloorAt(tall, 12.1)?.level).toBe(4);
    expect(mapFloorAt(tall, 14.99)?.level).toBe(4);
    expect(mapFloorAt(tall)?.level).toBe(3);
  });

  test.each([
    { y: 7.2, own: ['历史组', '团委', '教研活动室'], other: ['工会', '接待室', '副校长室'] },
    { y: 10.8, own: ['工会', '接待室', '副校长室'], other: ['历史组', '团委', '教研活动室'] },
  ])('draws one floor at feet y=$y, with no stacked room labels', ({ y, own, other }) => {
    const c = render(y), labels = c.labels.map((l) => l.text);
    for (const name of own) expect(labels).toContain(name);
    for (const name of other) expect(labels).not.toContain(name);
    expect(c.mock.strokeRect).toHaveBeenCalledTimes(13);
    const roomLabels = c.labels.filter((l) => !l.text.startsWith('出口'));
    const positions = roomLabels.map((l) => `${l.x},${l.y}`);
    expect(new Set(positions).size).toBe(positions.length);
  });

  test('uses local feet height when floorY is omitted and supports a spectator floor without me', () => {
    const local = render(7.2, { floorY: undefined, me: { x: -20, y: 10.8, z: 130, yaw: 0 } });
    expect(local.labels.map((l) => l.text)).toContain('工会');
    expect(local.labels.map((l) => l.text)).not.toContain('团委');
    const spectator = render(10.8);
    expect(spectator.labels.map((l) => l.text)).toContain('工会');
    expect(spectator.labels.map((l) => l.text)).not.toContain('你');
  });

  test('exploration is floor-specific and persists after returning downstairs', () => {
    const third = roomAt(plan, -26.75, 132.1, 7.2), fourth = roomAt(plan, -26.75, 132.1, 10.8);
    const explored = new Set([third]);
    const upstairsUnseen = render(10.8, { explored });
    expect(upstairsUnseen.labels.filter((l) => l.text === '✓')).toHaveLength(0);
    expect(upstairsUnseen.fills.filter((f) => f.color === '#4fd08a24')).toHaveLength(0);
    explored.add(fourth);
    for (const y of [10.8, 7.2, 10.8]) {
      const c = render(y, { explored });
      expect(c.labels.filter((l) => l.text === '✓')).toHaveLength(1);
      expect(c.fills.filter((f) => f.color === '#4fd08a24')).toHaveLength(1);
    }
    expect([...explored]).toEqual([third, fourth]);
  });

  test('same-XZ door states are drawn only on their own floor', () => {
    const box = { x0: -25, x1: -24, z0: 131.2, z1: 131.4 };
    const doors = [{ ...box, y: 7.2, open: false, locked: true }, { ...box, y: 10.8, open: true, locked: false }];
    const third = render(7.2, { doors }), fourth = render(10.8, { doors });
    expect(third.fills.filter((f) => f.color === '#ff5a4a')).toHaveLength(1);
    expect(third.fills.filter((f) => f.color === '#0f1d17')).toHaveLength(0);
    expect(fourth.fills.filter((f) => f.color === '#ff5a4a')).toHaveLength(0);
    expect(fourth.fills.filter((f) => f.color === '#0f1d17')).toHaveLength(1);
    expect(fourth.fills.filter((f) => f.color === '#4fd08a88')).toHaveLength(1);
  });

  test('the lower-flight barrier and teammate markers do not leak upstairs/downstairs', () => {
    const mates = [
      { x: -20, y: 7.2, z: 130, name: '三楼队友', color: '#123456', down: false },
      { x: -20, y: 10.8, z: 130, name: '四楼队友', color: '#abcdef', down: true },
    ];
    const third = render(7.2, { mates }), fourth = render(10.8, { mates });
    expect(third.strokes.filter((color) => color === '#ff5a4a')).toHaveLength(1);
    expect(fourth.strokes.filter((color) => color === '#ff5a4a')).toHaveLength(1); // only the visible downed teammate
    expect(third.labels.map((l) => l.text)).toContain('三楼队友');
    expect(third.labels.map((l) => l.text)).not.toContain('四楼队友（倒地）');
    expect(fourth.labels.map((l) => l.text)).toContain('四楼队友（倒地）');
    expect(fourth.labels.map((l) => l.text)).not.toContain('三楼队友');
    expect(render(10.8).strokes.filter((color) => color === '#ff5a4a')).toHaveLength(0);
  });

  test('the exit ring exists only on 3F; 4F explicitly says which floor to return to', () => {
    const third = render(7.2), fourth = render(10.8);
    expect(third.labels.map((l) => l.text)).toContain('出口');
    expect(third.labels.map((l) => l.text)).not.toContain('出口在三楼');
    expect(third.mock.arc).toHaveBeenCalledTimes(1);
    expect(third.mock.setLineDash).toHaveBeenCalledWith([5, 4]);
    expect(fourth.labels.map((l) => l.text)).not.toContain('出口');
    expect(fourth.labels.map((l) => l.text)).toContain('出口在三楼');
    expect(fourth.mock.arc).not.toHaveBeenCalled();
    expect(fourth.mock.setLineDash).not.toHaveBeenCalledWith([5, 4]);
    expect(fourth.labels.find((l) => l.text === '出口在三楼')).toMatchObject({ x: W / 2, y: 7, color: '#c9c4b4' });
  });
});

describe('single-storey map compatibility', () => {
  test.each([L1, L2])('$name keeps all rooms and old height-free map state', (def) => {
    const m = levelMap(def, CAMPUS.buildings.find((b) => b.id === def.building)!);
    const c = canvas();
    drawMap(c.ctx, m, {
      mates: [], explored: new Set(),
      doors: [{ x0: def.area.x0, x1: def.area.x0 + 1, z0: def.area.z0, z1: def.area.z0 + 0.2, open: false, locked: true }],
      barriers: [], exit: { x: def.exit.x, z: def.exit.z, r: def.exit.r },
      fuseBox: def.blackout ? { x: def.blackout.fuseBox.x, z: def.blackout.fuseBox.z } : undefined,
    }, W, H);
    expect(m.floors).toHaveLength(1);
    expect(c.mock.strokeRect).toHaveBeenCalledTimes(m.rooms.length);
    expect(c.labels.map((l) => l.text)).toContain('出口');
    expect(c.labels.map((l) => l.text).includes('配电箱')).toBe(!!def.blackout);
    expect(c.fills.filter((f) => f.color === '#ff5a4a')).toHaveLength(def.blackout ? 2 : 1);
    for (const [i, r] of m.rooms.entries()) {
      expect(roomAt(m, (r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2)).toBe(r.kind === 'corridor' || r.kind === 'stairs' ? -1 : i);
    }
  });
});
