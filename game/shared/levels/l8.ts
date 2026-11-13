import type { AreaDef, BarrierDef, LevelDef } from './def.ts';

/** A tight union around the authored, walkable route from 教务处 via the west side of the flag platform to 校门. */
const REGIONS: AreaDef[] = [
  { x0: -35, x1: -5, z0: 122, z1: 138, y0: -0.5, y1: 3.1 }, // OFF 1F: 教务处 + connecting middle corridor
  { x0: -21.5, x1: -12.5, z0: 115.8, z1: 123, y0: -0.5, y1: 1.2 }, // south entrance → north road
  { x0: -16, x1: -12, z0: 88, z1: 117, y0: -0.5, y1: 1.2 },
  { x0: -15, x1: -9, z0: 87, z1: 89.5, y0: -0.5, y1: 1.2 },
  { x0: -11.5, x1: -8.5, z0: 75, z1: 89.5, y0: -0.5, y1: 1.2 },
  { x0: -10.5, x1: -1.5, z0: 75, z1: 78, y0: -0.5, y1: 1.2 },
  { x0: -3, x1: -1, z0: 59, z1: 77, y0: -0.5, y1: 1.2 },
  { x0: -7.5, x1: -1.5, z0: 67, z1: 69.5, y0: -0.5, y1: 1.2 },
  // Leave room for a running capsule to turn around the platform. A one-metre
  // strip passed exact centre-line checks but trapped ordinary turns at its inner grate corner.
  { x0: -7.5, x1: -4.5, z0: 59, z1: 69.5, y0: -0.5, y1: 1.2 },
  { x0: -7.5, x1: -1.5, z0: 59, z1: 61.5, y0: -0.5, y1: 1.2 },
  { x0: -3, x1: -1, z0: -16, z1: 61, y0: -0.5, y1: 1.2 }, // through the main gate to the safe side
];

/** Physical grates only on the outer edge of the union; overlapping route sections remain open. */
function regionFences(regions: AreaDef[]): BarrierDef[] {
  const fences: BarrierDef[] = [];
  const edge = (axis: 'x' | 'z', fixed: number, from: number, to: number, face: BarrierDef['face'], own: AreaDef) => {
    const cuts = regions.filter(b => b !== own && (axis === 'x'
      ? b.x0 < fixed && b.x1 > fixed && b.z1 > from && b.z0 < to
      : b.z0 < fixed && b.z1 > fixed && b.x1 > from && b.x0 < to))
      .map(b => axis === 'x' ? [Math.max(from, b.z0), Math.min(to, b.z1)] : [Math.max(from, b.x0), Math.min(to, b.x1)])
      .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
    let at = from;
    const put = (a: number, b: number) => {
      if (b - a < 0.5) return;
      fences.push({ kind: 'grate', x0: axis === 'x' ? fixed - 0.1 : a, x1: axis === 'x' ? fixed + 0.1 : b,
        z0: axis === 'x' ? a : fixed - 0.1, z1: axis === 'x' ? b : fixed + 0.1,
        y: 0, h: 1.5, face, say: '围栏封住了这条岔路' });
    };
    for (const [a, b] of cuts) { if (a > at) put(at, a); at = Math.max(at, b); }
    if (at < to) put(at, to);
  };
  for (const r of regions) {
    edge('x', r.x0, r.z0, r.z1, 'x+', r);
    edge('x', r.x1, r.z0, r.z1, 'x-', r);
    edge('z', r.z0, r.x0, r.x1, 'z+', r);
    edge('z', r.z1, r.x0, r.x1, 'z-', r);
  }
  return fences;
}

/** 第 8 关「教务处·点名册」：划名后从旧办公楼沿校园南轴冲出校门。 */
export const L8: LevelDef = {
  name: '教务处·点名册',
  building: 'OFF',
  floors: [1],
  area: { x0: -35, x1: -1, z0: -16, z1: 138, y0: -0.5, y1: 3.1 },
  regions: REGIONS,
  spawns: [-27, -26, -25, -24].map(x => ({ x, z: 130 })),
  exit: { x: -2, z: -11, y: 0, r: 1.7 },
  exitName: '校门外安全区',
  lockedDoors: [],
  finale: {
    rollcall: { x: -25.18, z: 126.31, y: 0 }, // clear space on the second desk, away from the CRT, paperwork and rotated cup
    // Behind the office door, at the west end of the corridor: a real pursuit, never a head-on roadblock.
    chaseSpawn: { x: -33, z: 130, y: 0 },
    gate: { x: -2, z: -8.5, y: 0 }, // an open-gate waypoint outside the wall; the exit zone is farther down the path
    route: [
      { x: -23.55, z: 127.95, y: 0 }, // 教务处房门
      { x: -23.55, z: 129.15, y: 0 },
      { x: -21.95, z: 129.15, y: 0 },
      { x: -19.95, z: 124.05, y: 0 }, // OFF 正门
      { x: -20, z: 122, y: 0 },
      { x: -14, z: 116.3, y: 0 }, // 北横路西侧
      { x: -14, z: 88.3, y: 0 },
      { x: -10, z: 88.3, y: 0 },
      { x: -10, z: 76.3, y: 0 },
      { x: -2, z: 76.3, y: 0 }, // 旗台东/西侧铺装拐点
      { x: -2, z: 68.3, y: 0 },
      { x: -6, z: 68.3, y: 0 },
      { x: -6, z: 60.3, y: 0 },
      { x: -2, z: 60.3, y: 0 },
      { x: -2, z: -3.7, y: 0 }, // 校门内侧
      { x: -2, z: -11, y: 0 }, // 校门外侧安全区
    ],
  },
  barriers: [
    ...regionFences(REGIONS),
    // Block the first ascending flight before it leaves OFF 1F; the south exit stays open.
    { kind: 'grate', x0: -11.55, x1: -11.35, z0: 131.44, z1: 133.98, y: 0, h: 2.8, face: 'x-', say: '楼上已封闭，请从正门撤离' },
  ],
  landmarks: [
    { kind: 'arrow', x: -14, z: 108, y: 0, dir: 'z-', text: '校门' },
    { kind: 'hydrant', x: -12.2, z: 89, y: 0, dir: 'x-' },
    { kind: 'sign', x: -2, z: -5.7, y: 0, dir: 'z-', text: '校门' },
    { kind: 'lit', x: -2, z: 60.3, y: 0, dir: 'z-' },
    { kind: 'fallen', x: -34.4, z: 125.3, y: 0, dir: 'x+' },
  ],
  hides: [],
  items: [],
};
