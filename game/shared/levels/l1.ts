import type { HideSpotDef, ItemSpotDef, LevelDef } from './def.ts';

/** 讲台 (lectern) drawers of 教学楼A's eight 1F 教室 + the 1F corridor floor; world = building (-40, 80) + local. */
const LECTERNS: ItemSpotDef[] = [
  { x: -44.75, z: 67.65, y: 1.15, label: 's1' },
  { x: -26.75, z: 67.65, y: 1.15, label: 's2' },
  { x: -15.94, z: 67.65, y: 1.15, label: 's3' },
  { x: -60.86, z: 72.76, y: 1.15, label: 'w1' },
  { x: -60.86, z: 81.75, y: 1.15, label: 'w2' },
  { x: -60.86, z: 88.65, y: 1.15, label: 'w3' },
  { x: -19.15, z: 86.35, y: 1.15, label: 'e1' },
  { x: -19.15, z: 96.06, y: 1.15, label: 'e2' },
];
const HALL_FLOOR: ItemSpotDef[] = [-55, -48, -40, -32, -25].map((x) => ({ x, z: 92.3, y: 0, label: `hall${x}` }));

/** 储物柜 columns under the 后黑板报 of the eight 教室, 0.45 m apart: a row from (x, z) stepping (dx, dz). */
const lockerRow = (x: number, z: number, dx: number, dz: number): HideSpotDef[] =>
  Array.from({ length: 8 }, (_, i) => ({ kind: 'locker' as const, x: +(x + dx * i).toFixed(2), z: +(z + dz * i).toFixed(2) }));
/** The desks of one 教室: every (x, z) of its desk grid (centres of world/classroom.ts's desk tops). */
const deskGrid = (xs: number[], zs: number[]): HideSpotDef[] => xs.flatMap((x) => zs.map((z) => ({ kind: 'desk' as const, x, z })));
const ROWS = [64.4, 65, 66.37, 66.97, 68.33, 68.93, 70.3, 70.9];
const HIDES: HideSpotDef[] = [
  ...lockerRow(-53.65, 66.07, 0, 0.45), ...lockerRow(-35.65, 66.07, 0, 0.45), ...lockerRow(-25.75, 66.07, 0, 0.45),
  ...lockerRow(-62.44, 80.75, 0.45, 0), ...lockerRow(-62.44, 87.65, 0.45, 0),
  ...lockerRow(-17.56, 76.1, -0.45, 0), ...lockerRow(-17.56, 87.35, -0.45, 0),
  ...deskGrid([-51.56, -50.66, -49.76, -48.86, -47.96, -47.06, -46.16], ROWS),
  ...deskGrid([-33.56, -32.66, -31.76, -30.86, -29.96, -29.06, -28.16], ROWS),
  ...deskGrid([-23.65, -22.75, -21.85, -20.95, -20.05, -19.15, -18.25, -17.35], ROWS),
  ...deskGrid([-63.36, -62.76, -61.16, -60.56, -58.95, -58.35], [74.17, 75.07, 75.97, 76.87, 77.77, 78.67]),
  ...deskGrid([-63.36, -62.76, -61.16, -60.56, -58.95, -58.35], [83.16, 84.06, 84.96]),
  ...deskGrid([-63.36, -62.76, -61.16, -60.56, -58.95, -58.35], [90.06, 90.96, 91.86, 92.76, 93.66]),
  ...deskGrid([-21.65, -21.05, -19.44, -18.84, -17.24, -16.64], [78.64, 79.54, 80.44, 81.34, 82.24, 83.14, 84.04, 84.94]),
  ...deskGrid([-21.65, -21.05, -19.44, -18.84, -17.24, -16.64], [90.15, 91.05, 91.95, 92.85, 93.75, 94.65]),
];

/** 第 1 关「一楼·晚自习后」: find the drawer key, open a different lectern's locked drawer, then reach the SW stairwell. */
export const L1: LevelDef = {
  name: '一楼·晚自习后',
  building: 'A',
  floors: [1],
  area: { x0: -65, x1: -15, z0: 63, z1: 97, y0: -0.5, y1: 3.1 },
  spawns: [-41.285, -43.855, -46.425, -48.995].map((x) => ({ x, z: 73.36 })),
  exit: { x: -61, z: 66, y: 0, r: 3.5 },
  exitName: '西南角楼梯间',
  lockedDoors: [5, 6, 7], // 北侧三间房 (dead ends, no lectern / hide behind them): the door keys open them
  monitor: { count: 1, teamCount: 2, afterItem: 'drawer_key' },
  barriers: [
    { kind: 'grate', x0: -41.8, x1: -38.2, z0: 63.0, z1: 63.34, y: 0, h: 2.8, face: 'z+', say: '大门被铁链锁死了' }, // A 楼正门 → 室外
    { kind: 'desks', x0: -16.5, x1: -15.24, z0: 72.16, z1: 75.7, y: 0, h: 1.6, face: 'x-', say: '课桌堵死了，过不去' }, // 东侧门 → 室外
    { kind: 'grate', x0: -61.95, x1: -61.6, z0: 66.17, z1: 68.8, y: 1.8, h: 2.6, face: 'x-', say: '铁栅门锁着，要楼梯钥匙' }, // 西南楼梯上二楼
  ],
  landmarks: [
    { kind: 'arrow', x: -36, z: 73.9, y: 0, dir: 'x-', text: '楼梯' },
    { kind: 'arrow', x: -53, z: 73.9, y: 0, dir: 'x-', text: '楼梯' },
    { kind: 'arrow', x: -62.6, z: 71, y: 0, dir: 'z-' },
    { kind: 'hydrant', x: -64.7, z: 75, y: 0, dir: 'x+' },
    { kind: 'sign', x: -59.5, z: 72.17, y: 0, dir: 'z+', text: '楼梯间' }, // on the stair room's wall
    { kind: 'lit', x: -60, z: 70.4, y: 0, dir: 'z+' }, // the stair room is the one with the lights on
    { kind: 'fallen', x: -19, z: 72.55, y: 0, dir: 'z+' }, // corridor east end is a dead end
    { kind: 'fallen', x: -53.4, z: 96.38, y: 0, dir: 'z-' }, // so is the washroom off the hall's far corner
  ],
  hides: HIDES,
  items: [
    { kind: 'stair_key', n: 1, spots: LECTERNS, label: '上锁的讲台抽屉 · 内有楼梯钥匙' },
    { kind: 'drawer_key', n: 1, spots: LECTERNS, label: '抽屉钥匙 · 铜牌、有齿' },
    { kind: 'door_key', n: 3, spots: LECTERNS }, // one per locked in-area door (5, 6, 7), in the lecterns the stair key left free
    { kind: 'battery', n: 4, spots: HALL_FLOOR }, // room-start roster selects one replacement per player
    { kind: 'drawer_key', n: 2, spots: LECTERNS, decoy: true, label: '无齿仿制钥匙 · 戏剧道具' },
  ],
};
