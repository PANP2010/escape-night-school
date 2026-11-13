import type { HideSpotDef, ItemSpotDef, LevelDef } from './def.ts';

/** 讲台 (lectern) drawers of 教学楼B's four 2F 教室; the lectern top is 1.15 m above the 2F floor (y 3.6). */
const LECTERNS: ItemSpotDef[] = [
  { x: 23.25, z: 78.44, y: 4.75, label: 's1' },
  { x: 34.35, z: 78.44, y: 4.75, label: 's2' },
  { x: 43.57, z: 78.44, y: 4.75, label: 's3' },
  { x: 53.25, z: 78.44, y: 4.75, label: 's4' },
];
/** Spots on the 2F corridor floor (the corridor runs z 82.6..85.8). */
const CORRIDOR_FLOOR: ItemSpotDef[] = [20, 28, 38, 48].map((x) => ({ x, z: 84.2, y: 3.6, label: `hall${x}` }));

/** 储物柜 columns under the 后黑板报 of 教学楼B's 2F 教室 (world/classroom.ts), 0.45 m apart: a row from z 76.86 along +z at `x`. */
const lockerRow = (x: number): HideSpotDef[] =>
  Array.from({ length: 8 }, (_, i) => ({ kind: 'locker' as const, x, z: +(76.86 + 0.45 * i).toFixed(2) }));
/** The desks of one 教室: every (x, z) of its desk grid (centres of world/classroom.ts's desk tops). */
const deskGrid = (xs: number[], zs: number[]): HideSpotDef[] => xs.flatMap((x) => zs.map((z) => ({ kind: 'desk' as const, x, z })));
const ZS = [75.79, 76.39, 78.14, 78.74, 80.49, 81.09];
const row = (x0: number, n: number) => Array.from({ length: n }, (_, i) => +(x0 + 0.9 * i).toFixed(2));
const HIDES: HideSpotDef[] = [
  ...lockerRow(24.25), ...lockerRow(35.35), ...lockerRow(44.57),
  ...deskGrid(row(18.24, 5), ZS),
  ...deskGrid(row(26.64, 8), ZS),
  ...deskGrid(row(37.66, 6), ZS),
  ...deskGrid(row(47.34, 6), ZS),
];

/** 第 2 关「二楼·停电」: 教学楼B 2F, lights out; 3 fuses from the lecterns go back into the box on the corridor wall, which opens the west exit's 门禁. */
export const L2: LevelDef = {
  name: '二楼·停电',
  building: 'B',
  floors: [2],
  area: { x0: 14, x1: 66, z0: 73, z1: 87, y0: 3.0, y1: 7.0 },
  spawns: [55.8, 54.4, 53, 51.6].map((x) => ({ x, z: 84.2, y: 3.6 })),
  exit: { x: 15.5, z: 84.2, y: 3.6, r: 3 },
  exitName: '西头连廊门口',
  lockedDoors: [],
  barriers: [
    { kind: 'grate', x0: 14.5, x1: 14.75, z0: 83.3, z1: 85.2, y: 3.6, h: 2.5, face: 'x+', say: '门禁没电锁着，来电后在门口集合' }, // 西连廊 = the exit
    { kind: 'desks', x0: 56.2, x1: 57.0, z0: 82.0, z1: 83.96, y: 3.6, h: 1.6, face: 'x-', say: '楼梯口贴了封条，课桌堵死了', tape: true }, // 东北楼梯上下楼
  ],
  landmarks: [
    { kind: 'arrow', x: 47, z: 83.2, y: 3.6, dir: 'x-', text: '连廊' },
    { kind: 'arrow', x: 33, z: 83.2, y: 3.6, dir: 'x-', text: '连廊' },
    { kind: 'arrow', x: 22, z: 83.2, y: 3.6, dir: 'x-' },
    { kind: 'hydrant', x: 16, z: 85.66, y: 3.6, dir: 'z-' },
    { kind: 'sign', x: 20, z: 85.75, y: 3.6, dir: 'z-', text: '连廊' },
    { kind: 'lit', x: 18.5, z: 78.5, y: 3.6, dir: 'z+' }, // on the emergency circuit: the classroom by the exit still glows
    { kind: 'fallen', x: 58, z: 74.6, y: 3.6, dir: 'z+' }, // east classrooms past the spawn are a dead end
  ],
  blackout: {
    fuses: 3,
    fuseBox: { x: 40, z: 85.6, y: 3.6 },
    emergency: [{ x: 15.8, z: 84.2, y: 3.6 }, { x: 56.5, z: 84.2, y: 3.6 }],
  },
  monitor: { count: 1, teamCount: 2 },
  hides: HIDES,
  items: [
    { kind: 'fuse', n: 3, spots: LECTERNS },
    { kind: 'battery', n: 4, spots: CORRIDOR_FLOOR }, // room-start roster selects one replacement per player
  ],
};
