import { floorStack, WALL_T, type BuildingDef, type RoomDef } from '../../../../shared/campus/campus_schema.ts';
import { PART, rectOf, storeyRooms } from './rooms.ts';
import { lampsAndFans, type Face, type FurnBox, type Kind } from './classroom.ts';
import { seedOf } from './office.ts';
import { Rng } from '../core/rng.ts';
import type { LBox } from '../../../../shared/campus/stairs.ts';

/**
 * 旧实验楼 (docs/03_campus.md, data/campus/campus.json LAB): 快拆了, three storeys off a 中走廊.
 * - `lab` 实验室: the 演示台 and 黑板 at the west end; four columns of 实验桌 (black 台面, a little sink and 水龙头 at the
 *   window end, a 煤气阀) in two rows either side of a middle aisle, 方凳 behind them, some turned up on the tables
 *   (nobody has had a lesson here for a while); at the east end a 通风橱 (化学) or a glass-front 仪器柜.
 * - `prep` 准备室: steel shelves round the walls, brown and clear 试剂瓶 on them, a 水池 counter. 标本室 (a `prep` named
 *   so): wooden 标本柜 instead, glass-front, rows of 标本罐 (old 福尔马林, the thing in it a dark shape), a 人体骨架 on its
 *   stand, a stuffed 猫头鹰, the window row bleached by the sun.
 * - `darkroom` 暗室: the window boarded over from inside, a 湿台 along it with three 显影盘 (显影 / 停影 / 定影) and a
 *   水池, a 干台 with the 放大机, the 安全灯 on the wall (red, lit by the shader: FurnBox.glow), a 晾片绳 across the
 *   room with prints clipped on it, the 遮光帘 on its rail inside the door, pulled aside.
 * - `storage` 杂物间 / 库房: world/storage.ts (junkFurniture / labStoreFurniture).
 * Building-local boxes; pure. The render goes through classroom.ts furnitureGeometry.
 */
export const LAB = {
  /** 实验桌: depth along x, length along z, height; column pitch, first column from the west wall; row gap (aisle) */
  table: { d: 0.7, l: 1.8, h: 0.8, pitch: 1.8, first: 2.6, aisle: 0.9 },
  /** 暗室 湿台 / 干台 height, 晾片绳 height */
  dark: { bench: 0.9, line: 2.05 },
};

type Out = { render: FurnBox[]; solid: LBox[] };
type Put = (kind: Kind, q: LBox, skip?: Face[], more?: Partial<FurnBox>) => void;
const bx = (x0: number, x1: number, z0: number, z1: number, y0: number, y1: number): LBox => ({ x0, x1, z0, z1, y0, y1 });
const ALL: Face[] = ['+x', '-x', '+z', '-z', 'top', 'bottom'];
const only = (...keep: Face[]) => ALL.filter(q => !keep.includes(q));

export const isLabRoom = (r: RoomDef, b?: BuildingDef) => r.kind === 'lab' || r.kind === 'prep' || r.kind === 'darkroom'
  || (b?.id === 'LAB' && r.kind === 'corridor' && r.id === 'lobby');

/** Furniture of a 旧实验楼 room (building-local, y = its storey floor, h = its storey height). */
export function labFurniture(b: BuildingDef, r: RoomDef, y: number, h: number): Out {
  const out: Out = { render: [], solid: [] }, rng = new Rng(seedOf(`${b.id}.${r.id}@${y.toFixed(1)}`));
  const put: Put = (kind, q, skip = ['bottom'], more = {}) => out.render.push({ ...q, kind, skip, ...more });
  const I = inner(b, r);
  if (r.kind === 'lab') labRoom(put, out.solid, I, r, y, rng);
  else if (r.kind === 'prep') prepRoom(put, out.solid, I, r, y, rng);
  else if (r.kind === 'darkroom') darkRoom(put, out.solid, I, r, y, rng);
  else lobbyRoom(put, out.solid, I, y);
  if (r.kind !== 'darkroom') out.render.push(...lampsAndFans(r, y, h, r.kind === 'lab' ? 2 : 0).out);
  return out;
}

/** Where a walker stands in one: just inside its (first) door. */
export function labSpot(b: BuildingDef, r: RoomDef): [number, number] {
  const d = r.doors?.[0];
  if (!d) return [r.x, r.z];
  const I = inner(b, r), s = d.side[0] === '+' ? 1 : -1;
  return d.side[1] === 'z' ? [r.x + d.at, (s > 0 ? I.z1 : I.z0) - s * 1.0] : [(s > 0 ? I.x1 : I.x0) - s * 1.0, r.z + d.at];
}

type Rect = { x0: number; x1: number; z0: number; z1: number };
/** The usable rect of a room: the outer wall's inner face, or PART.t / 2 off a shared edge. */
function inner(b: BuildingDef, r: RoomDef): Rect {
  const R = rectOf(r), t = PART.t / 2, hw = b.w / 2 - WALL_T, hd = b.d / 2 - WALL_T, e = 0.05;
  return {
    x0: Math.abs(R.x0 + hw) < e ? R.x0 : R.x0 + t, x1: Math.abs(R.x1 - hw) < e ? R.x1 : R.x1 - t,
    z0: Math.abs(R.z0 + hd) < e ? R.z0 : R.z0 + t, z1: Math.abs(R.z1 - hd) < e ? R.z1 : R.z1 - t,
  };
}
/** The window (outer) wall's z and the sign pointing at it from the corridor: rooms here face the corridor across z. */
const windowSide = (r: RoomDef, I: Rect) => (r.z < 0 ? { wz: I.z0, s: -1 } : { wz: I.z1, s: 1 });

/** 方凳 at (x, z), or turned up on a table top at height `y`. */
function stool(put: Put, x: number, z: number, y: number, up: boolean): void {
  const S = 0.15, top = 0.45;
  if (!up) {
    put('labStool', bx(x - S, x + S, z - S, z + S, y + top - 0.03, y + top));
    for (const [lx, lz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) put('steel', bx(x + lx * (S - 0.03) - 0.015, x + lx * (S - 0.03) + 0.015, z + lz * (S - 0.03) - 0.015, z + lz * (S - 0.03) + 0.015, y, y + top - 0.03), ['bottom', 'top']);
    return;
  }
  put('labStool', bx(x - S, x + S, z - S, z + S, y, y + 0.03), ['bottom']);
  for (const [lx, lz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) put('steel', bx(x + lx * (S - 0.03) - 0.015, x + lx * (S - 0.03) + 0.015, z + lz * (S - 0.03) - 0.015, z + lz * (S - 0.03) + 0.015, y + 0.03, y + top), ['bottom']);
}

/** 实验室: 演示台 + 黑板 at the west end, 实验桌 in columns facing it, the 通风橱 / 仪器柜 at the east end. */
function labRoom(put: Put, solid: LBox[], I: Rect, r: RoomDef, y: number, rng: Rng): void {
  const T = LAB.table, { s } = windowSide(r, I), zc = (I.z0 + I.z1) / 2;
  // 黑板 on the west wall, 演示台 in front of it (a sink at its window end)
  put('frame', bx(I.x0, I.x0 + 0.04, zc - 1.65, zc + 1.65, y + 0.9, y + 2.2), ['bottom', '-x']);
  put('board', bx(I.x0 + 0.04, I.x0 + 0.05, zc - 1.6, zc + 1.6, y + 0.95, y + 2.15), only('+x'));
  const dx0 = I.x0 + 0.9, dx1 = dx0 + 0.75;
  put('labBody', bx(dx0, dx1, zc - 1.3, zc + 1.3, y, y + 0.86));
  put('labTop', bx(dx0 - 0.03, dx1 + 0.03, zc - 1.33, zc + 1.33, y + 0.86, y + 0.9));
  put('sink', bx(dx0 + 0.15, dx1 - 0.15, zc + s * 0.75 - 0.22, zc + s * 0.75 + 0.22, y + 0.9, y + 0.905), ['bottom']);
  tap(put, dx0 + 0.08, zc + s * 0.75, y + 0.9, '+x');
  solid.push(bx(dx0 - 0.03, dx1 + 0.03, zc - 1.33, zc + 1.33, y, y + 0.9));
  // 实验桌: two rows (window side, corridor side) each column; skip a place a corridor door opens onto
  const doors = (r.doors ?? []).map(d => r.x + d.at);
  const rows: [number, number][] = [[zc - T.aisle / 2 - T.l, zc - T.aisle / 2], [zc + T.aisle / 2, zc + T.aisle / 2 + T.l]];
  const chem = r.name.includes('化学');
  for (let x = I.x0 + T.first; x + T.d + 0.75 <= I.x1; x += T.pitch) for (const [z0, z1] of rows) {
    const toWin = (z0 + z1) / 2 > zc === s > 0;
    if (!toWin && doors.some(dx => dx > x - 0.75 && dx < x + T.d + 1.1)) continue;
    put('labBody', bx(x + 0.04, x + T.d - 0.04, z0 + 0.04, z1 - 0.04, y, y + T.h - 0.04));
    put('mouth', bx(x + T.d - 0.04, x + T.d - 0.035, z0 + 0.15, z1 - 0.15, y + 0.45, y + 0.66), only('+x'));
    put('labTop', bx(x, x + T.d, z0, z1, y + T.h - 0.04, y + T.h));
    // the window end: a little sink and its 水龙头, the 煤气阀 at the other end (化学)
    const ez = toWin ? (s > 0 ? z1 - 0.25 : z0 + 0.25) : (s > 0 ? z0 + 0.25 : z1 - 0.25);
    if (toWin) { put('sink', bx(x + 0.2, x + 0.5, ez - 0.14, ez + 0.14, y + T.h, y + T.h + 0.004), ['bottom']); tap(put, x + 0.1, ez, y + T.h, '+x'); }
    else if (chem) put('steel', bx(x + 0.08, x + 0.14, ez - 0.03, ez + 0.03, y + T.h, y + T.h + 0.1));
    solid.push(bx(x, x + T.d, z0, z1, y, y + T.h));
    // 方凳 behind it, two to a table; one in three turned up on the top
    for (const k of [0.25, 0.75]) {
      const z = z0 + (z1 - z0) * k + rng.range(-0.06, 0.06);
      if (rng.next() < 0.33) stool(put, x + T.d / 2 + rng.range(-0.08, 0.08), z, y + T.h, true);
      else if (rng.next() < 0.85) { const sx = x + T.d + 0.35 + rng.range(-0.05, 0.1); stool(put, sx, z, y, false); solid.push(bx(sx - 0.15, sx + 0.15, z - 0.15, z + 0.15, y, y + 0.45)); }
    }
  }
  // the east end: a 通风橱 (化学) or a glass-front 仪器柜, on the window side
  const ez0 = s > 0 ? I.z1 - 1.6 : I.z0, ez1 = s > 0 ? I.z1 : I.z0 + 1.6, hx0 = I.x1 - 0.8;
  if (chem) {
    put('labBody', bx(hx0, I.x1, ez0, ez1, y, y + 0.85));
    put('labTop', bx(hx0 - 0.02, I.x1, ez0, ez1, y + 0.85, y + 0.89));
    put('hood', bx(hx0 + 0.15, I.x1, ez0, ez0 + 0.06, y + 0.89, y + 2.1), ['bottom']);
    put('hood', bx(hx0 + 0.15, I.x1, ez1 - 0.06, ez1, y + 0.89, y + 2.1), ['bottom']);
    put('hood', bx(hx0 + 0.15, I.x1, ez0, ez1, y + 1.8, y + 2.3));
    put('hoodGlass', bx(hx0 + 0.15, hx0 + 0.17, ez0 + 0.06, ez1 - 0.06, y + 1.3, y + 1.8), ['bottom', 'top']);
    put('steel', bx(I.x1 - 0.3, I.x1 - 0.1, (ez0 + ez1) / 2 - 0.1, (ez0 + ez1) / 2 + 0.1, y + 2.3, y + 3.3), ['bottom']);
    for (let z = ez0 + 0.3; z < ez1 - 0.2; z += 0.28) put(rng.next() < 0.5 ? 'reagentB' : 'reagentC', bx(hx0 + 0.4, hx0 + 0.5, z - 0.05, z + 0.05, y + 0.89, y + 0.89 + rng.range(0.14, 0.24)));
  } else {
    put('labBody', bx(hx0 + 0.3, I.x1, ez0, ez1, y, y + 0.9));
    put('labBody', bx(hx0 + 0.3, I.x1, ez0, ez1, y + 0.9, y + 2.0), ['bottom', '-x']);
    put('hoodGlass', bx(hx0 + 0.29, hx0 + 0.3, ez0 + 0.05, ez1 - 0.05, y + 0.95, y + 1.95), ['bottom', 'top', '+x']);
    for (const lv of [1.0, 1.48]) for (let z = ez0 + 0.15; z < ez1 - 0.15; z += rng.range(0.2, 0.35)) put(rng.next() < 0.4 ? 'brass' : 'steel', bx(hx0 + 0.5, hx0 + 0.62, z, z + 0.1, y + lv, y + lv + rng.range(0.1, 0.35)));
  }
  solid.push(bx(hx0, I.x1, ez0, ez1, y, y + 2.3));
}

/**
 * 门厅 (the entrance on -z, the 走廊 on +z): a 楼层示意牌 on the east wall (a cream plate, a row of room tags per storey,
 * the 1F row picked out in red), a 告示栏 on the west wall (blue-grey board in a wood frame, a few notices pinned to it,
 * the 安全须知 with its red heading), a 擦鞋垫 inside the door and a blue 垃圾桶 in the corner by the 走廊.
 */
function lobbyRoom(put: Put, solid: LBox[], I: Rect, y: number): void {
  // 楼层示意牌: plate in a dark frame, 3 storey rows of 4 tags, the storey number at the left of each row
  const ex = I.x1, mz0 = I.z0 + 2.0, mz1 = mz0 + 1.1, m0 = y + 1.25, m1 = y + 1.95;
  put('frame', bx(ex - 0.025, ex, mz0, mz1, m0, m1), ['bottom', '+x']);
  put('paper', bx(ex - 0.03, ex - 0.025, mz0 + 0.04, mz1 - 0.04, m0 + 0.04, m1 - 0.04), only('-x'));
  put('ink', bx(ex - 0.034, ex - 0.03, mz0 + 0.3, mz1 - 0.3, m1 - 0.1, m1 - 0.075), only('-x'));
  for (let k = 0; k < 3; k++) {
    const ty = m1 - 0.24 - k * 0.16;
    put(k === 2 ? 'coverR' : 'ink', bx(ex - 0.034, ex - 0.03, mz1 - 0.16, mz1 - 0.08, ty - 0.05, ty + 0.05), only('-x'));
    for (let j = 0; j < 4; j++) put('ink', bx(ex - 0.034, ex - 0.03, mz1 - 0.3 - j * 0.2, mz1 - 0.3 - j * 0.2 + 0.14, ty - 0.006, ty + 0.006), only('-x'));
  }
  // 告示栏: board in a wood frame, notices pinned on it
  const wx = I.x0, bz0 = I.z0 + 1.7, bz1 = bz0 + 1.6, b0 = y + 1.05, b1 = y + 2.0;
  put('frame', bx(wx, wx + 0.04, bz0, bz1, b0, b1), ['bottom', '-x']);
  put('board', bx(wx + 0.04, wx + 0.045, bz0 + 0.05, bz1 - 0.05, b0 + 0.05, b1 - 0.05), only('+x'));
  const sheets: [number, number, number, number, boolean][] = [[0.12, 0.62, 0.15, 0.85, true], [0.75, 1.1, 0.4, 0.82, false], [0.78, 1.15, 0.1, 0.34, false], [1.22, 1.5, 0.22, 0.7, false]];
  for (const [a0, a1, h0, h1, head] of sheets) {
    put('paper', bx(wx + 0.045, wx + 0.05, bz0 + a0, bz0 + a1, b0 + h0, b0 + h1), only('+x'));
    if (head) put('coverR', bx(wx + 0.05, wx + 0.053, bz0 + a0 + 0.03, bz0 + a1 - 0.03, b0 + h1 - 0.12, b0 + h1 - 0.04), only('+x'));
    let n = 0;
    for (let ly = b0 + h1 - (head ? 0.19 : 0.07); ly > b0 + h0 + 0.04; ly -= 0.052, n++) {
      const short = n % 4 === 3, w = (a1 - a0 - 0.08) * (short ? 0.55 : 1);
      put('ink', bx(wx + 0.05, wx + 0.052, bz0 + a0 + 0.04, bz0 + a0 + 0.04 + w, ly - 0.004, ly + 0.004), only('+x'));
    }
  }
  // 擦鞋垫 inside the door, a 垃圾桶 in the east corner by the 走廊
  put('mouth', bx(-0.7, 0.7, I.z0 + 0.15, I.z0 + 0.75, y, y + 0.012));
  const tx = I.x1 - 0.25, tz = I.z1 - 0.5;
  put('hoopBase', bx(tx - 0.17, tx + 0.17, tz - 0.17, tz + 0.17, y, y + 0.55), ['bottom', 'top']);
  put('ink', bx(tx - 0.185, tx + 0.185, tz - 0.185, tz + 0.185, y + 0.55, y + 0.58), ['bottom']);
  solid.push(bx(tx - 0.19, tx + 0.19, tz - 0.19, tz + 0.19, y, y + 0.58));
}

/** 水龙头 at (x, z) on a top at y: a post and a spout turned toward `to`. */
function tap(put: Put, x: number, z: number, y: number, to: '+x' | '-x'): void {
  const d = to === '+x' ? 1 : -1;
  put('steel', bx(x - 0.015, x + 0.015, z - 0.015, z + 0.015, y, y + 0.3), ['bottom']);
  put('steel', bx(Math.min(x, x + d * 0.14), Math.max(x, x + d * 0.14), z - 0.012, z + 0.012, y + 0.28, y + 0.3));
}

/** A steel shelf (x0..x1 × z0..z1) four boards high, bottles / jars (`fill` picks the kind) on the upper three. */
function shelf(put: Put, solid: LBox[], q: Rect, y: number, rng: Rng, fill: () => Kind): void {
  const alongX = q.x1 - q.x0 > q.z1 - q.z0;
  for (const lv of [0.12, 0.62, 1.12, 1.62]) put('steel', bx(q.x0, q.x1, q.z0, q.z1, y + lv, y + lv + 0.02));
  for (const [ex, ez] of [[q.x0, q.z0], [q.x0, q.z1], [q.x1, q.z0], [q.x1, q.z1]]) put('steel', bx(ex - 0.02, ex + 0.02, ez - 0.02, ez + 0.02, y, y + 1.9), ['bottom']);
  const a0 = alongX ? q.x0 : q.z0, a1 = alongX ? q.x1 : q.z1, c = alongX ? (q.z0 + q.z1) / 2 : (q.x0 + q.x1) / 2;
  for (const lv of [0.64, 1.14, 1.64]) for (let a = a0 + 0.08; a < a1 - 0.12; a += rng.range(0.13, 0.22)) {
    if (rng.next() < 0.22) continue;
    const w = rng.range(0.035, 0.06), hh = rng.range(0.12, 0.26), o = rng.range(-0.06, 0.06);
    put(fill(), alongX ? bx(a, a + 2 * w, c + o - w, c + o + w, y + lv + 0.02, y + lv + 0.02 + hh) : bx(c + o - w, c + o + w, a, a + 2 * w, y + lv + 0.02, y + lv + 0.02 + hh));
  }
  solid.push(bx(q.x0, q.x1, q.z0, q.z1, y, y + 1.9));
}

/** 准备室 / 标本室: shelves along the window wall and the far end wall, a 水池 counter on the near end wall. */
function prepRoom(put: Put, solid: LBox[], I: Rect, r: RoomDef, y: number, rng: Rng): void {
  if (r.name.includes('标本')) return specimenRoom(put, solid, I, r, y, rng);
  const { wz, s } = windowSide(r, I);
  const fill = (): Kind => (['reagentB', 'reagentB', 'reagentC', 'reagentW'] as Kind[])[Math.floor(rng.next() * 4)];
  const doorX = r.x + (r.doors?.[0]?.at ?? 0), far = doorX < r.x ? 1 : -1;
  const sz: [number, number] = s > 0 ? [wz - 0.4, wz - 0.02] : [wz + 0.02, wz + 0.4];
  shelf(put, solid, { x0: I.x0 + 0.05, x1: I.x1 - 0.05, z0: sz[0], z1: sz[1] }, y, rng, fill);
  const ex = far > 0 ? [I.x1 - 0.4, I.x1 - 0.02] : [I.x0 + 0.02, I.x0 + 0.4];
  const zr: [number, number] = s > 0 ? [I.z0 + 0.9, wz - 0.5] : [wz + 0.5, I.z1 - 0.9];
  shelf(put, solid, { x0: ex[0], x1: ex[1], z0: zr[0], z1: zr[1] }, y, rng, fill);
  // the 水池 counter against the near end wall
  const nx: [number, number] = far > 0 ? [I.x0, I.x0 + 0.6] : [I.x1 - 0.6, I.x1];
  put('labBody', bx(...nx, ...zr, y, y + 0.86));
  put('labTop', bx(...nx, ...zr, y + 0.86, y + 0.9));
  const mz = (zr[0] + zr[1]) / 2;
  put('sink', bx(nx[0] + 0.12, nx[1] - 0.12, mz - 0.25, mz + 0.25, y + 0.9, y + 0.905), ['bottom']);
  tap(put, far > 0 ? I.x0 + 0.06 : I.x1 - 0.06, mz, y + 0.9, far > 0 ? '+x' : '-x');
  solid.push(bx(...nx, ...zr, y, y + 0.9));
}

type Wall = Exclude<Face, 'top' | 'bottom'>;
/** A plate t thick standing proud of face `f` (its plane at p), a0..a1 along that wall, y0..y1. */
function plate(f: Wall, p: number, a0: number, a1: number, y0: number, y1: number, t = 0.002): LBox {
  const g = f[0] === '+' ? 1 : -1, q0 = Math.min(p, p + g * t), q1 = Math.max(p, p + g * t);
  return f[1] === 'x' ? bx(q0, q1, a0, a1, y0, y1) : bx(a0, a1, q0, q1, y0, y1);
}

/**
 * 标本罐 at (x, z) on y, half-width w, h tall, face `f` to the room: an octagon (reads round) of old 福尔马林 to 0.8 h,
 * the glass over it, the 蜡封 (one in four a black screw lid); on the face the thing in it as a dark plate (蛙 legs
 * splayed / a coiled 蛇 / an 器官 and its vessel), a glint up one side, often a paper label. `faded`: a window-row jar,
 * years in the sun: paler liquid, the thing in it bleached, the wax gone pink-brown.
 */
function jar(put: Put, x: number, z: number, y: number, w: number, h: number, f: Wall, rng: Rng, faded: boolean): void {
  const O = 0.42, lq = y + h * 0.8, gl = y + h * 0.92, c = w * 1.06;
  put(faded ? 'formalinPale' : 'formalin', bx(x - w, x + w, z - w, z + w, y, lq), ['bottom', 'top'], { oct: O });
  put('jarGlass', bx(x - w, x + w, z - w, z + w, lq, gl), ['bottom', 'top'], { oct: O });
  put(rng.next() < 0.25 ? 'jarLid' : faded ? 'waxPale' : 'wax', bx(x - c, x + c, z - c, z + c, gl, y + h), ['bottom'], { oct: O });
  // plates on the face (its flat part is ±0.58 w wide): u across it in units of w, v up it in units of h
  const g = f[0] === '+' ? 1 : -1, p = (f[1] === 'x' ? x : z) + g * w, m = f[1] === 'x' ? z : x;
  const on = (k: Kind, u0: number, u1: number, v0: number, v1: number, ang = 0) =>
    put(k, plate(f, p, m + u0 * w, m + u1 * w, y + v0 * h, y + v1 * h), only(f), ang ? { spin: { axis: f[1] === 'x' ? 'x' : 'z', ang } } : {});
  const sp: Kind = faded ? 'specimenPale' : 'specimen', t = rng.next();
  if (t < 0.38) {
    // 蛙 hung head up, belly to the glass: the body, the wide flat head and snout; each side the arm slanting down and
    // out, the long hind leg folded in a Z (thigh down and out, shin back in), the webbed foot spread at the bottom
    on(sp, -0.22, 0.22, 0.42, 0.64); on(sp, -0.2, 0.2, 0.64, 0.72); on(sp, -0.12, 0.12, 0.72, 0.76);
    for (const d of [-1, 1]) {
      const a = (u0: number, u1: number, v0: number, v1: number, ang = 0) => on(sp, d > 0 ? u0 : -u1, d > 0 ? u1 : -u0, v0, v1, d * ang);
      a(0.18, 0.4, 0.55, 0.59, -0.6); a(0.14, 0.46, 0.38, 0.44, -0.7); a(0.14, 0.46, 0.24, 0.3, 0.7); a(0.08, 0.36, 0.15, 0.19);
    }
  } else if (t < 0.65) {
    // 蛇 coiled round the jar: the turns seen side-on, slanting like a spring, the head raised on top
    for (let i = 0; i < 4; i++) { const v = 0.2 + i * 0.12; on(sp, -0.4, 0.4, v, v + 0.07, 0.22); }
    on(sp, -0.1, 0.14, 0.72, 0.78);
  } else {
    // an 器官: a lump (stacked so the plates never overlap) and the cut vessel on top
    on(sp, -0.24, 0.24, 0.22, 0.3); on(sp, -0.36, 0.36, 0.3, 0.58); on(sp, -0.24, 0.24, 0.58, 0.66); on(sp, -0.05, 0.07, 0.66, 0.76);
  }
  on('jarHi', 0.44, 0.52, 0.12, 0.76);
  if (rng.next() < 0.55) on('paper', -0.3, 0.3, 0.05, 0.16);
}

/** A row of 标本罐 along a0..a1 (along x if `alongX`, else z), centred c across, on y, none taller than hmax. */
function jarRow(put: Put, rng: Rng, alongX: boolean, a0: number, a1: number, c: number, y: number, hmax: number, f: Wall, faded: boolean): void {
  for (let a = a0 + 0.02; ;) {
    const t = rng.next(), w = t < 0.3 ? rng.range(0.08, 0.1) : t < 0.75 ? rng.range(0.06, 0.075) : rng.range(0.045, 0.055);
    const h = Math.min(hmax, w * rng.range(3.4, 4.2)), m = a + w * 1.06, o = rng.range(-0.03, 0.03);
    if (m + w * 1.06 > a1 - 0.02) break;
    if (rng.next() > 0.12) jar(put, alongX ? m : c + o, alongX ? c + o : m, y, w, h, f, rng, faded);
    a = m + w * 1.06 + rng.range(0.025, 0.07);
  }
}

/**
 * Boxes in a figure's own frame at (x, z) on y, turned to face `f`: u across it, v up, d forward (toward f). `B` a part
 * (its bottom skipped), `F` a plate on its front face at d, `tilt` the spin that slants a part in its own u-v plane
 * (ang > 0 drops the -u end).
 */
function figure(put: Put, x: number, z: number, y: number, f: Wall) {
  const g = f[0] === '+' ? 1 : -1, alongX = f[1] === 'x';
  const box = (u0: number, u1: number, v0: number, v1: number, d0: number, d1: number): LBox => {
    const a = alongX ? x : z, c = alongX ? z : x, p0 = Math.min(a + g * d0, a + g * d1), p1 = Math.max(a + g * d0, a + g * d1);
    return alongX ? bx(p0, p1, c + u0, c + u1, y + v0, y + v1) : bx(c + u0, c + u1, p0, p1, y + v0, y + v1);
  };
  return {
    B: (k: Kind, u0: number, u1: number, v0: number, v1: number, d0: number, d1: number, more: Partial<FurnBox> = {}) => put(k, box(u0, u1, v0, v1, d0, d1), ['bottom'], more),
    F: (k: Kind, u0: number, u1: number, v0: number, v1: number, d: number) => put(k, box(u0, u1, v0, v1, d, d + 0.003), only(f)),
    tilt: (ang: number): Partial<FurnBox> => ({ spin: { axis: alongX ? 'x' : 'z', ang } }),
  };
}

/**
 * 人体骨架 (the plastic teaching model, life size, gone ivory) hung on its stand at (x, z), facing `f`: the pole up
 * behind the spine on a steel cross with castors, the skull on its hook, ribs slanting down from the 胸骨.
 */
function skeleton(put: Put, x: number, z: number, y: number, f: Wall): void {
  const { B, F, tilt } = figure(put, x, z, y, f);
  B('steel', -0.24, 0.24, 0.03, 0.06, -0.14, -0.08); B('steel', -0.03, 0.03, 0.03, 0.06, -0.32, 0.12);
  for (const [u, d] of [[-0.22, -0.11], [0.22, -0.11], [0, -0.3], [0, 0.1]]) B('rubber', u - 0.025, u + 0.025, 0, 0.03, d - 0.025, d + 0.025);
  B('steel', -0.015, 0.015, 0.06, 1.49, -0.13, -0.1); B('steel', -0.012, 0.012, 1.46, 1.49, -0.1, -0.05); B('steel', -0.012, 0.012, 0.9, 0.93, -0.1, -0.06);
  // skull: cranium, the sockets and the nose, the jaw
  B('bone', -0.08, 0.08, 1.5, 1.72, -0.09, 0.1, { oct: 0.55 });
  for (const u of [-1, 1]) F('specCabIn', u > 0 ? 0.012 : -0.048, u > 0 ? 0.048 : -0.012, 1.58, 1.625, 0.1);
  F('specCabIn', -0.011, 0.011, 1.535, 1.565, 0.1);
  B('bone', -0.055, 0.055, 1.455, 1.5, -0.02, 0.08, { oct: 0.4 }); F('specCabIn', -0.03, 0.03, 1.488, 1.494, 0.08);
  // neck, shoulders, spine, 胸骨 and six ribs a side
  B('bone', -0.02, 0.02, 1.41, 1.455, -0.04, 0.0); B('bone', -0.19, 0.19, 1.38, 1.41, -0.01, 0.03); B('bone', -0.022, 0.022, 0.96, 1.38, -0.07, -0.03);
  B('bone', -0.02, 0.02, 1.12, 1.36, 0.1, 0.125);
  [0.1, 0.125, 0.14, 0.148, 0.145, 0.135].forEach((hw, i) => {
    const v = 1.35 - i * 0.052;
    for (const u of [-1, 1]) {
      const lo = u > 0 ? 0.03 : -hw, hi = u > 0 ? hw : -0.03;
      B('bone', lo, hi, v - 0.016, v, 0.09, 0.11, tilt(-u * (0.3 + i * 0.04)));
      B('bone', u > 0 ? hw - 0.018 : -hw, u > 0 ? hw : -hw + 0.018, v - 0.012, v + 0.006, -0.05, 0.09);
    }
  });
  // pelvis: the two hip wings, 骶骨, the pubic bar in front
  B('bone', -0.15, -0.04, 0.88, 0.99, -0.05, 0.06, tilt(-0.25)); B('bone', 0.04, 0.15, 0.88, 0.99, -0.05, 0.06, tilt(0.25));
  B('bone', -0.04, 0.04, 0.86, 0.96, -0.07, -0.02); B('bone', -0.08, 0.08, 0.84, 0.87, 0.03, 0.07);
  for (const u of [-1, 1]) {
    const a = (u0: number, u1: number) => (u > 0 ? [u0, u1] : [-u1, -u0]) as [number, number];
    // arm hanging, a little bent: 肱骨, the forearm, the hand's palm and three fingers
    B('bone', ...a(0.175, 0.205), 1.1, 1.39, -0.02, 0.015); B('bone', ...a(0.18, 0.205), 0.84, 1.1, 0.01, 0.04);
    B('bone', ...a(0.17, 0.215), 0.78, 0.84, 0.015, 0.04);
    for (const k of [0, 1, 2]) B('bone', ...a(0.172 + k * 0.016, 0.182 + k * 0.016), 0.71, 0.78, 0.02, 0.035);
    // leg: 股骨, 髌骨, the shin, the foot pointing forward
    B('bone', ...a(0.075, 0.1), 0.48, 0.88, -0.02, 0.02); B('bone', ...a(0.07, 0.105), 0.44, 0.5, 0.02, 0.04);
    B('bone', ...a(0.078, 0.1), 0.13, 0.46, -0.015, 0.02); B('bone', ...a(0.065, 0.115), 0.1, 0.13, -0.04, 0.14);
  }
}

/** 猫头鹰 (stuffed, on its varnished stand and branch) at (x, z) on y, facing `f`, the dust thick on its head. */
function owl(put: Put, x: number, z: number, y: number, f: Wall): void {
  const { B, F } = figure(put, x, z, y, f);
  B('specCabIn', -0.12, 0.12, 0, 0.03, -0.09, 0.09); B('specCabIn', -0.018, 0.018, 0.03, 0.08, -0.018, 0.018); B('specCabIn', -0.09, 0.09, 0.08, 0.105, -0.015, 0.015);
  B('owl', -0.09, 0.09, 0.1, 0.33, -0.08, 0.08, { oct: 0.6 }); B('owl', -0.04, 0.04, 0.06, 0.11, -0.12, -0.07);
  B('owl', -0.085, 0.085, 0.33, 0.46, -0.075, 0.075, { oct: 0.45 });
  F('owlFace', -0.07, 0.07, 0.34, 0.44, 0.075); F('owlFace', -0.04, 0.04, 0.25, 0.32, 0.067);
  for (const u of [-1, 1]) {
    F('brass', u > 0 ? 0.01 : -0.055, u > 0 ? 0.055 : -0.01, 0.37, 0.42, 0.078); F('ink', u > 0 ? 0.024 : -0.042, u > 0 ? 0.042 : -0.024, 0.385, 0.405, 0.081);
    B('owl', u > 0 ? 0.045 : -0.08, u > 0 ? 0.08 : -0.045, 0.46, 0.5, -0.03, 0.02);
  }
  F('ink', -0.01, 0.01, 0.345, 0.375, 0.078);
  B('dust', -0.06, 0.06, 0.46, 0.465, -0.05, 0.05);
}

/**
 * 标本室: a tall glass-front 标本柜 down the far end wall (cupboards below; behind the glass three shelves of 标本罐
 * against its dark inside), a low one under the window with the sun-bleached row on it, the 水池 counter on the near
 * end wall, the 人体骨架 on its stand in the corner beyond it facing the door, a dusty 猫头鹰 up on the tall cabinet.
 */
function specimenRoom(put: Put, solid: LBox[], I: Rect, r: RoomDef, y: number, rng: Rng): void {
  const { wz, s } = windowSide(r, I), far = r.x + (r.doors?.[0]?.at ?? 0) < r.x ? 1 : -1, D = 0.45, base = 0.85, top = 2.1;
  // the tall one: depth d0..d1 out from the far end wall (ew) to its glazed face (fx), za..zb along it
  const ew = far > 0 ? I.x1 : I.x0, fx = ew - far * D, face: Wall = far > 0 ? '-x' : '+x', back: Wall = far > 0 ? '+x' : '-x';
  const X = (d0: number, d1: number): [number, number] => (far > 0 ? [ew - d1, ew - d0] : [ew + d0, ew + d1]);
  const za = s > 0 ? I.z0 + 0.5 : wz + 0.02, zb = s > 0 ? wz - 0.02 : I.z1 - 0.5;
  put('specCab', bx(...X(0, D), za, zb, y, y + base), ['bottom', back]);
  put('specCabIn', plate(face, fx, za, zb, y, y + 0.08, 0.003), only(face));
  const n = Math.max(2, Math.round((zb - za) / 0.6));
  for (let k = 1; k < n; k++) { const zk = za + (k * (zb - za)) / n; put('specCabIn', plate(face, fx, zk - 0.006, zk + 0.006, y + 0.1, y + base - 0.04, 0.003), only(face)); }
  put('specCabIn', bx(...X(0, 0.02), za, zb, y + base, y + top), only(face));
  for (const [z0, z1] of [[za, za + 0.03], [zb - 0.03, zb]]) put('specCab', bx(...X(0, D), z0, z1, y + base, y + top), ['bottom', back]);
  for (const lv of [1.3, 1.7]) put('specCab', bx(...X(0.02, D - 0.02), za + 0.03, zb - 0.03, y + lv, y + lv + 0.02));
  put('specCab', bx(...X(0, D + 0.03), za, zb, y + top, y + top + 0.06), [back]);
  // the glazed doors' frames (the glass itself not drawn): rails top and bottom, a stile between each pair of doors
  const m = Math.max(2, Math.round((zb - za) / 0.7));
  for (const [v0, v1] of [[base, base + 0.05], [top - 0.05, top]]) put('specCab', bx(...X(D - 0.025, D), za, zb, y + v0, y + v1), ['bottom', back]);
  for (let k = 1; k < m; k++) { const zk = za + (k * (zb - za)) / m; put('specCab', bx(...X(D - 0.025, D), zk - 0.025, zk + 0.025, y + base + 0.05, y + top - 0.05), ['bottom', 'top', back]); }
  const jc = (X(0.02, D - 0.02)[0] + X(0.02, D - 0.02)[1]) / 2;
  for (const [lv, hmax] of [[base, 0.4], [1.32, 0.34], [1.72, 0.34]]) jarRow(put, rng, false, za + 0.03, zb - 0.03, jc, y + lv, hmax, face, false);
  solid.push(bx(...X(0, D + 0.03), za, zb, y, y + top + 0.06));
  owl(put, ew - far * D * 0.48, s > 0 ? zb - 0.45 : za + 0.45, y + top + 0.06, face);
  // the low one under the window, butting the tall one: cupboards, a top, the sun-bleached row on it
  const lz: [number, number] = s > 0 ? [wz - D, wz] : [wz, wz + D], wf: Wall = s > 0 ? '-z' : '+z', lzf = s > 0 ? lz[0] : lz[1];
  const lx: [number, number] = far > 0 ? [I.x0 + 0.95, fx] : [fx, I.x1 - 0.95];
  put('specCab', bx(...lx, ...lz, y, y + base - 0.03), ['bottom', s > 0 ? '+z' : '-z']);
  put('specCab', bx(lx[0], lx[1], Math.min(lz[0], lzf - s * 0.02), Math.max(lz[1], lzf - s * 0.02), y + base - 0.03, y + base), [s > 0 ? '+z' : '-z']);
  put('specCabIn', plate(wf, lzf, lx[0], lx[1], y, y + 0.08, 0.003), only(wf));
  for (let x = lx[0] + 0.6; x < lx[1] - 0.3; x += 0.6) put('specCabIn', plate(wf, lzf, x - 0.006, x + 0.006, y + 0.1, y + base - 0.07, 0.003), only(wf));
  jarRow(put, rng, true, lx[0], lx[1], (lz[0] + lz[1]) / 2, y + base, 0.42, wf, true);
  solid.push(bx(...lx, ...lz, y, y + base));
  // the 水池 counter against the near end wall, stopping short of the corner the skeleton stands in
  const nx: [number, number] = far > 0 ? [I.x0, I.x0 + 0.6] : [I.x1 - 0.6, I.x1];
  const zr: [number, number] = s > 0 ? [I.z0 + 0.9, wz - 1.2] : [wz + 1.2, I.z1 - 0.9];
  put('labBody', bx(...nx, ...zr, y, y + 0.86));
  put('labTop', bx(...nx, ...zr, y + 0.86, y + 0.9));
  const mz = (zr[0] + zr[1]) / 2;
  put('sink', bx(nx[0] + 0.12, nx[1] - 0.12, mz - 0.25, mz + 0.25, y + 0.9, y + 0.905), ['bottom']);
  tap(put, far > 0 ? I.x0 + 0.06 : I.x1 - 0.06, mz, y + 0.9, far > 0 ? '+x' : '-x');
  solid.push(bx(...nx, ...zr, y, y + 0.9));
  const kx = far > 0 ? I.x0 + 0.45 : I.x1 - 0.45, kz = wz - s * 0.5;
  skeleton(put, kx, kz, y, s > 0 ? '-z' : '+z');
  solid.push(bx(kx - 0.25, kx + 0.25, kz - 0.33, kz + 0.33, y, y + 1.75));
}

/**
 * 暗室: the window boarded over, the 湿台 under it (three 显影盘 and a 水池), the 干台 with the 放大机 along the end
 * wall away from the door, the 安全灯 over the 湿台, a 晾片绳 across the room, the 遮光帘 pulled aside inside the door.
 */
/** The 湿台's 水池 x (room-local): at the door end of the bench. */
const darkSink = (I: Rect, far: number) => (far > 0 ? I.x0 + 0.5 : I.x1 - 0.5);
const darkFar = (r: RoomDef) => (r.x + (r.doors?.[0]?.at ?? 0) < r.x ? 1 : -1);
/** The 安全灯 over the 湿台 (room-local x, z of its red glass's face, y = storey floor + this). */
const SAFE_Y = 2.07;
function safelightAt(b: BuildingDef, r: RoomDef): { x: number; z: number; s: number } {
  const I = inner(b, r), { wz, s } = windowSide(r, I);
  return { x: darkSink(I, darkFar(r)) + darkFar(r) * 1.25, z: wz - s * 0.185, s };
}
/**
 * 暗室 lighting (render/interior_light.ts DARKROOM), world space: its inner rect and storey span, its door (an area
 * light from the corridor, facing into the room) and the 安全灯's red glass.
 */
export function darkroomLights(b: BuildingDef): { rect: Rect; y0: number; y1: number; safe: { x: number; y: number; z: number }; door: { x: number; z: number; nx: number; nz: number; w: number; h: number } }[] {
  if (b.id !== 'LAB') return [];
  return floorStack(b).flatMap(st => storeyRooms(b, st.level).filter(r => r.kind === 'darkroom').map(r => {
    const I = inner(b, r), l = safelightAt(b, r), d = r.doors![0], sg = d.side[0] === '+' ? 1 : -1, alongX = d.side[1] === 'z';
    const R = rectOf(r), wall = alongX ? (sg > 0 ? R.z1 : R.z0) : (sg > 0 ? R.x1 : R.x0);
    return {
      rect: { x0: b.x + I.x0, x1: b.x + I.x1, z0: b.z + I.z0, z1: b.z + I.z1 }, y0: st.y, y1: st.y + st.h,
      safe: { x: b.x + l.x, y: st.y + SAFE_Y, z: b.z + l.z },
      door: { x: b.x + (alongX ? r.x + d.at : wall), z: b.z + (alongX ? wall : r.z + d.at), nx: alongX ? 0 : -sg, nz: alongX ? -sg : 0, w: d.width, h: d.height ?? 2.2 },
    };
  }));
}
function darkRoom(put: Put, solid: LBox[], I: Rect, r: RoomDef, y: number, rng: Rng): void {
  const D = LAB.dark, { wz, s } = windowSide(r, I), doorX = r.x + (r.doors?.[0]?.at ?? 0), far = doorX < r.x ? 1 : -1;
  const zz = (a: number, d: number): [number, number] => (s > 0 ? [wz - a - d, wz - a] : [wz + a, wz + a + d]);
  // 遮光板 over the window (plywood, battens round it), nailed to the wall's inner face
  const wx0 = r.x - 1.0, wx1 = r.x + 1.0;
  put('blackout', bx(wx0, wx1, ...zz(0, 0.03), y + 0.85, y + 2.75), ['bottom', s > 0 ? '+z' : '-z']);
  for (const [a, b] of [[0.85, 0.92], [2.68, 2.75]]) put('batten', bx(wx0 - 0.05, wx1 + 0.05, ...zz(0.03, 0.025), y + a, y + b), ['bottom', s > 0 ? '+z' : '-z']);
  // 湿台 the width of the room under it: tiled top, three 显影盘 (显影 / 停影 / 定影), a 水池 at the door end
  const wz2 = zz(0, 0.7), bx0 = I.x0 + 0.05, bx1 = I.x1 - 0.05;
  put('labBody', bx(bx0, bx1, ...wz2, y, y + D.bench - 0.04));
  put('tileWhite', bx(bx0, bx1, ...wz2, y + D.bench - 0.04, y + D.bench));
  const sinkX = darkSink(I, far), mz = (wz2[0] + wz2[1]) / 2;
  put('sink', bx(sinkX - 0.3, sinkX + 0.3, mz - 0.22, mz + 0.22, y + D.bench, y + D.bench + 0.004), ['bottom']);
  tap(put, sinkX, wz2[s > 0 ? 1 : 0] - s * 0.06, y + D.bench, '+x');
  const trays: Kind[] = ['trayDev', 'trayStop', 'trayFix'];
  trays.forEach((k, i) => {
    const cx = sinkX + far * (0.75 + i * 0.5);
    put(k, bx(cx - 0.2, cx + 0.2, mz - 0.15, mz + 0.15, y + D.bench, y + D.bench + 0.05));
    put('tray', bx(cx - 0.17, cx + 0.17, mz - 0.12, mz + 0.12, y + D.bench + 0.03, y + D.bench + 0.032), only('top'));
  });
  // tongs and a few brown bottles at the far end of the 湿台
  for (let k = 0; k < 4; k++) { const cx = sinkX + far * (2.35 + k * 0.13); put('reagentB', bx(cx - 0.04, cx + 0.04, wz2[s > 0 ? 1 : 0] - s * 0.12 - 0.04, wz2[s > 0 ? 1 : 0] - s * 0.12 + 0.04, y + D.bench, y + D.bench + rng.range(0.16, 0.22))); }
  solid.push(bx(bx0, bx1, ...wz2, y, y + D.bench));
  // 安全灯 over the 湿台: a black box on a bracket, its red glass lit (steady)
  const lx = sinkX + far * 1.25, lz = zz(0, 0.18);
  put('safelightCase', bx(lx - 0.16, lx + 0.16, ...lz, y + 1.95, y + 2.2), ['bottom', s > 0 ? '+z' : '-z']);
  put('safelight', bx(lx - 0.12, lx + 0.12, s > 0 ? lz[0] - 0.005 : lz[1], s > 0 ? lz[0] : lz[1] + 0.005, y + 1.98, y + 2.16), only(s > 0 ? '-z' : '+z'), { glow: 'led', phase: 1.5 });
  put('safelight', bx(lx - 0.12, lx + 0.12, ...lz, y + 1.945, y + 1.95), only('bottom'), { glow: 'led', phase: 1.5 });
  // 干台 along the far end wall: the 放大机 (baseboard, column, head with its bellows and lamp housing), a paper safe
  const ex: [number, number] = far > 0 ? [I.x1 - 0.65, I.x1 - 0.02] : [I.x0 + 0.02, I.x0 + 0.65];
  const dz: [number, number] = s > 0 ? [I.z0 + 1.0, wz2[0] - 0.15] : [wz2[1] + 0.15, I.z1 - 1.0];
  put('labBody', bx(...ex, ...dz, y, y + D.bench - 0.04));
  put('labTop', bx(...ex, ...dz, y + D.bench - 0.04, y + D.bench));
  solid.push(bx(...ex, ...dz, y, y + D.bench));
  const ecx = (ex[0] + ex[1]) / 2, ecz = (dz[0] + dz[1]) / 2 + 0.2 * s, top = y + D.bench, wall = far > 0 ? ex[1] : ex[0];
  put('easel', bx(ecx - 0.22, ecx + 0.22, ecz - 0.28, ecz + 0.28, top, top + 0.03));
  put('enlarger', bx(wall - far * 0.08 - 0.04, wall - far * 0.08 + 0.04, ecz - 0.04, ecz + 0.04, top, top + 1.0));
  const hx = wall - far * 0.26;
  put('enlarger', bx(Math.min(wall - far * 0.08, hx) - 0.1, Math.max(wall - far * 0.08, hx) + 0.1, ecz - 0.03, ecz + 0.03, top + 0.62, top + 0.66));
  put('bellows', bx(hx - 0.09, hx + 0.09, ecz - 0.09, ecz + 0.09, top + 0.48, top + 0.62));
  put('enlarger', bx(hx - 0.12, hx + 0.12, ecz - 0.12, ecz + 0.12, top + 0.66, top + 0.84));
  put('enlarger', bx(hx - 0.04, hx + 0.04, ecz - 0.04, ecz + 0.04, top + 0.42, top + 0.48));
  const pz = ecz - 0.55 * s;
  put('boxB', bx(ecx - 0.16, ecx + 0.16, pz - 0.13, pz + 0.13, top, top + 0.1));
  // 晾片绳 across the room, prints hung off it by wooden pegs (a few still curled)
  const rz = (I.z0 + I.z1) / 2 - 0.25 * s, ry = y + D.line;
  put('cord', bx(I.x0, I.x1, rz - 0.005, rz + 0.005, ry - 0.01, ry), ['top']);
  for (let x = I.x0 + 0.5; x < I.x1 - 0.4; x += rng.range(0.3, 0.45)) {
    if (rng.next() < 0.2) continue;
    const w = rng.range(0.1, 0.13), hgt = rng.range(0.15, 0.2), o = rng.range(-0.01, 0.01);
    put(rng.next() < 0.3 ? 'printDark' : 'print', bx(x - w, x + w, rz - 0.002 + o, rz + 0.002 + o, ry - 0.02 - hgt, ry - 0.02), ['top', 'bottom', '+x', '-x']);
    put('peg', bx(x - 0.012, x + 0.012, rz - 0.01, rz + 0.01, ry - 0.06, ry + 0.01), ['bottom']);
  }
  // 遮光帘: its rail inside the door wall, the black cloth bunched up away from the door
  const cz = s > 0 ? I.z0 + 0.25 : I.z1 - 0.25, cx0 = far > 0 ? I.x1 - 0.4 : I.x0, cx1 = far > 0 ? I.x1 : I.x0 + 0.4;
  put('steel', bx(I.x0, I.x1, cz - 0.015, cz + 0.015, y + 2.42, y + 2.45), ['top']);
  for (let k = 0; k < 4; k++) {
    const x = cx0 + (k + 0.5) * (cx1 - cx0) / 4, d = k % 2 ? 0.05 : 0.08;
    put(k % 2 ? 'drapeDark' : 'blackCloth', bx(x - 0.055, x + 0.055, cz - d, cz + d, y + 0.02, y + 2.42), ['top']);
  }
  // the bunched cloth stops you (without it the eye walked into the folds: tests/e2e/audit_camera.spec.ts)
  solid.push(bx(cx0, cx1, cz - 0.08, cz + 0.08, y, y + 2.42));
}
