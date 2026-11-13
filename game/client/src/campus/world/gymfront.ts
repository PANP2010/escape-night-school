import { buildingHeight, PARAPET, type CampusDef } from '../../../../shared/campus/campus_schema.ts';
import { box, type AABB } from '../../../../shared/campus/collision.ts';
import { onWall } from './hallfront.ts';
import type { PropPart } from './props.ts';
import { canopyOf } from './shelter.ts';

/**
 * 体育馆东门 (data/campus/campus.json GYM, its one entrance, a widened `canopy`): what a 体育馆's front has that a
 * classroom block's door does not. Over the 雨棚 「体育馆」 in red 立体字; in the doorway's 门套 a 推拉铁栅门 on a track
 * under the 雨棚, its two leaves pushed right back to either side by day; a 3 cm 水泥门前平台 under the 雨棚 with a
 * 擦鞋格栅 at the door; beside it a 开放时间牌 screwed to the wall. No steps: the court is level with the ground (as
 * every ground floor on the campus). u along the wall (building-local z on an x face), heights above the ground.
 * World-space parts; pure. The render goes into the campus props mesh (world/props.ts propGeometry).
 */
export const GYM_FRONT = {
  /** cement 门前平台 top above the ground; 擦鞋格栅 depth out from the wall, bar pitch */ floor: 0.03, grate: { d: 1.2, pitch: 0.15 },
  /** 门套: width, how far proud of the wall */ case: { w: 0.16, out: 0.1 },
  /** 推拉铁栅门 leaf: height, frame width, bar pitch, how far off the wall; the track over the opening (height, depth) */
  gate: { h: 3.12, frame: 0.06, pitch: 0.16, off: 0.12, rail: [0.1, 0.08] as const },
  /** 开放时间牌: centre u (outside the 雨棚's end), width, bottom / top above the ground, text lines */ sign: { at: -5.4, w: 0.9, y: [1.2, 2.1] as const, lines: 5 },
  /** 立体字: cell side (m), how far proud of the wall, gap between characters, bottom above the 雨棚 roof */
  word: { cell: 0.07, out: 0.1, gap: 0.4, above: 0.9 },
};

export function gymFrontParts(c: CampusDef): PropPart[] {
  const out: PropPart[] = [];
  const b = c.buildings.find(q => q.id === 'GYM'), e = b?.entrances?.[0];
  if (!b || !e) return out;
  const P = onWall(out, b, e.side), C = canopyOf(e), F = GYM_FRONT, G = F.gate, K = F.case;
  const hw = e.width / 2, a = e.at - hw, z = e.at + hw, U0 = e.at - hw - C.side, U1 = e.at + hw + C.side, top = e.height + C.gap;
  // ── 门前平台 under the 雨棚, the 擦鞋格栅 in front of the doorway (a frame, bars across it)
  P('porch', U0, U1, 0, F.floor, 0, C.out);
  P('grate', a, z, F.floor, F.floor + 0.015, 0, F.grate.d);
  for (let v = a + F.grate.pitch / 2; v < z; v += F.grate.pitch) P('bar', v - 0.02, v + 0.02, F.floor + 0.015, F.floor + 0.03, 0.02, F.grate.d);
  // ── 门套 round the opening
  P('doorCase', a - K.w, a, 0, e.height + K.w, 0, K.out);
  P('doorCase', z, z + K.w, 0, e.height + K.w, 0, K.out);
  P('doorCase', a, z, e.height, e.height + K.w, 0, K.out);
  // ── 推拉铁栅门: the track across the head, each leaf (frame, a mid rail, upright bars) pushed back onto the wall
  P('gymGate', a - hw - K.w, z + hw + K.w, e.height + K.w, e.height + K.w + G.rail[0], G.off, G.off + G.rail[1]);
  for (const s of [-1, 1]) {
    const l0 = s < 0 ? a - K.w - hw : z + K.w, l1 = l0 + hw, o0 = G.off + 0.01, o1 = o0 + 0.04, f = G.frame;
    P('gymGate', l0, l0 + f, 0.04, G.h, o0, o1);
    P('gymGate', l1 - f, l1, 0.04, G.h, o0, o1);
    for (const y of [0.04, G.h * 0.5, G.h - f]) P('gymGate', l0, l1, y, y + f, o0, o1);
    for (let v = l0 + G.pitch; v < l1 - f; v += G.pitch) P('gymGate', v - 0.018, v + 0.018, 0.04, G.h, o0 + 0.005, o1 - 0.005);
    P('wheel', l0 + 0.1, l0 + 0.2, 0, 0.08, o0, o1); P('wheel', l1 - 0.2, l1 - 0.1, 0, 0.08, o0, o1);
  }
  // ── 开放时间牌: a white board, its lines of black type (painted: no legible words at this size)
  const S = F.sign, s0 = S.at - S.w / 2, s1 = S.at + S.w / 2;
  P('gymSign', s0, s1, S.y[0], S.y[1], 0, 0.03);
  P('gymSignText', s0 + 0.12, s1 - 0.12, S.y[1] - 0.17, S.y[1] - 0.09, 0.03, 0.034);
  for (let k = 1; k < S.lines; k++) {
    const y = S.y[1] - 0.2 - k * 0.12;
    P('gymSignText', s0 + 0.08, s1 - 0.08 - (k % 2) * 0.2, y - 0.025, y + 0.025, 0.03, 0.034);
  }
  // ── 「体育馆」 over the 雨棚, one box per run of cells in a row; read from outside (on a +x wall that is towards +z)
  const W = F.word, n = GYM_WORDS[0].length, gw = n * W.cell, y1 = top + C.t + W.above + gw;
  const rd = e.side === '+z' || e.side === '-x' ? 1 : -1, left = -(GYM_WORDS.length * gw + (GYM_WORDS.length - 1) * W.gap) / 2;
  GYM_WORDS.forEach((rows, k) => rows.forEach((row, j) => {
    for (const m of row.matchAll(/#+/g)) {
      const p0 = left + k * (gw + W.gap) + (m.index ?? 0) * W.cell, p1 = p0 + m[0].length * W.cell, yt = y1 - j * W.cell;
      P('hallWord', e.at + Math.min(rd * p0, rd * p1), e.at + Math.max(rd * p0, rd * p1), yt - W.cell, yt, 0, W.out);
    }
  }));
  return out;
}

/** 「体育馆」 as 24 × 24 bitmaps (WenQuanYi Zen Hei 24 px, centred, thresholded; row 0 = top, '#' = a cell of the 立体字) */
export const GYM_WORDS: readonly (readonly string[])[] = [
  [
    '........................',
    '......#......##.........',
    '.....##......##.........',
    '.....##......##.........',
    '.....#.......##.........',
    '....##..##############..',
    '....##.###############..',
    '...##.......#####.......',
    '...##......######.......',
    '..###......####.#.......',
    '.####......####.##......',
    '###.#.....##.##.##......',
    '.#..#.....##.##..#......',
    '....#....###.##..##.....',
    '....#....##..##...##....',
    '....#...##...##...###...',
    '....#..###############..',
    '....#.###.#########.###.',
    '....#.##.....##......#..',
    '....#........##.........',
    '....#........##.........',
    '....#........##.........',
    '....#........##.........',
    '........................',
  ],
  [
    '.........####...........',
    '..........###...........',
    '#######################.',
    '........####............',
    '.......###.....##.......',
    '......###......###......',
    '....###############.....',
    '...##########.....###...',
    '...................##...',
    '........................',
    '.....#############......',
    '.....#############......',
    '.....##..........#......',
    '.....##..........#......',
    '.....#############......',
    '.....##..........#......',
    '.....##..........#......',
    '.....#############......',
    '.....#############......',
    '.....##..........#......',
    '.....##..........#......',
    '.....##.......#.##......',
    '.....##.......####......',
    '..............##........',
  ],
  [
    '..............##........',
    '.....#........##........',
    '....###........##.......',
    '....##.....############.',
    '....##....#############.',
    '...#########.........##.',
    '...##...####.........##.',
    '...##...############.##.',
    '..##...##...########....',
    '.###.#......#......#....',
    '.##.##......#......#....',
    '###.##......##....##....',
    '....##......########....',
    '....##......#...........',
    '....##......##..........',
    '....##......#########...',
    '....##..##..#......##...',
    '....##.##...#......##...',
    '....####....#......##...',
    '....###.....##.....##...',
    '....###.....#########...',
    '............#......##...',
    '............#......##...',
    '........................',
  ],
];

/**
 * 体育馆南北长立面 (GYM's ±z faces, 36 m, the 高窗 at 6.4~9.4 m only): what fills the 6 m of wall under them. Under each
 * 高窗 a 通风百叶 low down (a dark opening in a 门套-coloured frame, steel slats across it, each a step further out to read as
 * tilted); a 雨水管 down each 窗间墙 pair and at both ends; a 0.6 m 水泥散水 along the foot (over the 勒脚's foot, world/building.ts
 * PLINTH stays as it is). Symmetric about u = 0, so no mirroring. World-space parts; pure; into the campus props mesh.
 */
export const GYM_SIDE = {
  /** 通风百叶: width, bottom / top above the ground, frame width, slat pitch */ louvre: { w: 2.4, y: [0.6, 1.4] as const, frame: 0.08, pitch: 0.1 },
  /** 雨水管 u (between the 高窗 and near the ends) */ pipe: [-9, 9],
  /** 散水 depth out from the wall, top above the ground */ apron: { d: 0.6, h: 0.025 },
};

export function gymSideParts(c: CampusDef): PropPart[] {
  const out: PropPart[] = [];
  const b = c.buildings.find(q => q.id === 'GYM'), f = b?.facade;
  if (!b || !f) return out;
  const H = buildingHeight(b), L = GYM_SIDE.louvre, A = GYM_SIDE.apron, n = Math.floor((b.w - 2 * (f.margin ?? 1.2)) / f.bay);
  for (const side of (f.sides ?? []).filter(s => s[1] === 'z')) {
    const P = onWall(out, b, side);
    P('apron', -b.w / 2 - A.d, b.w / 2 + A.d, 0, A.h, 0, A.d);
    // ── 通风百叶 under each 高窗: the dark hole, its frame, the slats (lower ones further out, a 45° 百叶 seen side-on)
    for (let i = 0; i < n; i++) {
      const u = (i - (n - 1) / 2) * f.bay, a = u - L.w / 2, z = u + L.w / 2, [y0, y1] = L.y, k = L.frame;
      P('louvreHole', a, z, y0, y1, 0, 0.02);
      P('doorCase', a - k, a, y0 - k, y1 + k, 0, 0.06);
      P('doorCase', z, z + k, y0 - k, y1 + k, 0, 0.06);
      P('doorCase', a, z, y1, y1 + k, 0, 0.06);
      P('doorCase', a - k, z + k, y0 - k - 0.02, y0, 0, 0.09);
      for (let y = y1 - L.pitch, j = 0; y > y0 + 0.02; y -= L.pitch, j++) P('louvre', a, z, y - 0.012, y + 0.035, 0.025, 0.05 + 0.004 * j);
      P('louvre', u - 0.02, u + 0.02, y0, y1, 0.01, 0.07);
    }
    // ── 雨水管 from the roof's edge down, a 雨水斗 at the head, a shoe at the foot onto the 散水
    for (const u of GYM_SIDE.pipe) {
      P('downpipe', u - 0.15, u + 0.15, H - 0.35, H - 0.05, 0.04, 0.3);
      P('downpipe', u - 0.055, u + 0.055, 0.15, H - 0.35, 0.06, 0.17);
      P('downpipe', u - 0.08, u + 0.08, A.h, 0.18, 0.06, 0.32);
    }
  }
  return out;
}

/** the 雨水管 shoes on the 散水 (the louvres are flush with the wall, the 散水 is 2.5 cm: walk over it) */
export function gymSideColliders(c: CampusDef): AABB[] {
  return gymSideParts(c).filter(q => q.kind === 'downpipe' && q.c[1] < 0.2)
    .map(q => box(q.c[0], q.c[2], q.s[0], q.s[2], q.c[1] + q.s[1] / 2));
}

/**
 * 体育馆西立面 (GYM's -x face, 30 m, no window, the low sun behind it by afternoon): what a blank 山墙 of a 体育馆 carries.
 * At the 器材室's end (the south-west corner inside) a 检修钢门 for carrying the 跳箱 in and out, two leaves, a hasp + 挂锁
 * and a small 「器材室 闲人免进」 plate (outside only: a locked door, nobody goes through); along the 篮球馆 two 通风百叶 low
 * down as on the long faces; a caged 铁爬梯 up to the roof, its foot boarded off with a padlocked plate (as the 礼堂's
 * 舞台后墙); two 雨水管; two 腰线 carrying the long faces' 高窗 sill and head lines round the corner; the 散水.
 * u = building-local z (from outside, -z is on the left). World-space parts; pure; into the campus props mesh.
 */
export const GYM_WEST = {
  /** 检修门: centre u (the 器材室, z -14.76..-8.76 inside), width, height */ door: { at: -11.8, w: 2.0, h: 2.4 },
  /** 通风百叶 centres u (the 篮球馆's courtW behind) */ louvre: [-3, 3],
  /** 爬梯: u, rail spacing, foot, rung pitch, off the wall; 护笼 from, hoop pitch, radius */ ladder: { at: 8.5, w: 0.45, y: 0.3, rung: 0.3, off: 0.18, cage: 2.4, hoop: 0.9, r: 0.38 },
  /** 雨水管 u */ pipe: [-7, 13],
  /** 腰线 heights (the 高窗's sill / head), depth, how far proud */ band: { y: [6.4, 9.4] as const, h: 0.18, out: 0.06 },
};

export function gymWestParts(c: CampusDef): PropPart[] {
  const out: PropPart[] = [];
  const b = c.buildings.find(q => q.id === 'GYM');
  if (!b) return out;
  const P = onWall(out, b, '-x'), W = GYM_WEST, D = W.door, L = GYM_SIDE.louvre, A = GYM_SIDE.apron, H = buildingHeight(b), hd = b.d / 2;
  P('apron', -hd - A.d, hd + A.d, 0, A.h, 0, A.d);
  // ── 腰线 at the 高窗's sill and head
  for (const y of W.band.y) P('coping', -hd, hd, y - W.band.h / 2, y + W.band.h / 2, 0, W.band.out);
  // ── 检修钢门: 门套, two leaves with a seam, the 门槛, a hasp + 挂锁 across the meeting, the plate beside it
  const a = D.at - D.w / 2, z = D.at + D.w / 2, k = 0.12;
  P('doorCase', a - k, a, 0, D.h + k, 0, 0.1);
  P('doorCase', z, z + k, 0, D.h + k, 0, 0.1);
  P('doorCase', a - k, z + k, D.h, D.h + k, 0, 0.1);
  P('doorCase', a, z, 0, 0.04, 0, 0.12);
  P('gymGate', a, z, 0.04, D.h, 0, 0.05);
  P('bar', D.at - 0.012, D.at + 0.012, 0.04, D.h, 0.05, 0.056);
  for (const y of [0.3, D.h - 0.3]) for (const [p, q] of [[a + 0.08, a + 0.4], [z - 0.4, z - 0.08]]) P('louvre', p, q, y - 0.03, y + 0.03, 0.05, 0.06);
  P('frame', D.at - 0.12, D.at + 0.12, 1.08, 1.14, 0.05, 0.075);
  P('lock', D.at - 0.035, D.at + 0.035, 0.98, 1.08, 0.06, 0.09);
  P('gymSign', z + 0.3, z + 0.9, 1.45, 1.75, 0, 0.015);
  for (let i = 0; i < 2; i++) { const y = 1.66 - i * 0.12; P('gymSignText', z + 0.36, z + 0.84 - i * 0.12, y - 0.025, y + 0.025, 0.015, 0.018); }
  // ── 通风百叶 low down (the same as the long faces')
  for (const u of W.louvre) {
    const p = u - L.w / 2, q = u + L.w / 2, [y0, y1] = L.y, f = L.frame;
    P('louvreHole', p, q, y0, y1, 0, 0.02);
    P('doorCase', p - f, p, y0 - f, y1 + f, 0, 0.06);
    P('doorCase', q, q + f, y0 - f, y1 + f, 0, 0.06);
    P('doorCase', p, q, y1, y1 + f, 0, 0.06);
    P('doorCase', p - f, q + f, y0 - f - 0.02, y0, 0, 0.09);
    for (let y = y1 - L.pitch, j = 0; y > y0 + 0.02; y -= L.pitch, j++) P('louvre', p, q, y - 0.012, y + 0.035, 0.025, 0.05 + 0.004 * j);
    P('louvre', u - 0.02, u + 0.02, y0, y1, 0.01, 0.07);
  }
  // ── 铁爬梯 up past the parapet: rails, rungs, the 护笼, the padlocked plate at its foot
  const R = W.ladder, y1 = H + PARAPET, r0 = R.at - R.w / 2, r1 = R.at + R.w / 2, o = R.off, f = o + R.r * 1.6;
  for (const v of [r0, r1]) P('ladder', v - 0.025, v + 0.025, R.y, y1 + 0.9, o - 0.025, o + 0.025);
  for (const v of [r0, r1]) for (const y of [R.y + 0.4, H - 0.6]) P('ladder', v - 0.02, v + 0.02, y, y + 0.05, 0, o);
  for (let y = R.y + 0.3; y < y1; y += R.rung) P('ladder', r0, r1, y - 0.015, y + 0.015, o - 0.015, o + 0.015);
  for (let y = R.cage; y < y1 + 0.9; y += R.hoop) {
    const c0 = R.at - R.r, c1 = R.at + R.r;
    P('ladder', c0, c0 + 0.03, y, y + 0.04, 0, f);
    P('ladder', c1 - 0.03, c1, y, y + 0.04, 0, f);
    P('ladder', c0, c1, y, y + 0.04, f - 0.03, f);
  }
  for (const v of [R.at - R.r, R.at, R.at + R.r]) {
    const g = v === R.at ? f - 0.03 : o + R.r * 0.8;
    P('ladder', v - 0.015, v + 0.015, R.cage, y1 + 0.9, g - 0.015, g + 0.015);
  }
  P('ladderPlate', r0 - 0.06, r1 + 0.06, 0.3, 2.2, o + 0.03, o + 0.045);
  P('lock', R.at - 0.035, R.at + 0.035, 1.2, 1.29, o + 0.045, o + 0.075);
  // ── 雨水管 (through the 腰线: the pipe stands proud of the band)
  for (const u of W.pipe) {
    P('downpipe', u - 0.15, u + 0.15, H - 0.35, H - 0.05, 0.04, 0.3);
    P('downpipe', u - 0.055, u + 0.055, 0.15, H - 0.35, 0.08, 0.19);
    P('downpipe', u - 0.08, u + 0.08, A.h, 0.18, 0.08, 0.34);
  }
  return out;
}

/** the 爬梯's plate and the 雨水管 shoes (the door, louvres and 散水 are flush) */
export function gymWestColliders(c: CampusDef): AABB[] {
  return gymWestParts(c).filter(q => q.kind === 'ladderPlate' || (q.kind === 'downpipe' && q.c[1] < 0.2))
    .map(q => box(q.c[0], q.c[2], q.s[0], q.s[2], q.c[1] + q.s[1] / 2));
}
