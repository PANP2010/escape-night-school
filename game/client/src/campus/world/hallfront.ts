import { buildingHeight, PARAPET, type BuildingDef, type CampusDef, type EntranceDef, type Side } from '../../../../shared/campus/campus_schema.ts';
import { box, type AABB } from '../../../../shared/campus/collision.ts';
import { exitDoorsU, HALL, porchOf } from './hall.ts';
import type { PropPart } from './props.ts';
import { canopyOf } from './shelter.ts';

/**
 * 礼堂正门 (data/campus/campus.json HALL, its -z entrance with a big `canopy`: the 门廊): what a 礼堂's front has that a
 * classroom block's door does not. Under the 门廊 roof (world/building.ts canopy draws it, world/shelter.ts keeps the
 * rain off under it) four square columns along its front edge, three bays, a cement floor and a whitewashed soffit; the main doorway's two
 * big 枣红 leaves swung right round and hooked back flat on the wall either side of it (open by day); either side of
 * those a 双扇木门 at the end of each of the 观众席's aisles, shut, a 搭扣 and 挂锁 across the middle (their inside
 * faces are the hall's furniture, world/hall.ts exitDoors); on the wall over the 门廊 「礼堂」 in red 立体字. No steps:
 * every ground floor on the campus is level with the ground (the back cross aisle inside is level with the door).
 * World-space parts; pure. The render goes into the campus props mesh (world/props.ts propGeometry), the columns
 * also collide.
 */
export const FRONT = {
  /** 门廊柱: side, base (side, height), how far in from the 门廊's front edge (centre) and its ends */
  col: { s: 0.5, base: [0.64, 0.28] as const, inset: 0.45 },
  /** cement floor under the 门廊: top above the ground (a 3 cm 水泥地坪 over the paving, under any step: walk straight on) */ floor: 0.03,
  /** door leaf: thickness, stile / rail width round its two panels, the glass light high in it (height, top below the
   *  leaf's top), the 门套 round a shut door (width, how far proud of the wall) */
  leaf: { t: 0.05, rail: 0.14, light: [0.5, 0.2] as const, caseW: 0.12, caseOut: 0.08 },
  /** 立体字: cell side (m), how far proud of the wall, gap between the two characters, bottom above the 门廊 roof */
  word: { cell: 0.075, out: 0.1, gap: 0.5, above: 1.5 },
};

/**
 * 舞台后墙 (the side opposite the 门廊): a 道具卸货 卷帘门 at the deck's height (painted on the wall: the stage behind
 * it is the 天幕's, nobody goes in) over a concrete 卸货平台 with steps down at one end, the 台仓's two 半地下采光窗 at
 * the foot of the wall in their 采光井 (a kerb, a grating), a caged 铁爬梯 up to the roof (its foot boarded off with a
 * padlocked plate) and two 雨水管. u along the wall (building-local x), heights above the ground.
 */
export const BACK = {
  /** 卷帘门: centre u, width, height, bottom above the ground (= 台面 1.1 m), slat pitch */ door: { at: -6, w: 3.2, h: 3.4, y: 1.1, slat: 0.12 },
  /** 卸货平台: width (along the wall), depth out, steps at its +u end (count, run) */ dock: { w: 4.6, d: 2.4, steps: 6, run: 0.3 },
  /** 采光窗: centres u, width, top / bottom above the ground (the sill under it, in the 井), 井 depth out */ light: { at: [3, 8.5], w: 1.6, y: [0.55, 0.05] as const, well: 0.7 },
  /** 爬梯: u, rail spacing, foot above the ground, rung pitch, off the wall; 护笼 from this height, hoop pitch, radius */ ladder: { at: 12.5, w: 0.45, y: 0.3, rung: 0.3, off: 0.18, cage: 2.4, hoop: 0.9, r: 0.38 },
  /** 雨水管 u (side) */ pipe: [-14.5, 14.5],
};

/** The 舞台后墙's side: the wall opposite a 礼堂's 门廊. */
const backSide = (e: EntranceDef): Side => (e.side[0] === '+' ? '-' : '+') + e.side[1] as Side;

export function hallBackParts(c: CampusDef): PropPart[] {
  const out: PropPart[] = [];
  for (const b of c.buildings) {
    const e = porchOf(b);
    if (!e) continue;
    const side = backSide(e), P = onWall(out, b, side), B = BACK, D = B.door, K = B.dock, H = buildingHeight(b);
    // the u axis of onWall runs along +x / +z whichever face it is: mirror so 'at' reads from outside the same way
    const m = side === '+z' || side === '-x' ? -1 : 1, U = (u: number) => m * u;
    const span = (k: PropPart['kind'], a: number, z: number, y0: number, y1: number, o0: number, o1: number) =>
      P(k, Math.min(U(a), U(z)), Math.max(U(a), U(z)), y0, y1, o0, o1);
    // ── 卸货平台 + its steps down at the +u end
    const d0 = D.at - K.w / 2, d1 = D.at + K.w / 2;
    span('dock', d0, d1, 0, D.y, 0, K.d);
    span('dockEdge', d0, d1, D.y - 0.12, D.y, K.d, K.d + 0.02);
    for (let k = 0; k < K.steps; k++) {
      const yt = D.y * (K.steps - k) / (K.steps + 1), a = d1 + k * K.run;
      span('dock', a, a + K.run, 0, yt, 0, K.d * 0.6);
    }
    // ── 卷帘门: 门套, the slats (a seam every pitch), the 卷帘箱 over it, the bottom bar and its 挂锁
    const a = D.at - D.w / 2, z = D.at + D.w / 2, top = D.y + D.h;
    span('doorCase', a - 0.15, a, D.y, top + 0.15, 0, 0.12);
    span('doorCase', z, z + 0.15, D.y, top + 0.15, 0, 0.12);
    span('shutter', a, z, D.y, top, 0, 0.06);
    for (let y = D.y + D.slat; y < top - 0.02; y += D.slat) span('shutterSeam', a, z, y - 0.012, y + 0.012, 0.06, 0.065);
    span('shutterBox', a - 0.2, z + 0.2, top + 0.15, top + 0.65, 0, 0.42);
    span('shutterSeam', a, z, D.y + 0.02, D.y + 0.1, 0.06, 0.09);
    span('lock', D.at - 0.04, D.at + 0.04, D.y + 0.1, D.y + 0.2, 0.08, 0.12);
    // ── 台仓的半地下采光窗 in their 采光井
    const L = B.light;
    for (const u of L.at) {
      const w0 = u - L.w / 2, w1 = u + L.w / 2;
      span('doorCase', w0 - 0.08, w1 + 0.08, -0.02, L.y[0] + 0.08, 0, 0.04);
      span('doorGlass', w0, w1, -0.02, L.y[0], 0.04, 0.05);
      for (let k = 1; k < 6; k++) { const v = w0 + (k * L.w) / 6; span('bar', v - 0.012, v + 0.012, -0.02, L.y[0], 0.05, 0.075); }
      span('wellKerb', w0 - 0.2, w0 - 0.08, 0, 0.18, 0, L.well);
      span('wellKerb', w1 + 0.08, w1 + 0.2, 0, 0.18, 0, L.well);
      span('wellKerb', w0 - 0.2, w1 + 0.2, 0, 0.18, L.well, L.well + 0.12);
      span('grate', w0 - 0.08, w1 + 0.08, 0.13, 0.15, 0.05, L.well);
      for (let v = w0 + 0.1; v < w1; v += 0.16) span('bar', v - 0.012, v + 0.012, 0.15, 0.165, 0.05, L.well);
    }
    // ── 铁爬梯 up to the parapet's top: rails, rungs, the 护笼 hoops + straps, the padlocked plate at its foot
    const R = B.ladder, y1 = H + PARAPET, r0 = R.at - R.w / 2, r1 = R.at + R.w / 2, o = R.off;
    for (const v of [r0, r1]) span('ladder', v - 0.025, v + 0.025, R.y, y1 + 0.9, o - 0.025, o + 0.025);
    for (const v of [r0, r1]) span('ladder', v - 0.02, v + 0.02, R.y + 0.4, R.y + 0.45, 0, o);
    for (let y = R.y + 0.3; y < y1; y += R.rung) span('ladder', r0, r1, y - 0.015, y + 0.015, o - 0.015, o + 0.015);
    for (let y = R.cage; y < y1 + 0.9; y += R.hoop) {
      const c0 = R.at - R.r, c1 = R.at + R.r, f = o + R.r * 1.6;
      span('ladder', c0, c0 + 0.03, y, y + 0.04, 0, f);
      span('ladder', c1 - 0.03, c1, y, y + 0.04, 0, f);
      span('ladder', c0, c1, y, y + 0.04, f - 0.03, f);
    }
    for (const v of [R.at - R.r, R.at, R.at + R.r]) {
      const f = v === R.at ? o + R.r * 1.6 - 0.03 : o + R.r * 0.8;
      span('ladder', v - 0.015, v + 0.015, R.cage, y1 + 0.9, f - 0.015, f + 0.015);
    }
    span('ladderPlate', r0 - 0.06, r1 + 0.06, 0.3, 2.2, o + 0.03, o + 0.045);
    span('lock', R.at - 0.035, R.at + 0.035, 1.2, 1.29, o + 0.045, o + 0.075);
    // ── 雨水管 from the roof down, a shoe at the foot
    for (const u of B.pipe) {
      span('downpipe', u - 0.055, u + 0.055, 0.15, H + 0.1, 0.06, 0.17);
      span('downpipe', u - 0.08, u + 0.08, 0, 0.18, 0.06, 0.32);
    }
  }
  return out;
}

/** 卸货平台 and its steps, 采光井 kerbs, the 爬梯's plate, the 雨水管 shoes. */
export function hallBackColliders(c: CampusDef): AABB[] {
  return hallBackParts(c).filter(q => q.kind === 'dock' || q.kind === 'wellKerb' || q.kind === 'ladderPlate' || (q.kind === 'downpipe' && q.c[1] < 0.2))
    .map(q => box(q.c[0], q.c[2], q.s[0], q.s[2], q.c[1] + q.s[1] / 2));
}

/** 「礼堂」 as 24 × 24 bitmaps (WenQuanYi Zen Hei 24 px, thresholded; row 0 = top, '#' = a cell of the 立体字) */
export const HALL_WORDS: readonly (readonly string[])[] = [
  [
    '........................',
    '.....#..................',
    '.....##.......##........',
    '.....##.......##........',
    '......##......##........',
    '......##......##........',
    '.#########....##........',
    '.#########....##........',
    '.......###....##........',
    '.......##.....##........',
    '......##......##........',
    '.....####.....##........',
    '.....#####....##........',
    '....#######...##........',
    '...##.##.###..##........',
    '.###..##..#...##........',
    '.##...##......##........',
    '......##......##......#.',
    '......##......##......#.',
    '......##......##......#.',
    '......##......##.....##.',
    '......##......##.....##.',
    '......##......#########.',
    '......##........######..',
  ],
  [
    '........................',
    '...........#............',
    '....##.....##....##.....',
    '.....##....#....##......',
    '.....###...#...###......',
    '......##...#...##.......',
    '.######################.',
    '.##..................##.',
    '.#...................##.',
    '.#...................##.',
    '.....#############......',
    '.....##.........##......',
    '.....##.........##......',
    '.....##.........##......',
    '.....#############......',
    '.....##....##...##......',
    '...........##...........',
    '...........##...........',
    '...##################...',
    '...........##...........',
    '...........##...........',
    '...........##...........',
    '.#........###........##.',
    '.######################.',
  ],
];

/** Boxes on the wall face of `side`: u along the wall (building-local), y up, `off` out from the wall's outer face. */
export function onWall(out: PropPart[], b: BuildingDef, side: Side) {
  const s = side[0] === '+' ? 1 : -1, alongX = side[1] === 'z', half = alongX ? b.d / 2 : b.w / 2;
  return (kind: PropPart['kind'], u0: number, u1: number, y0: number, y1: number, o0: number, o1: number) => {
    const u = (u0 + u1) / 2, o = half + (o0 + o1) / 2, su = u1 - u0, so = o1 - o0;
    out.push(alongX
      ? { kind, c: [b.x + u, (y0 + y1) / 2, b.z + s * o], s: [su, y1 - y0, so] }
      : { kind, c: [b.x + s * o, (y0 + y1) / 2, b.z + u], s: [so, y1 - y0, su] });
  };
}

type Put = ReturnType<typeof onWall>;
/** a leaf's back off the wall face: clear of the 勒脚 (world/building.ts PLINTH, 5 cm proud) so the two never fight */
const OFF = 0.055;

/** A door leaf u0..u1 standing on the wall face (its back at off o0): frame, two sunk panels, the glass light, handle at hu. */
function leaf(P: Put, u0: number, u1: number, h: number, o0: number, hu: number): void {
  const L = FRONT.leaf, r = L.rail, o1 = o0 + L.t, mid = h * 0.45;
  P('hallDoor', u0, u1, 0.02, h, o0, o1);
  // the panels sunk into the face (drawn just proud of it, darker: the shadow line of the moulding reads as the panel)
  P('hallPanel', u0 + r, u1 - r, 0.02 + r * 1.4, mid - r / 2, o1, o1 + 0.006);
  P('hallPanel', u0 + r, u1 - r, mid + r / 2, h - L.light[1] - L.light[0] - r, o1, o1 + 0.006);
  P('doorGlass', u0 + r, u1 - r, h - L.light[1] - L.light[0], h - L.light[1], o1, o1 + 0.008);
  P('frame', hu - 0.015, hu + 0.015, 0.95, 1.25, o1, o1 + 0.06);
}

export function hallFrontParts(c: CampusDef): PropPart[] {
  const out: PropPart[] = [];
  for (const b of c.buildings) {
    const e = porchOf(b);
    if (!e) continue;
    const P = onWall(out, b, e.side), C = canopyOf(e), F = FRONT, L = F.leaf;
    const U0 = e.at - e.width / 2 - C.side, U1 = e.at + e.width / 2 + C.side, top = e.height + C.gap;
    // ── 门廊: columns along the front edge (three bays), the cement floor
    for (const u of porchColumns(e)) {
      const o = C.out - F.col.inset, [bs, bh] = F.col.base;
      P('porchBase', u - bs / 2, u + bs / 2, 0, bh, o - bs / 2, o + bs / 2);
      P('porchCol', u - F.col.s / 2, u + F.col.s / 2, bh, top, o - F.col.s / 2, o + F.col.s / 2);
    }
    P('porch', U0, U1, 0, F.floor, 0, C.out);
    // the roof's underside whitewashed (the 雨棚 slab's own is the wall colour, a dark brown sheet over a 3.6 m deep 门廊)
    P('porchSoffit', U0, U1, top - 0.03, top - 0.005, 0, C.out);
    // ── the doorway's two leaves swung round flat onto the wall either side (hinged at the jambs)
    const hw = e.width / 2, lh = e.height - 0.04;
    // (four leaves, two a side: each pair folded back side by side, the handles on their free edges)
    for (const s of [-1, 1]) for (const k of [0, 1]) {
      const a = e.at + s * (hw + 0.04 + k * hw / 2), z = a + s * (hw / 2 - 0.01);
      leaf(P, Math.min(a, z), Math.max(a, z), lh, OFF, z - s * 0.12);
    }
    // ── the shut 双扇木门: 门套, two leaves meeting in the middle, a 搭扣 across them and its 挂锁
    const X = HALL.exit;
    for (const u of exitDoorsU()) {
      const a = u - X.w / 2, z = u + X.w / 2, cw = L.caseW, co = L.caseOut;
      P('doorCase', a - cw, a, 0, X.h + cw, 0, OFF + co);
      P('doorCase', z, z + cw, 0, X.h + cw, 0, OFF + co);
      P('doorCase', a, z, X.h, X.h + cw, 0, OFF + co);
      leaf(P, a + 0.01, u - 0.005, X.h - 0.01, OFF, u - 0.1);
      leaf(P, u + 0.005, z - 0.01, X.h - 0.01, OFF, u + 0.1);
      P('frame', u - 0.16, u + 0.16, 1.06, 1.1, OFF + L.t, OFF + L.t + 0.012);
      P('lock', u - 0.035, u + 0.035, 0.96, 1.05, OFF + L.t + 0.01, OFF + L.t + 0.04);
    }
    // ── 「礼堂」 over the 门廊 roof, one box per run of cells in a row; read from outside (on a -z wall that is towards -x)
    const W = F.word, n = HALL_WORDS[0].length, gw = n * W.cell, y1 = top + C.t + W.above + gw;
    const rd = e.side === '+z' || e.side === '-x' ? 1 : -1, left = -(HALL_WORDS.length * gw + (HALL_WORDS.length - 1) * W.gap) / 2;
    HALL_WORDS.forEach((rows, k) => rows.forEach((row, j) => {
      for (const m of row.matchAll(/#+/g)) {
        const p0 = left + k * (gw + W.gap) + (m.index ?? 0) * W.cell, p1 = p0 + m[0].length * W.cell, yt = y1 - j * W.cell;
        P('hallWord', e.at + Math.min(rd * p0, rd * p1), e.at + Math.max(rd * p0, rd * p1), yt - W.cell, yt, 0, W.out);
      }
    }));
  }
  return out;
}

/** The 门廊柱 (u along the wall): four along the front edge, three equal bays, the end ones inset from its ends. */
export function porchColumns(e: EntranceDef): number[] {
  const C = canopyOf(e), i = FRONT.col.inset, U0 = e.at - e.width / 2 - C.side + i, U1 = e.at + e.width / 2 + C.side - i;
  return [0, 1, 2, 3].map(k => U0 + (k * (U1 - U0)) / 3);
}

/** The 门廊柱 collide (base included). */
export function hallFrontColliders(c: CampusDef): AABB[] {
  return hallFrontParts(c).filter(q => q.kind === 'porchBase' || q.kind === 'porchCol')
    .map(q => box(q.c[0], q.c[2], q.s[0], q.s[2], q.c[1] + q.s[1] / 2));
}
