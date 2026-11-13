import type { LevelDef } from './def.ts';

/** L4 follows the third-floor loop at its real zero-based index 3. */
export const L4_INDEX = 3;
export const L4: LevelDef = {
  name: '广播站', building: 'OFF', floors: [3, 4],
  area: { x0: -35, x1: -5, z0: 123, z1: 137, y0: 7.0, y1: 14.0 },
  spawns: [-18, -20, -22, -24].map(x => ({ x, z: 130, y: 7.2 })),
  exit: { x: -14.5, z: 134.3, y: 7.2, r: 1.1 }, exitName: '三楼东侧楼梯口',
  lockedDoors: [],
  // The lower flight is physically sealed; the 3F→4F flight remains open.
  barriers: [{ kind: 'grate', x0: -11.05, x1: -10.85, z0: 134.35, z1: 136.76, y: 7.0, h: 2.0, face: 'x-', say: '二楼已封闭，另一侧楼梯通往四楼' }],
  landmarks: [
    { kind: 'sign', x: -26.75, z: 131.15, y: 10.8, dir: 'z-', text: '广播室 · 工会值班' },
    { kind: 'sign', x: -17, z: 128.85, y: 7.2, dir: 'z+', text: '午夜广播：找四张编号贴纸 → 四楼广播室 → 三楼集合' },
    { kind: 'arrow', x: -12, z: 130, y: 7.2, dir: 'z+', text: '四楼' },
    // The stair approach at x=-13.8 has no backing wall. Mount flush to the solid corridor partition.
    { kind: 'hydrant', x: -18.2, z: 131.09, y: 7.2, dir: 'z-' },
    { kind: 'fallen', x: -34.25, z: 128, y: 7.2, dir: 'x+' },
    { kind: 'lit', x: -26.75, z: 132.2, y: 10.8, dir: 'z-' },
  ],
  hides: [
    { kind: 'locker', x: -33.5, z: 130.6, y: 7.2 },
    { kind: 'locker', x: -33.5, z: 130.6, y: 10.8 },
    { kind: 'booth', x: -14.5, z: 136, y: 7.2 },
    { kind: 'booth', x: -14.5, z: 136, y: 10.8 },
  ],
  broadcast: {
    console: { x: -26.75, y: 10.8, z: 132.1 },
    stickers: [
      { x: -28.5, y: 7.2, z: 128.84, label: '三楼历史组门旁', face: 'z+' },
      { x: -20, y: 7.2, z: 131.16, label: '三楼教研活动室门旁', face: 'z-' },
      { x: -32.5, y: 10.8, z: 128.84, label: '四楼西侧厕所门旁', face: 'z+' },
      { x: -19.8, y: 10.8, z: 131.16, label: '四楼接待室门旁', face: 'z-' },
    ],
    interval: [60, 90], reveal: 10,
  },
  items: [{ kind: 'battery', n: 2, spots: [
    { x: -23, y: 7.2, z: 130, label: '3F电池' },
    { x: -23, y: 10.8, z: 130, label: '4F电池' },
  ] }],
};
