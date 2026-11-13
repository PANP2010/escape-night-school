import type { HideSpotDef, LevelDef } from './def.ts';

const FLOOR4 = 10.8, FLOOR5 = 14.4;
/** West classroom lockers occupy the same footprints on both active storeys. */
const lockerRow = (y: number, z: number): HideSpotDef[] => Array.from({ length: 8 }, (_, i) => ({
  kind: 'locker', x: +(-62.44 + i * 0.45).toFixed(2), y, z,
}));

/** 教学楼A's real 4–5F classrooms, joined by the south-west double-flight stairwell. */
export const L6: LevelDef = {
  name: '考场',
  building: 'A',
  floors: [4, 5],
  area: { x0: -65, x1: -15, z0: 63, z1: 97, y0: 10.2, y1: 17.5 },
  spawns: [-41.285, -43.855, -46.425, -48.995].map((x) => ({ x, y: FLOOR4, z: 73.36 })),
  // Stay wholly within the exit strip: a larger radius also counted the adjacent stair flight behind its north wall.
  exit: { x: -60, y: FLOOR5, z: 70.4, r: 1.25 },
  exitName: '五楼西南楼梯门口',
  lockedDoors: [],
  exam: {
    // The existing lectern top in A.4F.class7 (the default west-wing room w1).
    paper: { x: -60.86, y: FLOOR4 + 1.15, z: 72.76 },
    // These y values are paper centres, not feet heights; each sheet faces into the east-side corridor.
    notices: [
      { x: -56.82, y: FLOOR4 + 1.45, z: 74.35, questions: [0, 1, 2], dir: 'x+' },
      { x: -56.82, y: FLOOR5 + 1.45, z: 78.75, questions: [3, 4], dir: 'x+' },
    ],
    // Across the exit strip only, between the stairwell's north wall and classroom's south wall.
    // The 4F–5F stairs and the fifth-floor notice stay accessible east of this door.
    exitGate: { kind: 'grate', x0: -57.7, x1: -57.5, z0: 68.8, z1: 72.16, y: FLOOR5, h: 2.8, face: 'x+', say: '交卷全部正确后开启' },
  },
  monitor: { count: 1, spawns: [{ x: -30, y: FLOOR5, z: 92.3 }] },
  barriers: [
    // Keep the fourth-floor bridge to B out of the exam area.
    { kind: 'grate', x0: -15.5, x1: -15.24, z0: 83.2, z1: 85.3, y: FLOOR4, h: 2.8, face: 'x-', say: '连廊门封闭，请在四、五楼完成考试' },
    // Only the descending (north) flight below 4F is closed; the south flight up to 5F remains open.
    { kind: 'grate', x0: -59.2, x1: -58.85, z0: 66.17, z1: 68.8, y: 9, h: 3.2, face: 'x+', say: '三楼楼梯已封闭' },
    // Close the south flight from 5F to the roof, while leaving the 4F–5F return flight clear.
    { kind: 'grate', x0: -61.95, x1: -61.6, z0: 63.24, z1: 65.87, y: FLOOR5, h: 3, face: 'x+', say: '天台入口已封闭' },
  ],
  landmarks: [
    { kind: 'sign', x: -56.82, y: FLOOR4, z: 75.3, dir: 'x+', text: '考卷在高三（7）班讲台' },
    { kind: 'sign', x: -56.82, y: FLOOR5, z: 77.6, dir: 'x+', text: '第4—5题线索 · 交卷请回四楼' },
    { kind: 'arrow', x: -49, y: FLOOR4, z: 73.9, dir: 'x-', text: '考场' },
    { kind: 'arrow', x: -55.2, y: FLOOR4, z: 73.4, dir: 'z-', text: '五楼线索' },
    { kind: 'hydrant', x: -64.7, y: FLOOR5, z: 75, dir: 'x+' },
    { kind: 'lit', x: -60, y: FLOOR4, z: 72.5, dir: 'x+' },
    { kind: 'fallen', x: -53.4, y: FLOOR4, z: 96.38, dir: 'z-' },
  ],
  hides: [FLOOR4, FLOOR5].flatMap((y) => [...lockerRow(y, 80.75), ...lockerRow(y, 87.65)]),
  items: [{ kind: 'battery', n: 2, spots: [
    { x: -46, y: FLOOR4, z: 92.3, label: 'exam-hall4-west' },
    { x: -31, y: FLOOR4, z: 73.4, label: 'exam-hall4-east' },
    { x: -45, y: FLOOR5, z: 92.3, label: 'exam-hall5-west' },
    { x: -30, y: FLOOR5, z: 73.4, label: 'exam-hall5-east' },
  ] }],
};
