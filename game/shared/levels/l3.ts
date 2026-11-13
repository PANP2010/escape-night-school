import type { LevelDef } from './def.ts';

const Y = 7.2;
/** Real B-building 3F door apertures (both doors of each classroom share its number). */
const doors = [16.34, 22.85, 25.05, 33.95, 36.15, 43.1725, 45.3725, 52.85]
  .map((x, i) => ({ id: 112 + i, label: String(301 + Math.floor(i / 2)), x, z: 82.64, y: Y, halfWidth: 0.5 }));

export const L3: LevelDef = {
  name: '三楼·无尽走廊', building: 'B', floors: [3],
  area: { x0: 14, x1: 66, z0: 73, z1: 87, y0: 6.8, y1: 10.6 },
  spawns: [55.2, 53.8, 52.4, 51].map((x) => ({ x, y: Y, z: 84.2 })),
  exit: { x: 17.5, y: Y, z: 84.2, r: 1.2 }, exitName: '西端绿色出口',
  lockedDoors: [],
  loop: {
    sequence: ['303', '301', '304', '302'], doors,
    clue: { x: 54.7, y: Y, z: 85.66 },
    endX: 19.5, corridorZ: 83, shiftX: 36,
  },
  barriers: [
    { kind: 'grate', x0: 14.5, x1: 14.75, z0: 83.3, z1: 85.2, y: Y, h: 2.5, face: 'x+', say: '打破自己的循环后，到绿色出口等队友' },
    { kind: 'desks', x0: 56.2, x1: 57, z0: 82, z1: 83.96, y: Y, h: 1.6, face: 'x-', say: '楼梯被封住了。墙上的粉笔字指向教室门', tape: true },
  ],
  landmarks: [
    ...[47, 33, 22].map((x) => ({ kind: 'arrow' as const, x, y: Y, z: 83.2, dir: 'x-' as const, text: '出口' })),
    { kind: 'hydrant', x: 16, y: Y, z: 85.66, dir: 'z-' },
    { kind: 'sign', x: 20, y: Y, z: 85.75, dir: 'z-', text: '循环尽头' },
    { kind: 'lit', x: 40, y: Y, z: 78.5, dir: 'z+' },
    { kind: 'fallen', x: 58, y: Y, z: 74.6, dir: 'z+' },
  ],
  hides: [],
  items: [{ kind: 'battery', n: 2, spots: [28, 48].map((x) => ({ x, y: Y, z: 84.2, label: `hall${x}` })) }],
};
