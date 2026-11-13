import type { LevelDef } from './def.ts';

/** Fifth playable chapter, zero-based on the wire. */
export const L5_INDEX = 4;
export const GYM_FLOOR = 0.035;
export const L5: LevelDef = {
  name: '体育馆', building: 'GYM', floors: [1],
  area: { x0: -118, x1: -82, z0: 45, z1: 75, y0: -0.3, y1: 3 },
  spawns: [57.6, 59.2, 60.8, 62.4].map((z) => ({ x: -86, y: GYM_FLOOR, z })),
  exit: { x: -84, y: GYM_FLOOR, z: 60, r: 1.4 }, exitName: '体育馆东门',
  lockedDoors: [],
  gym: {
    equipmentDoor: 182,
    switches: [
      { x: -111.76, y: 0, z: 49.6, label: '器材室', yaw: 0 },
      { x: -110, y: GYM_FLOOR, z: 56, label: '西侧篮架', yaw: Math.PI / 2 },
      { x: -102, y: GYM_FLOOR, z: 69, label: '北侧看台', yaw: Math.PI },
      { x: -98, y: GYM_FLOOR, z: 52.8, label: '记分台', yaw: 0 },
    ],
    ballSpawn: { x: -111.76, y: GYM_FLOOR, z: 50 },
    stands: [-108, -96].map((x) => ({ x, z: 70.5, w: 4, rows: 4, run: 0.9, rise: 0.18 })),
  },
  monitor: { count: 2, spawns: [-106, -94].map((x) => ({ x, y: 0.72, z: 73.65 })) },
  barriers: [
    { kind: 'grate', x0: -82.5, x1: -82.22, z0: 58, z1: 62, y: 0, h: 2.8, face: 'x-', say: '四个开关全部亮绿灯后，在东门内集合' },
  ],
  landmarks: [
    { kind: 'sign', x: -87.5, z: 63, y: 0, dir: 'x-', text: '体育馆 · 四灯门禁\n多人 5秒 / 单人 20秒\n1器材室 2西侧 3看台 4记分台' },
    { kind: 'sign', x: -111.76, z: 51.5, y: 0, dir: 'z+', text: '器材室 · 开关①\n当心滚出的篮球' },
    { kind: 'arrow', x: -90, z: 57, y: GYM_FLOOR, dir: 'x+', text: '东门出口' },
    { kind: 'hydrant', x: -82.7, z: 65, y: GYM_FLOOR, dir: 'x-' },
    { kind: 'lit', x: -115, z: 48, y: 0, dir: 'z+' },
    { kind: 'fallen', x: -117.41, z: 65, y: GYM_FLOOR, dir: 'x+' },
  ],
  hides: [],
  items: [{ kind: 'battery', n: 2, spots: [
    { x: -115, y: 0, z: 49, label: 'equip-battery' },
    { x: -90, y: GYM_FLOOR, z: 70, label: 'stand-battery' },
  ] }],
};
