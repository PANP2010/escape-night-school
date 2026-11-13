import { WALL_T, type BuildingDef, type EntranceDef, type RoomDef } from '../../../../shared/campus/campus_schema.ts';
import { rectOf } from './rooms.ts';
import type { Face, FurnBox, Kind } from './classroom.ts';
import { seedOf } from './office.ts';
import { Rng } from '../core/rng.ts';
import { rectMinus, STAIR, stairPlan, type LBox, type LRect } from '../../../../shared/campus/stairs.ts';

/**
 * 礼堂 (docs/03_campus.md, data/campus/campus.json HALL): one storey the full height of the hall; the 舞台 across the
 * north end, the 观众席 the rest (both open rooms: the walls are the furniture's).
 * - `stage` 舞台: a deck HALL.deck high over the whole room; the 台口墙 HALL.apron behind its front edge (the 台唇 in
 *   front of it), open HALL.pros.open wide under a header with the 横幅 on it (red cloth, plain cream squares for its
 *   characters); the 大幕 drawn open and gathered in pleats at both sides under its 檐幕; two pairs of 侧幕 and their
 *   沿幕 behind; the 天幕 at the back; a 灯杆 of spotlights over the front; the 主席台 (a long table under green baize,
 *   chairs behind it) for 大会; a 讲台 with its microphone on the 台唇; in the west 侧台 a piano under a dust cloth and the
 *   合唱台阶 stacked up; east the 台仓's stair tower, its door down in a 楼梯坑 cut in the deck (steps up to the deck),
 *   and a shut 活门 at centre stage.
 * - `auditorium` 观众席: rows of 礼堂椅 (wooden back with a red pad, the seat folded up, steel 扶手 standards between)
 *   in three blocks with two aisles, a cross aisle at the front and at the back; the floor raked: each row a tier one
 *   step above the one in front (the aisles on the tiers), the last one's walkway ending in a railed riser wall over
 *   the back cross aisle (level with the south doors), steps down to it in both aisles; steps up to the 台唇 at both of its
 *   ends; pendant lamps hung on rods under the roof.
 * Building-local boxes; pure. The render goes through classroom.ts furnitureGeometry.
 */
export const HALL = {
  /** 台面 height; 台唇 depth (front edge to the 台口墙) */
  deck: 1.1, apron: 2.0,
  /** 台口墙 thickness, clear opening width, header bottom above the deck */
  pros: { t: 0.3, open: 16, head: 6.0 },
  /** steps up to the 台唇: count (n + 1 rises up to the deck), tread depth, width */
  steps: { n: 7, run: 0.3, w: 1.4 },
  /** 礼堂椅: row pitch, seat width, solid depth from the back's rear face; first row's back, last row's limit (z);
   *  aisles x ∈ ±[aisle[0], aisle[1]]; the rake: each row's tier rise over the one in front, the walkway behind the last
   *  row (its edge a riser wall with a rail), the steps down from it to the back cross aisle in each aisle (count, tread) */
  seat: { pitch: 1.05, w: 0.55, depth: 0.36, front: 3.6, back: -13.2, aisle: [6, 7.8] as [number, number],
    rise: 0.08, walk: 0.9, down: { n: 4, run: 0.3 } },
  /** pendant lamps: pitch, height of the shade above the floor */
  lamp: { pitch: 6, y: 7.2 },
  /** the shut 双扇木门 out of the back cross aisle under the 门廊 (world/hallfront.ts), one at the end of each aisle: clear width, height */
  exit: { w: 1.6, h: 2.5 },
};

/** The 礼堂's 门廊 entrance: a ground entrance with its own `canopy` (data/campus/campus.json HALL), its building has an 观众席. */
export const porchOf = (b: BuildingDef): EntranceDef | undefined =>
  b.floors.some(f => f.rooms?.some(r => r.kind === 'auditorium')) ? (b.entrances ?? []).find(e => e.canopy && (e.level ?? 1) === 1) : undefined;

/** The shut 双扇木门 in the 门廊's wall, one at the end of each aisle: centre u along the wall (= building-local x). */
export const exitDoorsU = (): number[] => {
  const am = (HALL.seat.aisle[0] + HALL.seat.aisle[1]) / 2;
  return [-am, am];
};

type Out = { render: FurnBox[]; solid: LBox[] };
type Put = (kind: Kind, q: LBox, skip?: Face[], more?: Partial<FurnBox>) => void;
const bx = (x0: number, x1: number, z0: number, z1: number, y0: number, y1: number): LBox => ({ x0, x1, z0, z1, y0, y1 });

export const isHallRoom = (r: RoomDef) => r.kind === 'auditorium' || r.kind === 'stage' || r.kind === 'understage';

/** Furniture of a 礼堂 room (building-local, y = its storey floor, h = its storey height). */
export function hallFurniture(b: BuildingDef, r: RoomDef, y: number, h: number): Out {
  return r.kind === 'stage' ? stageFurniture(b, r, y, h) : r.kind === 'understage' ? underFurniture(b, r, y, h) : seatsFurniture(b, r, y, h);
}

/** Where a walker stands in a 礼堂 room (building-local x, z): the front cross aisle; on the stage behind the 主席台. */
export function hallSpot(_b: BuildingDef, r: RoomDef): [number, number] {
  const R = rectOf(r);
  if (r.kind === 'understage') return [6, R.z0 + 2.2];
  return r.kind === 'stage' ? [0, R.z0 + HALL.apron + 4.2] : [0, (HALL.seat.front + HALL.seat.depth + R.z1) / 2];
}

/** The 观众席's rows, front (k = 0, on the floor) to back: each one's seat backs' rear face (z, building-local). */
export function rakeRows(): { zb: number; k: number }[] {
  const S = HALL.seat, out: { zb: number; k: number }[] = [];
  for (let k = 0, zb = S.front; zb >= S.back - 1e-6; k++, zb -= S.pitch) out.push({ zb, k });
  return out;
}

/** 活门 at centre stage behind the 主席台 chairs (x0, x1, z0, z1, building-local): shut; the 台仓's ladder stands under it. */
const TRAP = [-0.8, 0.8, 15.2, 16.4] as const;

/**
 * The way down to the 台仓 (data/campus HALL stairwell `under`): the stair tower standing in the east 侧台 (from the
 * 台仓 to the deck's underside: its door is at hall-floor level), and the 楼梯坑 cut in the deck in front of its door,
 * between the 台口墙 and the tower: a landing at the door, HALL.steps up west to the deck. Null without such a tower.
 */
export function underWay(b: BuildingDef, R: LRect): { tower: LRect; pit: LRect; foot: number } | null {
  const s = (b.stairwells ?? []).find(q => q.from < 1 && q.x - q.w / 2 >= R.x0 - 0.3 && q.z - q.d / 2 >= R.z0);
  if (!s) return null;
  const p = stairPlan(b, s, WALL_T), I = inner(b);
  if (p.doorSide !== '-z') return null;
  const foot = p.door[0] - 0.2, z0 = R.z0 + HALL.apron + HALL.pros.t;
  return { tower: p.rect, pit: { x0: foot - HALL.steps.n * HALL.steps.run, x1: I.x1, z0, z1: p.rect.z0 }, foot };
}

/** The outer walls' inner faces (both rooms run wall to wall). */
const inner = (b: BuildingDef) => ({ x0: -b.w / 2 + WALL_T, x1: b.w / 2 - WALL_T, z0: -b.d / 2 + WALL_T, z1: b.d / 2 - WALL_T });
const putter = (out: Out): Put => (kind, q, skip = ['bottom'], more = {}) => out.render.push({ ...q, kind, skip, ...more });

/**
 * 舞台: the deck over the whole room, the 台口墙 + header + 横幅, the 大幕 gathered at both sides, 檐幕, 侧幕 + 沿幕,
 * 天幕, the 灯杆, the 主席台 + chairs, a 讲台 on the 台唇, the 侧台's piano and 合唱台阶.
 */
function stageFurniture(b: BuildingDef, r: RoomDef, y: number, h: number): Out {
  const out: Out = { render: [], solid: [] }, put = putter(out), R = rectOf(r), I = inner(b);
  const rng = new Rng(seedOf(`${b.id}.${r.id}@${y.toFixed(1)}`));
  const solid = (q: LBox) => out.solid.push(q);
  const P = HALL.pros, dy = y + HALL.deck, top = y + h - 0.2, wz0 = R.z0 + HALL.apron, wz1 = wz0 + P.t, ox = P.open / 2;
  // the deck (its front face is the 台唇's), a dark nosing strip along the edge
  // (cut round the 台仓 stair tower and the 楼梯坑 in front of its door, see underWay)
  const way = underWay(b, R);
  let plate: LRect[] = [R];
  if (way) for (const hole of [way.tower, way.pit]) plate = plate.flatMap(q => rectMinus(q, hole));
  for (const q of plate) {
    const d = bx(q.x0, q.x1, q.z0, q.z1, y, dy);
    put('deck', d); solid(d);
    for (let z = R.z0 + 0.9; z < R.z1 - 0.1; z += 0.9) if (z > q.z0 + 0.05 && z < q.z1 - 0.05) put('stageSeam', bx(q.x0, q.x1, z - 0.006, z + 0.006, dy, dy + 0.002), ['bottom', '+x', '-x']);
  }
  put('stageEdge', bx(R.x0, R.x1, R.z0 - 0.01, R.z0 + 0.04, dy - 0.06, dy + 0.003), ['bottom', '+z']);
  if (way) {
    // the 楼梯坑's steps: up west from the landing at the door to the deck; a nosing on each, a rail along the open
    // side by the tower; the pit's floor is the hall's
    const T = HALL.steps, rise = HALL.deck / (T.n + 1);
    for (let k = 0; k < T.n; k++) {
      const x1 = way.foot - k * T.run, q = bx(x1 - T.run, x1, way.pit.z0, way.pit.z1, y, y + rise * (k + 1));
      put('deck', q); solid(q);
      put('stageEdge', bx(q.x1 - 0.03, q.x1 + 0.005, q.z0, q.z1, q.y1 - 0.03, q.y1 + 0.002), ['bottom']);
    }
    const rz = way.pit.z1, rx0 = way.pit.x0, rx1 = way.tower.x0;
    put('steel', bx(rx0, rx1, rz - 0.04, rz, dy + 0.86, dy + 0.9));
    put('steel', bx(rx0, rx0 + 0.04, rz - 0.04, rz, dy, dy + 0.86), ['bottom', 'top']);
    solid(bx(rx0, rx1, rz - 0.05, rz, dy, dy + 0.9));
    // the 活门 at centre stage (shut; a seam square with its ring pull), the one the 台仓's ladder stands under
    const [tx0, tx1, tz0, tz1] = TRAP;
    for (const q of [bx(tx0, tx1, tz0, tz0 + 0.03, dy, dy + 0.003), bx(tx0, tx1, tz1 - 0.03, tz1, dy, dy + 0.003),
      bx(tx0, tx0 + 0.03, tz0, tz1, dy, dy + 0.003), bx(tx1 - 0.03, tx1, tz0, tz1, dy, dy + 0.003)]) put('stageEdge', q, ['bottom']);
    put('steel', bx(tx1 - 0.25, tx1 - 0.13, (tz0 + tz1) / 2 - 0.02, (tz0 + tz1) / 2 + 0.02, dy, dy + 0.012), ['bottom']);
  }
  // 台口墙: the two piers, the header over the opening, the 横幅 on it (cream squares for its characters)
  for (const s of [-1, 1]) {
    const q = bx(...(s < 0 ? [I.x0, -ox] : [ox, I.x1]) as [number, number], wz0, wz1, dy, top + 0.2);
    put('plaster', q, ['bottom', 'top']); solid(q);
  }
  put('plaster', bx(-ox, ox, wz0, wz1, dy + P.head, top + 0.2), ['top']);
  const bw = 6.8, by0 = dy + P.head + 0.35, by1 = by0 + 0.8;
  put('banner', bx(-bw, bw, wz0 - 0.03, wz0, by0, by1), ['+z']);
  for (let k = 0; k < 12; k++) {
    const cx = -bw + 0.8 + k * ((2 * bw - 1.6) / 11);
    put('bannerText', bx(cx - 0.26, cx + 0.26, wz0 - 0.034, wz0 - 0.03, by0 + 0.14, by1 - 0.14), only('-z'));
  }
  // 檐幕 behind the header, the 大幕 drawn open: pleats gathered from each pier 2.6 m in, the folds alternating in depth
  put('drape', bx(-ox, ox, wz1, wz1 + 0.15, dy + P.head - 0.9, dy + P.head + 0.4), ['top']);
  for (const s of [-1, 1]) {
    const n = 12, pw = 2.6 / n;
    for (let k = 0; k < n; k++) {
      const a = ox - k * pw, dz = k % 2 ? 0.1 : 0, q = bx(...(s > 0 ? [a - pw - 0.02, a] : [-a, -a + pw + 0.02]) as [number, number], wz1 + 0.18 + dz, wz1 + 0.34 + dz, dy, dy + P.head - 0.85);
      put(k % 2 ? 'drapeB' : 'drape', q, ['bottom', 'top']);
    }
    solid(bx(...(s > 0 ? [ox - 2.6, ox] : [-ox, -ox + 2.6]) as [number, number], wz1 + 0.18, wz1 + 0.44, dy, dy + P.head - 0.85));
  }
  // 侧幕 (two pairs) with their 沿幕, the 天幕 at the back
  for (const z of [wz1 + 2.4, wz1 + 4.8]) {
    for (const s of [-1, 1]) {
      const q = bx(...(s > 0 ? [ox - 1.4, ox + 0.8] : [-ox - 0.8, -ox + 1.4]) as [number, number], z, z + 0.06, dy, dy + P.head + 0.4);
      put('drapeDark', q, ['bottom', 'top']); solid(q);
    }
    put('drapeDark', bx(-ox - 0.8, ox + 0.8, z, z + 0.06, dy + P.head - 0.6, dy + P.head + 0.6), ['top']);
  }
  const cz = R.z1 - 0.7;
  put('cyc', bx(-ox - 0.5, ox + 0.5, cz, cz + 0.05, dy, dy + P.head + 1.6), ['bottom', 'top']);
  solid(bx(-ox - 0.5, ox + 0.5, cz, cz + 0.05, dy, dy + 2));
  // 灯杆 over the front of the stage: a pipe on rods, spotlights hung off it pointing down-stage
  const lz = wz1 + 0.9, ly = dy + P.head - 0.3;
  put('steel', bx(-ox + 0.5, ox - 0.5, lz - 0.03, lz + 0.03, ly - 0.03, ly + 0.03), ['+x', '-x']);
  for (const x of [-ox + 1, 0, ox - 1]) put('steel', bx(x - 0.01, x + 0.01, lz - 0.01, lz + 0.01, ly + 0.03, top), ['top', 'bottom']);
  for (let x = -ox + 1.6; x < ox - 1.2; x += 1.6) {
    put('steel', bx(x - 0.015, x + 0.015, lz - 0.015, lz + 0.015, ly - 0.2, ly - 0.03), ['top', 'bottom']);
    put('spot', bx(x - 0.13, x + 0.13, lz - 0.2, lz + 0.16, ly - 0.46, ly - 0.2));
    put('ink', bx(x - 0.1, x + 0.1, lz - 0.203, lz - 0.2, ly - 0.43, ly - 0.23), only('-z'));
  }
  // 主席台: a long table under green baize (cloth to the floor on the front and ends), six chairs behind it
  const tz0 = wz1 + 3.0, tz1 = tz0 + 0.8, th = dy + 0.76, tw = 4.2;
  put('baize', bx(-tw, tw, tz0, tz1, th - 0.03, th), ['bottom']);
  put('baize', bx(-tw, tw, tz0, tz0 + 0.02, dy, th - 0.03), ['bottom', 'top', '+z']);
  for (const s of [-1, 1]) put('baize', bx(...(s > 0 ? [tw - 0.02, tw] : [-tw, -tw + 0.02]) as [number, number], tz0, tz1, dy, th - 0.03), ['bottom', 'top']);
  solid(bx(-tw, tw, tz0, tz1, dy, th));
  for (let k = 0; k < 7; k++) {
    const x = -3.6 + k * 1.2;
    // a 名牌 and a 茶杯 on the table in front of each seat, some seats' cups missing
    put('paper', bx(x - 0.15, x + 0.15, tz0 + 0.12, tz0 + 0.14, th, th + 0.1));
    if (rng.next() < 0.8) put('cup', bx(x + 0.22, x + 0.3, tz0 + 0.3, tz0 + 0.38, th, th + 0.1), ['bottom'], { rot: Math.PI / 4 });
    chair(put, solid, x, tz1 + 0.45, dy);
  }
  // 讲台 on the 台唇 west of the opening, its 话筒 on a gooseneck
  const lx = -ox - 2.2, lz0 = R.z0 + 0.6;
  const lect = bx(lx - 0.35, lx + 0.35, lz0, lz0 + 0.55, dy, dy + 1.1);
  put('lectern', lect); solid(lect);
  put('lectern', bx(lx - 0.4, lx + 0.4, lz0 - 0.02, lz0 + 0.58, dy + 1.1, dy + 1.14));
  put('steel', bx(lx - 0.01, lx + 0.01, lz0 + 0.1, lz0 + 0.12, dy + 1.14, dy + 1.42), ['bottom']);
  put('ink', bx(lx - 0.025, lx + 0.025, lz0 + 0.06, lz0 + 0.14, dy + 1.42, dy + 1.48));
  // west 侧台: a piano under its 防尘罩 against the 天幕's end, the 合唱台阶 (three tiers) pushed against the wall
  const px = -ox - 3.4, pz = R.z1 - 1.2;
  const piano = bx(px - 0.75, px + 0.75, pz - 0.3, pz + 0.3, dy, dy + 1.25);
  put('piano', piano); solid(piano);
  put('dustCloth', bx(px - 0.8, px + 0.8, pz - 0.35, pz + 0.35, dy + 0.75, dy + 1.28), ['bottom']);
  for (let k = 0; k < 3; k++) {
    const q = bx(I.x0 + 0.2, I.x0 + 3.2, R.z1 - 4.2 + k * 0.6, R.z1 - 3.6 + k * 0.6, dy, dy + 0.3 * (k + 1));
    put('riser', q); solid(q);
  }
  return out;
}

/** A plain wooden chair facing −z, its seat centred on (x, z). */
function chair(put: Put, solid: (q: LBox) => void, x: number, z: number, y: number): void {
  put('chair', bx(x - 0.21, x + 0.21, z - 0.21, z + 0.21, y + 0.41, y + 0.45));
  put('chair', bx(x - 0.21, x + 0.21, z + 0.19, z + 0.23, y + 0.45, y + 0.9), ['bottom']);
  for (const [ex, ez] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) put('steel', bx(x + ex * 0.18 - 0.015, x + ex * 0.18 + 0.015, z + ez * 0.18 - 0.015, z + ez * 0.18 + 0.015, y, y + 0.41), ['bottom', 'top']);
  solid(bx(x - 0.24, x + 0.24, z - 0.24, z + 0.24, y, y + 0.9));
}
const ALL: Face[] = ['+x', '-x', '+z', '-z', 'top', 'bottom'];
const only = (...keep: Face[]) => ALL.filter(q => !keep.includes(q));

/**
 * 观众席: 礼堂椅 rows in three blocks (the aisles between them, a wall aisle each side, the front and back cross aisles
 * clear); each seat a wooden back with a red pad on its front, the seat folded up against it, a steel 扶手 standard
 * between seats; a few seats left down (seeded). The steps up to the 台唇 in front of both aisles; pendant lamps.
 */
function seatsFurniture(b: BuildingDef, r: RoomDef, yf: number, h: number): Out {
  const y = yf, out: Out = { render: [], solid: [] }, put = putter(out), R = rectOf(r), I = inner(b), S = HALL.seat;
  const rng = new Rng(seedOf(`${b.id}.${r.id}@${y.toFixed(1)}`));
  const [a0, a1] = S.aisle, blocks: [number, number][] = [[-a0, a0], [a1, I.x1 - 0.85], [I.x0 + 0.85, -a1]];
  const rows = rakeRows();
  // the rake: row k's tier (k ≥ 1) from its seat backs to the row in front's, k rises up, wall to wall; the last one
  // runs on into the walkway; a dark nosing on each riser's edge
  for (const { zb, k } of rows) {
    if (k === 0) continue;
    const last = k === rows.length - 1, ty = y + k * S.rise, q = bx(I.x0, I.x1, last ? zb - S.walk : zb, zb + S.pitch, y, ty);
    put('rake', q, last ? ['bottom', '+x', '-x', '+z'] : ['bottom', '+x', '-x', '+z', '-z']); out.solid.push({ ...q, floor: true });
    // the riser facing the stage, a shade deeper than the tread (the last tier's back edge has its own, below)
    put('rakeRiser', bx(I.x0, I.x1, q.z1, q.z1 + 0.002, y + (k - 1) * S.rise, ty), ['bottom', 'top', '+x', '-x', '-z']);
    put('rakeEdge', bx(I.x0, I.x1, q.z1 - 0.04, q.z1 + 0.004, ty - 0.035, ty + 0.002), ['bottom', '+x', '-x']);
  }
  // the walkway's edge over the back cross aisle: a nosing, a rail on posts (broken at the aisles), the steps down
  const top = rows[rows.length - 1], wy = y + top.k * S.rise, wz = top.zb - S.walk;
  put('rakeEdge', bx(I.x0, I.x1, wz - 0.004, wz + 0.04, wy - 0.035, wy + 0.002), ['bottom', '+x', '-x']);
  for (const [x0, x1] of [[I.x0, -a1], [-a0, a0], [a1, I.x1]]) {
    put('steel', bx(x0, x1, wz + 0.03, wz + 0.07, wy + 0.86, wy + 0.9), ['+x', '-x']);
    for (let i = 0, m = Math.ceil((x1 - x0) / 1.5); i <= m; i++) {
      const px = Math.min(Math.max(x0 + i * ((x1 - x0) / m), x0 + 0.02), x1 - 0.02);
      put('steel', bx(px - 0.02, px + 0.02, wz + 0.03, wz + 0.07, wy, wy + 0.86), ['bottom', 'top']);
    }
    out.solid.push(bx(x0, x1, wz, wz + 0.1, y, wy + 0.9));
  }
  const D = S.down, drop = (wy - y) / (D.n + 1);
  for (const s of [-1, 1]) for (let k = 0; k < D.n; k++) {
    const z1 = wz - k * D.run, q = bx(s > 0 ? a0 : -a1, s > 0 ? a1 : -a0, z1 - D.run, z1, y, wy - drop * (k + 1));
    put('rake', q, ['bottom']); out.solid.push({ ...q, floor: true });
    put('rakeEdge', bx(q.x0, q.x1, q.z0 - 0.004, q.z0 + 0.04, q.y1 - 0.035, q.y1 + 0.002), ['bottom']);
  }
  for (const { zb, k } of rows) for (const [x0, x1] of blocks) {
    const n = Math.floor((x1 - x0) / S.w), u0 = (x0 + x1) / 2 - (n * S.w) / 2, y = yf + k * S.rise;
    for (let i = 0; i < n; i++) {
      const sx = u0 + i * S.w, down = rng.next() < 0.06;
      put('seatBack', bx(sx + 0.03, sx + S.w - 0.03, zb, zb + 0.05, y + 0.42, y + 0.93), ['top']);
      // the top rail, worn pale by hands: one light line per row from either end of the hall
      put('seatRail', bx(sx + 0.02, sx + S.w - 0.02, zb - 0.01, zb + 0.06, y + 0.93, y + 0.97));
      put('seatPad', bx(sx + 0.06, sx + S.w - 0.06, zb + 0.05, zb + 0.08, y + 0.5, y + 0.88), ['bottom', '-z']);
      // the seat: folded up against the back, or left down (its pad on top)
      if (down) put('seatPad', bx(sx + 0.05, sx + S.w - 0.05, zb + 0.08, zb + 0.5, y + 0.42, y + 0.47));
      else put('seatPad', bx(sx + 0.05, sx + S.w - 0.05, zb + 0.09, zb + 0.16, y + 0.32, y + 0.78), ['bottom', '-z']);
    }
    // 扶手 standards: one between every two seats and at both ends of the row (a leg plate, the arm on top)
    for (let i = 0; i <= n; i++) {
      const sx = u0 + i * S.w;
      put('steel', bx(sx - 0.02, sx + 0.02, zb + 0.02, zb + 0.3, y, y + 0.6), ['bottom', 'top']);
      put('seatArm', bx(sx - 0.03, sx + 0.03, zb, zb + 0.42, y + 0.6, y + 0.65));
    }
    out.solid.push(bx(u0 - 0.03, u0 + n * S.w + 0.03, zb, zb + S.depth, yf, y + 0.95));
  }
  // steps up to the 台唇 in front of both aisles (each rise ≤ the walker's step)
  const T = HALL.steps, rise = HALL.deck / (T.n + 1), am = (a0 + a1) / 2;
  for (const s of [-1, 1]) for (let k = 0; k < T.n; k++) {
    const z1 = R.z1 - k * T.run, q = bx(s * am - T.w / 2, s * am + T.w / 2, z1 - T.run, z1, y, y + rise * (T.n - k));
    put('deck', q); out.solid.push(q);
    put('stageEdge', bx(q.x0, q.x1, q.z0 - 0.005, q.z0 + 0.03, q.y1 - 0.03, q.y1 + 0.002), ['bottom']);
  }
  // the 双扇木门 at the end of each aisle, shut (the outside is world/hallfront.ts): 门套, two leaves, a 推杠 across each
  const e = porchOf(b);
  if (e?.side === '-z') for (const u of exitDoorsU()) {
    const X = HALL.exit, a = u - X.w / 2, z = u + X.w / 2, f = R.z0;
    put('hallCase', bx(a - 0.12, a, f, f + 0.07, y, y + X.h + 0.12), ['bottom', '-z']);
    put('hallCase', bx(z, z + 0.12, f, f + 0.07, y, y + X.h + 0.12), ['bottom', '-z']);
    put('hallCase', bx(a, z, f, f + 0.07, y + X.h, y + X.h + 0.12), ['-z']);
    for (const [l0, l1] of [[a + 0.01, u - 0.005], [u + 0.005, z - 0.01]]) {
      put('hallDoor', bx(l0, l1, f, f + 0.045, y + 0.02, y + X.h - 0.01), ['bottom', '-z']);
      put('steel', bx(l0 + 0.08, l1 - 0.08, f + 0.06, f + 0.1, y + 0.98, y + 1.04), ['-z']);
      for (const px of [l0 + 0.1, l1 - 0.1]) put('steel', bx(px - 0.02, px + 0.02, f + 0.045, f + 0.06, y + 0.97, y + 1.05), ['-z']);
    }
  }
  // pendant lamps on rods under the roof, over the seats
  const L = HALL.lamp, ly = y + L.y, ceil = y + h - 0.2;
  for (let x = -L.pitch; x <= L.pitch + 1e-6; x += L.pitch) for (let z = R.z1 - 3; z > R.z0 + 1; z -= L.pitch) {
    put('steel', bx(x - 0.01, x + 0.01, z - 0.01, z + 0.01, ly + 0.3, ceil), ['top', 'bottom']);
    put('lamp', bx(x - 0.28, x + 0.28, z - 0.28, z + 0.28, ly, ly + 0.3), ['bottom']);
    put('tube', bx(x - 0.24, x + 0.24, z - 0.24, z + 0.24, ly - 0.02, ly), ['top']);
  }
  return out;
}

/**
 * 台仓 under the stage (level -1, its ceiling the deck's slab): brick piers carrying the deck along the middle; old
 * 布景 flats (painted sky, a wall, trees) stood against the west wall, their raw backs out; stacks of 折叠椅 folded
 * against the north wall; 道具箱 stacked two high here and there, some under a dust cloth, one with a rolled-up
 * 横幅 on it; a 大鼓 on its side; the ladder up to the 活门; two bare bulbs on cords. The way from the stair door
 * west to the room's middle stays clear.
 */
/** 台仓 ceiling framing: the 大梁's depth; 搁栅 (along x) section, first row's z and pitch (between the TUBE rows) */
export const UNDER = { beam: 0.3, joist: { w: 0.08, h: 0.16, z0: 8.7, pitch: 0.6 } };

/** The 台仓's 布景 flats (building-local): each one's raw board, stood on the floor against the west wall, front to back. */
function underFlatBoards(R: LRect, y: number): LBox[] {
  return [0, 1, 2, 3].map(k => {
    const x0 = R.x0 + 0.05 + k * 0.09, z0 = R.z0 + 0.6 + k * 0.7;
    return bx(x0, x0 + 0.04, z0, z0 + 3.2, y, y + 2.0 + 0.1 * (k % 2));
  });
}
/** Painted faces of the flats, front to back (FLAT_TILES rows of public/art/flats.jpg): trees, sky, trees, the village wall
 *  (the last one, seen whole). */
export const FLAT_PAINT = [2, 0, 2, 1] as const;
export type V3 = [number, number, number];
/**
 * The flats' painted faces in a 台仓 room (building-local; y = its storey floor): a quad 5 mm proud of each board's +x
 * face (the raw edge showing 4 cm round it), corners bottom-left, bottom-right, top-right, top-left as seen from +x
 * (so +z is on the left), and the atlas row `tile` painted on it.
 */
export function underFlats(r: RoomDef, y: number): { q: V3[]; n: V3; tile: number }[] {
  return underFlatBoards(rectOf(r), y).map((q, k) => {
    const x = q.x1 + 0.005, z0 = q.z0 + 0.04, z1 = q.z1 - 0.04, y0 = q.y0 + 0.04, y1 = q.y1 - 0.04;
    return { q: [[x, y0, z1], [x, y0, z0], [x, y1, z0], [x, y1, z1]], n: [1, 0, 0], tile: FLAT_PAINT[k] };
  });
}

function underFurniture(b: BuildingDef, r: RoomDef, y: number, h: number): Out {
  const out: Out = { render: [], solid: [] }, put = putter(out), R = rectOf(r);
  const rng = new Rng(seedOf(`${b.id}.${r.id}@${y.toFixed(1)}`));
  const solid = (q: LBox) => out.solid.push(q), top = y + h - STAIR.slab;
  // piers along the stage's middle
  for (const x of [-9, -3, 3]) { const q = bx(x - 0.2, x + 0.2, 12.7, 13.1, y, top); put('plaster', q, ['bottom', 'top']); solid(q); }
  // the deck's underside: a 大梁 on the piers and 搁栅 across the room either side of it, laid between the ceiling's
  // 日光灯 rows (TUBE.pz = 4 × the 0.6 pitch, the tubes in the bays); broken round the 活门 and at the stair tower
  put('plaster', bx(R.x0, R.x1, 12.7, 13.1, top - UNDER.beam, top), ['top', '+x', '-x']);
  const tower = underWay(b, R)?.tower;
  for (let z = UNDER.joist.z0; z < R.z1 - 0.1; z += UNDER.joist.pitch) {
    if (z > 12.6 && z < 13.2) continue;
    const z0 = z - UNDER.joist.w / 2, z1 = z + UNDER.joist.w / 2, x1 = tower && z1 > tower.z0 ? tower.x0 : R.x1;
    const runs: [number, number][] = z1 > TRAP[2] && z0 < TRAP[3] ? [[R.x0, TRAP[0]], [TRAP[1], x1]] : [[R.x0, x1]];
    for (const [a, c] of runs) put('joist', bx(a, c, z0, z1, top - UNDER.joist.h, top), ['top']);
  }
  // 布景 flats against the west wall, front to back: the raw boards (their painted faces are the flats mesh, world/flats.ts)
  for (const f of underFlatBoards(R, y)) put('flatBack', f, ['bottom']);
  // the painted trees: a cut-out stood in front, its trunk and a lumpy crown
  { const x = R.x0 + 0.6, z = R.z0 + 6.8;
    put('flatBack', bx(x, x + 0.03, z - 0.08, z + 0.08, y, y + 1.2), ['bottom']);
    put('flatGreen', bx(x, x + 0.03, z - 0.7, z + 0.7, y + 1.1, y + 1.9), ['bottom']);
    put('flatGreen', bx(x, x + 0.03, z - 0.45, z + 0.45, y + 1.9, y + 2.25)); }
  solid(bx(R.x0, R.x0 + 0.7, R.z0 + 0.6, R.z0 + 7.5, y, y + 2.3));
  // 折叠椅 folded and stood in stacks against the north wall (each chair a frame, its seat flat against it)
  for (let sx = -12; sx < -3; sx += 1.6) {
    const n = 6 + Math.floor(rng.next() * 8);
    for (let i = 0; i < n; i++) {
      const z1 = R.z1 - 0.05 - i * 0.06, lean = 0.02 * i;
      put('steel', bx(sx, sx + 0.5, z1 - 0.025, z1, y, y + 0.92 - lean), ['bottom']);
      put('seatPad', bx(sx + 0.06, sx + 0.44, z1 - 0.045, z1 - 0.025, y + 0.4, y + 0.85 - lean), ['bottom', '+z']);
    }
    solid(bx(sx, sx + 0.5, R.z1 - 0.06 - n * 0.06, R.z1, y, y + 0.92));
  }
  // 道具箱: stacks of one or two, a paper label on each, some under a dust cloth
  const crate = (x: number, z: number, w: number, d: number, k: number) => {
    let y0 = y;
    for (let i = 0; i < k; i++) {
      const hh = 0.45 + 0.1 * rng.next(), q = bx(x - w / 2, x + w / 2, z - d / 2, z + d / 2, y0, y0 + hh);
      put('crate', q);
      put('crateLid', bx(q.x0 - 0.01, q.x1 + 0.01, q.z0 - 0.01, q.z1 + 0.01, q.y1 - 0.06, q.y1), ['bottom']);
      put('paper', bx(x - 0.12, x + 0.12, q.z0 - 0.012, q.z0 - 0.01, y0 + 0.15, y0 + 0.31), only('-z'));
      y0 += hh;
    }
    solid(bx(x - w / 2 - 0.01, x + w / 2 + 0.01, z - d / 2 - 0.01, z + d / 2 + 0.01, y, y0));
    return y0;
  };
  const crates: [number, number, number, number, number][] = [[-7.2, 9.0, 1.0, 0.7, 2], [-6.0, 9.1, 0.8, 0.6, 1], [-11.0, 9.2, 1.2, 0.8, 1],
    [-1.6, 12.9, 0.9, 0.6, 2], [5.4, 16.8, 1.0, 0.7, 2], [6.6, 16.9, 0.8, 0.6, 1], [8.2, 16.6, 1.2, 0.8, 2], [-6.5, 15.4, 0.9, 0.7, 1]];
  for (const [x, z, w, d, k] of crates) {
    const t = crate(x, z, w, d, k);
    if (x === 8.2) put('dustCloth', bx(x - w / 2 - 0.04, x + w / 2 + 0.04, z - d / 2 - 0.04, z + d / 2 + 0.04, t - 0.3, t + 0.02), ['bottom']);
    // the old 横幅 rolled up on a crate, longer than it
    if (x === -7.2) put('banner', bx(x - 1.1, x + 1.1, z - 0.09, z + 0.09, t, t + 0.18));
  }
  // a 大鼓 on its side by the piers, its red shell and pale heads
  { const x = -4.6, z = 11.6;
    put('drum', bx(x - 0.42, x + 0.42, z - 0.3, z + 0.3, y, y + 0.84));
    for (const s of [-1, 1]) put('dustCloth', bx(x - 0.36, x + 0.36, z + s * 0.3 - 0.005, z + s * 0.3 + 0.005, y + 0.06, y + 0.78), ['bottom']);
    solid(bx(x - 0.42, x + 0.42, z - 0.31, z + 0.31, y, y + 0.84)); }
  // the ladder up to the 活门: two steel stiles, rungs every 0.3
  { const [tx0, tx1, , tz1] = TRAP, z = tz1 - 0.15;
    for (const x of [tx0 + 0.45, tx1 - 0.45]) put('steel', bx(x - 0.02, x + 0.02, z - 0.02, z + 0.02, y, top), ['bottom', 'top']);
    for (let ry = y + 0.3; ry < top - 0.1; ry += 0.3) put('steel', bx(tx0 + 0.45, tx1 - 0.45, z - 0.012, z + 0.012, ry - 0.012, ry + 0.012), ['+x', '-x']);
    solid(bx(tx0 + 0.43, tx1 - 0.43, z - 0.03, z + 0.03, y, top));
    // the 活门's underside: a board square on its battens, a bolt
    put('flatBack', bx(tx0, tx1, TRAP[2], tz1, top - 0.03, top), ['top']); }
  // bare bulbs on cords from the deck's joists
  for (const [x, z] of [[-5, 12], [6, 10.2]] as [number, number][]) {
    put('ink', bx(x - 0.004, x + 0.004, z - 0.004, z + 0.004, top - 0.5, top), ['top', 'bottom']);
    put('tube', bx(x - 0.04, x + 0.04, z - 0.04, z + 0.04, top - 0.6, top - 0.5));
  }
  return out;
}
