import { floorStack, WALL_T, type BuildingDef, type RoomDef } from '../../../../shared/campus/campus_schema.ts';
import { PART, rectOf, storeyRooms } from './rooms.ts';
import { lampsAndFans, type Face, type FurnBox, type Kind } from './classroom.ts';
import { seedOf } from './office.ts';
import { Rng } from '../core/rng.ts';
import { STAIR, type LBox } from '../../../../shared/campus/stairs.ts';
import { BASEMENT } from './interior.ts';

/**
 * 食堂 + 小卖部 (docs/03_campus.md 食堂, data/campus/campus.json CAN): two storeys; a band along the north wall holds
 * the 小卖部 (1F; a 库房 over it), the 后厨 (1F; the 小炒部 over it) and the stairwell, the rest of each storey is one
 * open 餐厅.
 * - `dining` 餐厅: rows of 连体餐桌 (a steel frame, a melamine top, four round stools on arms) with aisles kept clear in
 *   front of the entrances and a queueing strip along the 打饭窗口 wall, where a stainless 托盘滑道 runs under the
 *   windows; 日光灯 and 吊扇 on the ceiling.
 * - `kitchen` 后厨: an 打饭台 behind every window (the 菜盆 in it: rice, 土豆, greens, 红烧), the 灶台 along the back
 *   wall with its 大锅 and the 抽油烟罩 over them, a 案板 on steel legs; on 1F the 蒸笼 stacked on their own stove
 *   (角色015's 馒头 come out of these).
 * - `shop` 小卖部: a glass 柜台 behind its window (the 卖货窗口), steel shelves of snacks on the back and side walls, a
 *   chest 冰柜 by the door, the owner's stool.
 * Building-local boxes; pure. The render goes through classroom.ts furnitureGeometry.
 */
export const CAN = {
  /** 连体餐桌: top size (x, z), top height, stool radius / height / offset from the table centre; grid pitch x, z */
  table: { w: 1.2, d: 0.7, h: 0.75, stool: { r: 0.16, h: 0.45, dx: 0.33, dz: 0.62 }, px: 2.4, pz: 2.4 },
  /** clear strip (m) kept in front of the 打饭窗口 wall for the queue */
  queue: 3.2,
  /** 打饭台 depth behind the window; 托盘滑道 depth in front */
  serve: 0.7, slide: 0.32,
  /** 灶台: depth, height; 抽油烟罩 bottom / top above the floor */
  stove: { d: 0.9, h: 0.8, hood: [2.0, 2.6] as [number, number] },
  /** 大锅: rim outer half-size (an octagon's inradius), rim width */
  wok: { r: 0.36, rim: 0.05 },
  /** 打饭台 cabinet: its 踢脚 (height, how far it is set back), door width; a 折边's depth proud of its face */
  toe: { h: 0.1, back: 0.05 }, door: 0.8, lip: 0.025,
  /** 抽油烟罩 underside: 油网 panel width and the stainless frame between them; 排烟管 side and spacing along the hood;
   *  the sheet width (a standing seam between two) */
  hoodFit: { filter: 0.5, frame: 0.1, duct: 0.45, ductEvery: 8, sheet: 1.25 },
  /** 2F 小炒部 餐厅: 四人方桌 (top x × z, height; grid pitch x, z; kept this far off the walls), a 双人桌 under each
   *  window of the outer walls (side), 靠背椅 (seat across × deep, seat height, back top, gap off the table edge) */
  sq: { w: 0.9, d: 0.9, h: 0.76, px: 3.4, pz: 2.8, wall: 1.7, pair: 0.7 },
  chair: { w: 0.4, d: 0.4, seat: 0.45, back: 0.86, gap: 0.08 },
};

type Out = { render: FurnBox[]; solid: LBox[] };
const bx = (x0: number, x1: number, z0: number, z1: number, y0: number, y1: number): LBox => ({ x0, x1, z0, z1, y0, y1 });

export const isCanteenRoom = (r: RoomDef) => r.kind === 'dining' || r.kind === 'kitchen' || r.kind === 'shop';

/** Furniture of a 食堂 room (building-local, y = its storey floor, h = its storey height). */
export function canteenFurniture(b: BuildingDef, r: RoomDef, y: number, h: number): Out {
  return r.kind === 'dining' ? diningFurniture(b, r, y, h) : r.kind === 'kitchen' ? kitchenFurniture(b, r, y, h) : shopFurniture(b, r, y, h);
}

/** World boxes of the rooms whose walls are white tile up to TILE.dado (render/interior_light.ts): the 后厨 / 小炒部. */
export function tiledRects(b: BuildingDef): LBox[] {
  return floorStack(b).flatMap(st => storeyRooms(b, st.level).filter(r => r.kind === 'kitchen').map(r => {
    const R = rectOf(r);
    return bx(b.x + R.x0, b.x + R.x1, b.z + R.z0, b.z + R.z1, st.y, st.y + st.h);
  }));
}

/** Where a walker stands in a 食堂 room (building-local x, z): 1.2 m inside a walled room's door; in a 餐厅 in the
 *  queue in front of the middle 打饭窗口 (its centre is a table). */
export function canteenSpot(b: BuildingDef, r: RoomDef): [number, number] {
  if (r.kind === 'dining') {
    const k = serveWall(b, r);
    if (!k) return [r.x, r.z];
    const w = k.wins[Math.floor((k.wins.length - 1) / 2)];
    return [w.u, k.z - k.s * 1.4];
  }
  const d = r.doors?.[0];
  if (!d) return [r.x, r.z];
  const I = inner(b, r), s = d.side[0] === '+' ? 1 : -1;
  return d.side[1] === 'z' ? [r.x + d.at, (s > 0 ? I.z1 : I.z0) - s * 1.2] : [(s > 0 ? I.x1 : I.x0) - s * 1.2, r.z + d.at];
}

/** The usable rect of a room: the outer wall's inner face, or PART.t / 2 off a shared edge. */
function inner(b: BuildingDef, r: RoomDef) {
  const R = rectOf(r), t = PART.t / 2, hw = b.w / 2 - WALL_T, hd = b.d / 2 - WALL_T, e = 0.05;
  return {
    x0: Math.abs(R.x0 + hw) < e ? R.x0 : R.x0 + t, x1: Math.abs(R.x1 - hw) < e ? R.x1 : R.x1 - t,
    z0: Math.abs(R.z0 + hd) < e ? R.z0 : R.z0 + t, z1: Math.abs(R.z1 - hd) < e ? R.z1 : R.z1 - t,
  };
}

/**
 * The 打饭窗口 wall a 餐厅 (or its 后厨) shares: the 后厨 of the storey and its windows on that wall. `z` = the wall's
 * centre line, `s` = +1 when the 后厨 lies on the +z side of it; `wins` = window centres (u = building-local x) and widths.
 */
function serveWall(b: BuildingDef, r: RoomDef) {
  const level = b.floors.find(f => f.rooms?.includes(r))?.level;
  const k = b.floors.find(f => f.level === level)?.rooms?.find(q => q.kind === 'kitchen');
  if (!k) return undefined;
  const ws = (k.windows ?? []).filter(w => w.side[1] === 'z');
  if (!ws.length) return undefined;
  const s = ws[0].side === '-z' ? 1 : -1, z = s > 0 ? k.z - k.d / 2 : k.z + k.d / 2;
  return { k, z, s, wins: ws.map(w => ({ u: k.x + w.at, w: w.width, sill: w.sill })) };
}
/**
 * 餐厅: 连体餐桌 on a grid (aisles kept clear down from the -z entrance, across from the -x one, the queue strip along
 * the 打饭窗口 wall, 1 m off the other walls), each a steel frame, a melamine top and four stools on arms; the
 * 托盘滑道 under the windows; 日光灯 + 吊扇.
 */
function diningFurniture(b: BuildingDef, r: RoomDef, y: number, h: number): Out {
  if (y > 0.5) return xiaochaoDining(b, r, y, h);
  const out: Out = { render: [], solid: [] }, I = inner(b, r), T = CAN.table, S = T.stool;
  const put = (kind: Kind, q: LBox, skip: Face[] = ['bottom']) => out.render.push({ ...q, kind, skip });
  const k = serveWall(b, r);
  // the queue strip and the entrances' aisles (building-local rects no table may touch)
  const keep: LBox[] = [];
  if (k) keep.push(bx(I.x0, I.x1, ...(k.s > 0 ? [k.z - CAN.queue, k.z] : [k.z, k.z + CAN.queue]) as [number, number], y, y + 3));
  for (const e of b.entrances ?? []) {
    // only a door in a wall this room touches (the 后门 is in the 后厨's north wall)
    const R = rectOf(r), sg = e.side[0] === '+' ? 1 : -1;
    if (Math.abs((e.side[1] === 'z' ? (sg > 0 ? R.z1 : R.z0) : (sg > 0 ? R.x1 : R.x0)) - sg * (e.side[1] === 'z' ? b.d : b.w) / 2) > WALL_T + 0.05) continue;
    const a = e.width / 2 + 0.8;
    keep.push(e.side[1] === 'z' ? bx(e.at - a, e.at + a, I.z0, I.z1, y, y + 3) : bx(I.x0, I.x1, e.at - a, e.at + a, y, y + 3));
  }
  const hx = T.w / 2 + 0.05, hz = S.dz + S.r;
  const nx = Math.floor((I.x1 - I.x0 - 2) / T.px), nz = Math.floor((I.z1 - I.z0 - 2) / T.pz);
  const ox = (I.x0 + I.x1) / 2 - ((nx - 1) * T.px) / 2, oz = (I.z0 + I.z1) / 2 - ((nz - 1) * T.pz) / 2;
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    const cx = ox + i * T.px, cz = oz + j * T.pz, foot = bx(cx - hx, cx + hx, cz - hz, cz + hz, y, y + T.h);
    if (keep.some(q => foot.x0 < q.x1 && foot.x1 > q.x0 && foot.z0 < q.z1 && foot.z1 > q.z0)) continue;
    const ty = y + T.h;
    put('tableTop', bx(cx - T.w / 2, cx + T.w / 2, cz - T.d / 2, cz + T.d / 2, ty - 0.03, ty));
    // the frame: a centre post pair on a foot rail, the arms out to the stools
    for (const e of [-1, 1]) put('steel', bx(cx + e * 0.4 - 0.025, cx + e * 0.4 + 0.025, cz - 0.025, cz + 0.025, y + 0.05, ty - 0.03), ['bottom', 'top']);
    put('steel', bx(cx - 0.45, cx + 0.45, cz - 0.03, cz + 0.03, y, y + 0.05));
    for (const e of [-1, 1]) put('steel', bx(cx + e * S.dx - 0.02, cx + e * S.dx + 0.02, cz - S.dz, cz + S.dz, y + S.h - 0.07, y + S.h - 0.04), ['top']);
    for (const ex of [-1, 1]) for (const ez of [-1, 1]) {
      const sx = cx + ex * S.dx, sz = cz + ez * S.dz;
      put('stool', bx(sx - S.r, sx + S.r, sz - S.r, sz + S.r, y + S.h - 0.04, y + S.h), ['bottom'] );
      out.render[out.render.length - 1].rot = Math.PI / 4;
    }
    out.solid.push(foot);
  }
  // 托盘滑道: three stainless rails on brackets along the windows, on the dining side
  if (k) {
    const u0 = Math.min(...k.wins.map(w => w.u - w.w / 2)) - 0.5, u1 = Math.max(...k.wins.map(w => w.u + w.w / 2)) + 0.5;
    const z0 = k.z - k.s * (PART.t / 2), z1 = z0 - k.s * CAN.slide, zz: [number, number] = [Math.min(z0, z1), Math.max(z0, z1)];
    const sy = y + k.wins[0].sill - 0.05;
    for (let n = 0; n < 3; n++) {
      const z = zz[0] + 0.05 + n * ((zz[1] - zz[0] - 0.1) / 2);
      put('stainless', bx(u0, u1, z - 0.012, z + 0.012, sy - 0.025, sy), ['+x', '-x']);
    }
    for (let u = u0 + 0.1; u < u1; u += 1.6) put('stainless', bx(u - 0.015, u + 0.015, zz[0], zz[1], sy - 0.05, sy - 0.025), ['top']);
    out.solid.push(bx(u0, u1, zz[0], zz[1], y, sy));
  }
  // 日光灯 everywhere, a 吊扇 in every other cell (each fan's boxes go with its nearest motor)
  const all = lampsAndFans(r, y, h, 999).out, motors = all.filter(q => q.kind === 'fan' && q.rot === Math.PI / 4);
  const mid = (q: LBox): [number, number] => [(q.x0 + q.x1) / 2, (q.z0 + q.z1) / 2];
  const keepFan = new Set(motors.filter(m => { const [x, z] = mid(m); return (Math.round((x - I.x0) / 3) + Math.round((z - I.z0) / 2.4)) % 2 === 0; }));
  for (const q of all) {
    if (q.kind !== 'fan') { out.render.push(q); continue; }
    const [x, z] = mid(q);
    let best = motors[0], bd = Infinity;
    for (const m of motors) { const [mx, mz] = mid(m), d = (mx - x) ** 2 + (mz - z) ** 2; if (d < bd) { bd = d; best = m; } }
    if (keepFan.has(best)) out.render.push(q);
  }
  return out;
}
/**
 * 2F 餐厅 (over the 小炒部; 点菜 at the window, 教工 eat up here): 四人方桌 on a looser grid, a 靠背椅 on each side of
 * every table, a row of 双人桌 under the south windows; each table a 筷筒 and a 纸巾盒; a 立式空调 in each south
 * corner; 日光灯 only (the 吊扇 are downstairs). The aisle in front of the 楼梯间 door and the queue strip are kept.
 */
function xiaochaoDining(b: BuildingDef, r: RoomDef, y: number, h: number): Out {
  const out: Out = { render: [], solid: [] }, I = inner(b, r), Q = CAN.sq, C = CAN.chair;
  const rng = new Rng(seedOf(`${b.id}.${r.id}@${y.toFixed(1)}`));
  const put = (kind: Kind, q: LBox, skip: Face[] = ['bottom']) => out.render.push({ ...q, kind, skip });
  const k = serveWall(b, r), hit = (f: LBox, ks: LBox[]) => ks.some(q => f.x0 < q.x1 && f.x1 > q.x0 && f.z0 < q.z1 && f.z1 > q.z0);
  const keep: LBox[] = [];
  if (k) keep.push(bx(I.x0, I.x1, ...(k.s > 0 ? [k.z - CAN.queue, k.z] : [k.z, k.z + CAN.queue]) as [number, number], y, y + 3));
  for (const s of b.stairwells ?? []) {
    // its door end faces the 餐厅: keep 2.5 m clear in front of it
    const R = rectOf(s);
    if (s.dir === '+z') keep.push(bx(R.x0, R.x1, R.z0 - 2.5, R.z0, y, y + 3));
    else if (s.dir === '-z') keep.push(bx(R.x0, R.x1, R.z1, R.z1 + 2.5, y, y + 3));
  }
  /** a 靠背椅 at (cx, cz), facing (fx, fz) (a unit axis vector): seat, the back board on the far side, four legs */
  const chair = (cx: number, cz: number, fx: number, fz: number) => {
    const hw = C.w / 2, hd = C.d / 2, alongX = fx !== 0, ha = alongX ? hd : hw, hb = alongX ? hw : hd;
    put('chairCan', bx(cx - ha, cx + ha, cz - hb, cz + hb, y + C.seat - 0.03, y + C.seat));
    const bxx = cx - fx * (hd - 0.015), bzz = cz - fz * (hd - 0.015);
    put('chairCan', alongX ? bx(bxx - 0.015, bxx + 0.015, cz - hw, cz + hw, y + C.seat + 0.18, y + C.back) : bx(cx - hw, cx + hw, bzz - 0.015, bzz + 0.015, y + C.seat + 0.18, y + C.back), []);
    // the two back posts carry it down to the seat
    for (const e of [-1, 1]) {
      const px = alongX ? bxx : cx + e * (hw - 0.02), pz = alongX ? cz + e * (hw - 0.02) : bzz;
      put('steel', bx(px - 0.012, px + 0.012, pz - 0.012, pz + 0.012, y + C.seat, y + C.seat + 0.18), ['bottom', 'top']);
    }
    for (const ex of [-1, 1]) for (const ez of [-1, 1]) {
      const lx = cx + ex * (ha - 0.025), lz = cz + ez * (hb - 0.025);
      put('steel', bx(lx - 0.012, lx + 0.012, lz - 0.012, lz + 0.012, y, y + C.seat - 0.03), ['bottom', 'top']);
    }
    out.solid.push(bx(cx - ha, cx + ha, cz - hb, cz + hb, y, y + C.back));
  };
  /** a table (half sizes hx, hz) on four legs, its 筷筒 + 纸巾盒, chairs on the given sides pulled out a little */
  const table = (cx: number, cz: number, hx: number, hz: number, sides: [number, number][]) => {
    const ty = y + Q.h;
    put('sqTable', bx(cx - hx, cx + hx, cz - hz, cz + hz, ty - 0.035, ty));
    put('sqEdge', bx(cx - hx + 0.04, cx + hx - 0.04, cz - hz + 0.04, cz + hz - 0.04, ty - 0.11, ty - 0.035), ['bottom', 'top']);
    for (const ex of [-1, 1]) for (const ez of [-1, 1]) {
      const lx = cx + ex * (hx - 0.06), lz = cz + ez * (hz - 0.06);
      put('steel', bx(lx - 0.02, lx + 0.02, lz - 0.02, lz + 0.02, y, ty - 0.11), ['bottom', 'top']);
    }
    // 筷筒 + 纸巾盒 toward the end nearest the wall / middle
    const ox = rng.range(-0.12, 0.12);
    out.render.push({ ...bx(cx + ox - 0.045, cx + ox + 0.045, cz - 0.045, cz + 0.045, ty, ty + 0.14), kind: 'chopTube', skip: ['bottom'], oct: 0.3 });
    put('tissue', bx(cx + ox + 0.08, cx + ox + 0.24, cz - 0.06, cz + 0.06, ty, ty + 0.07));
    out.solid.push(bx(cx - hx, cx + hx, cz - hz, cz + hz, y, ty));
    for (const [fx, fz] of sides) {
      const off = (fx ? hx : hz) + C.gap + C.d / 2 + rng.range(-0.03, 0.12);
      chair(cx - fx * off + (fz ? rng.range(-0.06, 0.06) : 0), cz - fz * off + (fx ? rng.range(-0.06, 0.06) : 0), fx, fz);
    }
  };
  // ── 双人桌 under each south window (the facade grid's windows: bay apart, centred on the wall)
  const f = b.facade, south = I.z0 + 0.05 + Q.pair / 2;
  if (f) {
    const n = Math.floor((b.w - 2 * (f.margin ?? 1.2)) / f.bay);
    for (let i = 0; i < n; i++) {
      const u = (i - (n - 1) / 2) * f.bay, foot = bx(u - 1.0, u + 1.0, I.z0, south + Q.pair / 2, y, y + 1);
      if (u - 1 < I.x0 + 0.6 || u + 1 > I.x1 - 0.6 || hit(foot, keep)) continue;
      table(u, south, Q.pair / 2, Q.pair / 2, [[1, 0], [-1, 0]]);
    }
  }
  // ── 四人方桌 on the grid in the middle, from 1.8 m off the window wall to the queue strip
  const z0 = south + Q.pair / 2 + Q.wall, z1 = (k ? Math.min(k.z, k.z - k.s * CAN.queue) : I.z1) - 0.9;
  const nx = Math.floor((I.x1 - I.x0 - 2 * Q.wall) / Q.px) + 1, nz = Math.floor((z1 - z0) / Q.pz) + 1;
  const ox = (I.x0 + I.x1) / 2 - ((nx - 1) * Q.px) / 2;
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    const cx = ox + i * Q.px, cz = z0 + j * Q.pz, reach = Q.w / 2 + C.gap + C.d + 0.1;
    if (hit(bx(cx - reach, cx + reach, cz - reach, cz + reach, y, y + 1), keep)) continue;
    table(cx, cz, Q.w / 2, Q.d / 2, [[1, 0], [-1, 0], [0, 1], [0, -1]]);
  }
  // ── 立式空调 in the two south corners: a tall white cabinet, its grille and the louvre strip
  for (const e of [-1, 1]) {
    const ax = e < 0 ? I.x0 + 0.35 : I.x1 - 0.35, az = I.z0 + 0.25 + 0.05;
    put('acUnit', bx(ax - 0.25, ax + 0.25, az - 0.17, az + 0.17, y, y + 1.75));
    put('acGrille', bx(ax - 0.19, ax + 0.19, az + 0.17, az + 0.175, y + 0.15, y + 0.9), ['bottom', 'top']);
    put('acGrille', bx(ax - 0.19, ax + 0.19, az + 0.17, az + 0.175, y + 1.25, y + 1.6), ['bottom', 'top']);
    out.solid.push(bx(ax - 0.25, ax + 0.25, az - 0.17, az + 0.17, y, y + 1.75));
  }
  out.render.push(...lampsAndFans(r, y, h, 0).out);
  return out;
}
/**
 * 后厨 / 小炒部: an 打饭台 behind each window with its 菜盆 (four to a window; `dish` paints what's in them), the 灶台
 * along the back wall (大锅 on it, the 抽油烟罩 over it), a 案板 on steel legs in between; on 1F a 蒸笼 stack on its
 * own stove by the door end.
 */
function kitchenFurniture(b: BuildingDef, r: RoomDef, y: number, h: number): Out {
  const out: Out = { render: [], solid: [] }, I = inner(b, r), rng = new Rng(seedOf(`${b.id}.${r.id}@${y.toFixed(1)}`));
  const put = (kind: Kind, q: LBox, skip: Face[] = ['bottom']) => out.render.push({ ...q, kind, skip });
  const k = serveWall(b, r);
  const s = k?.s ?? 1, front = s > 0 ? I.z0 : I.z1, back = s > 0 ? I.z1 : I.z0;
  const zz = (a: number, d: number): [number, number] => (s > 0 ? [front + a, front + a + d] : [front - a - d, front - a]);
  const yy = (a: number, d: number): [number, number] => (s > 0 ? [back - a - d, back - a] : [back + a, back + a + d]);
  // ── 红缸砖 floor: 150 mm quarry tiles (the 格缝 in the shader), a centimetre over the floor (a ground floor's is
  // BASEMENT.floor up)
  const fy = y + (y < 0.05 ? BASEMENT.floor : 0) + 0.01;
  put('quarry', bx(I.x0, I.x1, I.z0, I.z1, y, fy), ['bottom', '+x', '-x', '+z', '-z']);
  // ── 打饭台: one run under all the windows, a stainless cabinet (door seams, a dark recessed 踢脚) under a stainless
  // top with the 菜盆 sunk in it, the top's bright 折边 a little proud of the cabinet's kitchen-side face
  if (k) {
    const u0 = Math.min(...k.wins.map(w => w.u - w.w / 2)) - 0.3, u1 = Math.max(...k.wins.map(w => w.u + w.w / 2)) + 0.3;
    const sy = y + k.wins[0].sill - 0.02, sz = zz(0, CAN.serve), T = CAN.toe;
    put('mouth', bx(u0, u1, ...zz(0, CAN.serve - T.back), y, y + T.h));
    put('stainless', bx(u0, u1, ...sz, y + T.h, sy - 0.03));
    put('stainless', bx(u0, u1, ...sz, sy - 0.03, sy));
    put('stainlessHi', bx(u0 - 0.01, u1 + 0.01, ...zz(CAN.serve - 0.01, CAN.lip), sy - 0.05, sy + 0.005));
    const nd = Math.max(1, Math.round((u1 - u0) / CAN.door));
    for (let n = 1; n < nd; n++) {
      const u = u0 + (n * (u1 - u0)) / nd;
      put('hoodFilter', bx(u - 0.01, u + 0.01, ...zz(CAN.serve, 0.004), y + T.h + 0.03, sy - 0.08), ['bottom', 'top']);
    }
    for (const w of k.wins) for (let n = 0; n < 4; n++) {
      const pw = (w.w - 0.15) / 4, px = w.u - w.w / 2 + 0.075 + n * pw + pw / 2;
      const DISH: Kind[] = ['rice', 'potato', 'greens', 'braise'];
      put(DISH[(n + Math.floor(rng.next() * 2)) % 4], bx(px - pw / 2 + 0.03, px + pw / 2 - 0.03, sz[0] + 0.12, sz[1] - 0.12, sy, sy + 0.012), ['bottom']);
      put('stainless', bx(px - pw / 2 + 0.01, px + pw / 2 - 0.01, sz[0] + 0.1, sz[1] - 0.1, sy, sy + 0.05), ['bottom', 'top']);
    }
    out.solid.push(bx(u0, u1, ...sz, y, sy));
  }
  // ── 灶台 along the back wall: a white-tiled body (格缝 in the shader) under a stainless top with its 折边, the wall
  // behind tiled up to the hood; per 大锅 a 炉门 and a red 燃气阀 on the front, a tap arm over it from the back, the
  // pot itself a black bowl in a bright rim (some under a 木锅盖)
  // (the 后门 in the back wall, if this storey has one: the run starts past it)
  const lv = b.floors.find(f => f.rooms?.includes(r))?.level ?? 1;
  const bd = (b.entrances ?? []).find(e => e.side === (s > 0 ? '+z' : '-z') && (e.level ?? 1) === lv && e.at > I.x0 - 0.1 && e.at < I.x1);
  const ax0 = bd ? bd.at + bd.width / 2 + 0.4 : I.x0 + 0.3, ax1 = I.x1 - 2.2, sz = yy(0, CAN.stove.d), top = y + CAN.stove.h, [h0, h1] = CAN.stove.hood;
  put('tileWhite', bx(ax0, ax1, ...sz, y, top - 0.04));
  put('stainless', bx(ax0, ax1, ...sz, top - 0.04, top));
  put('stainlessHi', bx(ax0 - 0.01, ax1 + 0.01, ...yy(CAN.stove.d, CAN.lip), top - 0.06, top + 0.005));
  put('tileWhite', bx(ax0 - 0.1, ax1 + 0.1, ...yy(0, 0.012), top, y + h0), ['bottom', 'top']);
  const pots = Math.floor((ax1 - ax0) / 1.3), cz = (sz[0] + sz[1]) / 2, fz = yy(CAN.stove.d, 0.01), bz = yy(0.06, 0.03);
  // a regular octagon of inradius r (its edges facing π/8 + k π/4, as the rim's staves): the union of four bands
  // across it, each from one edge to the opposite one and as wide as an edge
  const oct = (kind: Kind, cx: number, z: number, r: number, y0: number, y1: number) => {
    const w = r * Math.tan(Math.PI / 8);
    for (let k = 0; k < 4; k++) { put(kind, bx(cx - r, cx + r, z - w, z + w, y0, y1), ['bottom']); out.render[out.render.length - 1].rot = Math.PI / 8 + (k * Math.PI) / 4; }
  };
  for (let n = 0; n < pots; n++) {
    const cx = ax0 + 0.65 + n * ((ax1 - ax0 - 1.3) / Math.max(1, pots - 1)), W = CAN.wok;
    oct('wok', cx, cz, W.r - W.rim, top, top + 0.012);
    oct('wokIn', cx, cz, W.r * 0.36, top + 0.012, top + 0.015);
    // the rim: eight bright staves round the bowl, each tangent to it
    const ro = W.r, len = 2 * ro * Math.tan(Math.PI / 8) + 0.01, rm = ro - W.rim / 2;
    for (let e = 0; e < 8; e++) {
      const t = Math.PI / 8 + (e * Math.PI) / 4, ex = cx + rm * Math.cos(t), ez = cz + rm * Math.sin(t);
      put('stainlessHi', bx(ex - len / 2, ex + len / 2, ez - W.rim / 2, ez + W.rim / 2, top, top + 0.03), ['bottom']);
      out.render[out.render.length - 1].rot = t + Math.PI / 2;
    }
    // a 木锅盖 on some: a wide board, a domed boss on it, a bar handle across
    if (rng.next() < 0.35) {
      oct('lid', cx, cz, ro + 0.01, top + 0.03, top + 0.05);
      oct('lidTop', cx, cz, ro * 0.62, top + 0.05, top + 0.09);
      put('lid', bx(cx - 0.14, cx + 0.14, cz - 0.025, cz + 0.025, top + 0.09, top + 0.13), ['bottom']);
    }
    put('mouth', bx(cx - 0.15, cx + 0.15, ...fz, y + 0.2, y + 0.38), ['bottom', 'top']);
    put('valve', bx(cx + 0.3, cx + 0.36, ...yy(CAN.stove.d, 0.05), y + 0.56, y + 0.62));
    // 水龙头: a riser at the back of the stove, its spout reaching over the pot
    put('stainless', bx(cx - 0.015, cx + 0.015, ...bz, top, top + 0.48), ['bottom']);
    const sp = yy(0.06, 0.32);
    put('stainless', bx(cx - 0.015, cx + 0.015, ...sp, top + 0.45, top + 0.48));
  }
  // ── 抽油烟罩: a stainless box with a bright 折边 along its bottom and top front edges, the 油网 panels under it, and
  // the 排烟管 going up from it through the ceiling (a flange where they meet)
  const hz = yy(0, CAN.stove.d + 0.15), hx0 = ax0 - 0.1, hx1 = ax1 + 0.1, H = CAN.hoodFit, ceil = y + h - STAIR.slab;
  put('stainless', bx(hx0, hx1, ...hz, y + h0, y + h1), []);
  for (const [l0, l1] of [[y + h0 - 0.03, y + h0 + 0.05], [y + h1 - 0.04, y + h1 + 0.005]]) put('stainlessHi', bx(hx0 - 0.01, hx1 + 0.01, ...yy(CAN.stove.d + 0.15, CAN.lip), l0, l1));
  // the hood's sheets: a standing seam every H.sheet m along its front
  const ns = Math.max(1, Math.round((hx1 - hx0) / H.sheet));
  for (let n = 1; n < ns; n++) {
    const u = hx0 + (n * (hx1 - hx0)) / ns;
    put('hoodFilter', bx(u - 0.012, u + 0.012, ...yy(CAN.stove.d + 0.15, 0.008), y + h0 + 0.05, y + h1 - 0.04), ['bottom', 'top']);
  }
  const nf = Math.max(1, Math.round((hx1 - hx0 - H.frame) / (H.filter + H.frame))), fw = (hx1 - hx0 - H.frame) / nf - H.frame;
  const fd = yy(H.frame, CAN.stove.d + 0.15 - 2 * H.frame);
  for (let n = 0; n < nf; n++) {
    const f0 = hx0 + H.frame + n * (fw + H.frame);
    put('hoodFilter', bx(f0, f0 + fw, ...fd, y + h0 - 0.015, y + h0), ['top']);
  }
  const nd = Math.max(1, Math.round((hx1 - hx0) / H.ductEvery)), dz = (yy(0, 0.7)[0] + yy(0, 0.7)[1]) / 2, dw = H.duct / 2;
  for (let n = 0; n < nd; n++) {
    const dx = hx0 + ((n + 0.5) * (hx1 - hx0)) / nd;
    put('flue', bx(dx - dw, dx + dw, dz - dw, dz + dw, y + h1, ceil), ['bottom', 'top']);
    for (const [l0, l1] of [[y + h1, y + h1 + 0.05], [ceil - 0.05, ceil]]) put('stainlessHi', bx(dx - dw - 0.04, dx + dw + 0.04, dz - dw - 0.04, dz + dw + 0.04, l0, l1), ['bottom']);
  }
  out.solid.push(bx(ax0, ax1, ...sz, y, top));
  // ── 案板: a thick board on a steel table in the middle of the run
  const mz = (Math.max(...zz(0, CAN.serve)) + Math.min(...sz)) / 2;
  const mx0 = (I.x0 + I.x1) / 2 - 1.8, mx1 = mx0 + 2.4;
  put('steel', bx(mx0, mx1, mz - 0.35, mz + 0.35, y + 0.8, y + 0.83));
  put('chopping', bx(mx0 + 0.3, mx0 + 1.1, mz - 0.25, mz + 0.25, y + 0.83, y + 0.91));
  put('steel', bx(mx0, mx1, mz - 0.35, mz + 0.35, y + 0.15, y + 0.17));
  for (const ex of [mx0 + 0.03, mx1 - 0.03]) for (const ez of [mz - 0.32, mz + 0.32]) put('steel', bx(ex - 0.02, ex + 0.02, ez - 0.02, ez + 0.02, y, y + 0.8), ['bottom', 'top']);
  out.solid.push(bx(mx0, mx1, mz - 0.35, mz + 0.35, y, y + 0.91));
  // ── 1F: 蒸笼 stacked on a low stove at the east end (the door end)
  if (b.floors.find(f => f.rooms?.includes(r))?.level === 1) {
    const ex1 = I.x1 - 0.25;
    for (const [n, cx] of [ex1 - 0.45, ex1 - 1.15].entries()) {
      const zc = (yy(0, 1.0)[0] + yy(0, 1.0)[1]) / 2;
      put('tileWhite', bx(cx - 0.4, cx + 0.4, zc - 0.4, zc + 0.4, y, y + 0.55));
      const layers = n ? 5 : 7;
      for (let l = 0; l < layers; l++) {
        const ly = y + 0.55 + l * 0.14, o = rng.range(-0.015, 0.015);
        put(l % 2 ? 'steamer' : 'steamerB', bx(cx - 0.32 + o, cx + 0.32 + o, zc - 0.32, zc + 0.32, ly, ly + 0.13), ['bottom']);
        out.render[out.render.length - 1].rot = Math.PI / 8;
      }
      put('steamerLid', bx(cx - 0.33, cx + 0.33, zc - 0.33, zc + 0.33, y + 0.55 + layers * 0.14, y + 0.6 + layers * 0.14), ['bottom']);
      out.render[out.render.length - 1].rot = Math.PI / 8;
      out.solid.push(bx(cx - 0.45, cx + 0.45, zc - 0.45, zc + 0.45, y, y + 1.6));
    }
  }
  out.render.push(...lampsAndFans(r, y, h, 0).out);
  return out;
}

/**
 * 小卖部: the glass 柜台 behind its window (a wood base, a glass case of sweets on it), steel shelves of snacks on the
 * back wall and the far side wall, a chest 冰柜 by the door, the owner's stool behind the counter.
 */
function shopFurniture(b: BuildingDef, r: RoomDef, y: number, h: number): Out {
  const out: Out = { render: [], solid: [] }, I = inner(b, r), rng = new Rng(seedOf(`${b.id}.${r.id}@${y.toFixed(1)}`));
  const put = (kind: Kind, q: LBox, skip: Face[] = ['bottom']) => out.render.push({ ...q, kind, skip });
  const win = r.windows?.[0], door = r.doors?.[0];
  const s = (win ?? door)?.side === '+z' ? -1 : 1, front = s > 0 ? I.z0 : I.z1, back = s > 0 ? I.z1 : I.z0;
  const zz = (a: number, d: number): [number, number] => (s > 0 ? [front + a, front + a + d] : [front - a - d, front - a]);
  const bz = (a: number, d: number): [number, number] => (s > 0 ? [back - a - d, back - a] : [back + a, back + a + d]);
  // ── 柜台 along the window, the door end left open
  const wx = r.x + (win?.at ?? 0), cx0 = I.x0 + 0.1, cx1 = wx + (win?.width ?? 1.8) / 2 + 0.6, cz = zz(0.05, 0.6);
  put('counterBody', bx(cx0, cx1, ...cz, y, y + 0.8));
  put('glassCase', bx(cx0 + 0.05, cx1 - 0.05, ...cz, y + 0.8, y + 0.82));
  for (let x = cx0 + 0.25; x < cx1 - 0.2; x += 0.22) {
    const kinds: Kind[] = ['snackR', 'snackY', 'snackB', 'snackG'];
    put(kinds[Math.floor(rng.next() * 4)], bx(x - 0.08, x + 0.08, cz[0] + 0.12, cz[1] - 0.12, y + 0.82, y + 0.82 + rng.range(0.05, 0.12)), ['bottom']);
  }
  out.solid.push(bx(cx0, cx1, ...cz, y, y + 0.95));
  // ── shelves: the back wall and the west end wall, five boards each, packets on four
  const shelf = (q: LBox, along: 'x' | 'z') => {
    for (const lv of [0.1, 0.5, 0.9, 1.3, 1.7]) put('steel', { ...q, y0: y + lv, y1: y + lv + 0.02 });
    for (const [ex, ez] of [[q.x0, q.z0], [q.x0, q.z1], [q.x1, q.z0], [q.x1, q.z1]]) put('steel', bx(ex - 0.02, ex + 0.02, ez - 0.02, ez + 0.02, y, y + 1.9), ['bottom']);
    const kinds: Kind[] = ['snackR', 'snackY', 'snackB', 'snackG', 'bottle'];
    const a0 = along === 'x' ? q.x0 : q.z0, a1 = along === 'x' ? q.x1 : q.z1;
    for (const lv of [0.12, 0.52, 0.92, 1.32]) for (let a = a0 + 0.08; a < a1 - 0.12; a += rng.range(0.16, 0.26)) {
      if (rng.next() < 0.15) continue;
      const hh = rng.range(0.16, 0.3), w = 0.07;
      const box = along === 'x' ? bx(a, a + 0.12, q.z0 + w, q.z1 - w, y + lv, y + lv + hh) : bx(q.x0 + w, q.x1 - w, a, a + 0.12, y + lv, y + lv + hh);
      put(kinds[Math.floor(rng.next() * 5)], box);
    }
    out.solid.push({ ...q, y0: y, y1: y + 1.9 });
  };
  shelf(bx(I.x0 + 0.1, r.x + (door?.at ?? 0) - 0.4, ...bz(0.05, 0.4), 0, 0), 'x');
  const wz = zz(0.9, Math.abs(back - front) - 1.4);
  shelf(bx(I.x0 + 0.05, I.x0 + 0.45, wz[0], wz[1], 0, 0), 'z');
  // ── 冰柜 by the door: a white chest, a sliding glass lid
  const dx = r.x + (door?.at ?? 0), fz = bz(0.05, 0.7);
  put('freezer', bx(dx - 0.2, dx + 0.85, ...fz, y, y + 0.82));
  put('glassCase', bx(dx - 0.15, dx + 0.8, fz[0] + 0.05, fz[1] - 0.05, y + 0.82, y + 0.85));
  out.solid.push(bx(dx - 0.2, dx + 0.85, ...fz, y, y + 0.85));
  // ── the owner's stool behind the counter
  const sx = wx - 0.4, sz = (zz(0.9, 0.3)[0] + zz(0.9, 0.3)[1]) / 2;
  put('stool', bx(sx - 0.16, sx + 0.16, sz - 0.16, sz + 0.16, y + 0.58, y + 0.62));
  put('steel', bx(sx - 0.02, sx + 0.02, sz - 0.02, sz + 0.02, y, y + 0.58), ['bottom', 'top']);
  out.render.push(...lampsAndFans(r, y, h, 0).out);
  return out;
}
