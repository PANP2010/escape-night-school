import { FLOOR_HEIGHT, floorStack, type BuildingDef, type RoomDef } from '../../../../shared/campus/campus_schema.ts';
import { lampsAndFans, type Face, type FurnBox, type Kind } from './classroom.ts';
import { libraryPlan } from './library.ts';
import { seedOf } from './office.ts';
import { Rng } from '../core/rng.ts';
import { STAIR, type LBox } from '../../../../shared/campus/stairs.ts';

/**
 * 网络中心机房 (图书馆④, room kind `server`, LIB 3F `net`): laid out in its library frame (world/library.ts libraryPlan:
 * a toward the window wall, v along it, the door on the back wall).
 * - 防静电地板 a step up (walked onto: under the step height) over the whole room but an entry pad inside the door:
 *   0.6 m tiles, every so often a 通风板, on a dark pedestal grid seen in the seams.
 * - two rows of 机柜 facing each other across a cold aisle, each unit a black server / beige 交换机 with its 指示灯
 *   (FurnBox.glow 'led': the interior shader flickers them, a few steady), blank panels between; a 走线架 over each
 *   row on the ceiling rods, cable bundles dropping into the racks.
 * - two 精密空调 and the UPS against the window wall, a 值班桌 with two CRT 监控 (FurnBox.glow 'feed': four camera
 *   pictures a screen) and the 硬盘录像机 under it, a chair, the 登记本; a PVC 线槽 along the door wall.
 * Pure; the render goes through classroom.ts furnitureGeometry.
 */
export const NET = {
  /** 防静电地板: height of its top, tile pitch, seam; the entry pad inside the door (deep along a, extra width) */
  floor: { h: 0.15, tile: 0.6, seam: 0.012, vent: 0.08, pad: 1.2, padW: 0.5 },
  /** 机柜: width along the row, depth, height; the rows' fronts (a, from the back wall), how far along v they run */
  rack: { w: 0.6, d: 1.0, h: 2.0, rows: [1.6, 4.2] as [number, number], v0: 1.0, n: 22, unit: 0.0445 },
  /** 走线架 over the rows: height above the raised floor, width */
  tray: { y: 2.45, w: 0.4 },
  /** 监控 picture: one camera quarter of a CRT screen (lit by render/interior_light.ts) */
  feed: { w: 0.135, h: 0.1 },
};

/** Furniture of the 机房 (building-local, y = its storey floor): render boxes and colliders. */
export function serverFurniture(b: BuildingDef, r: RoomDef, y: number): { render: FurnBox[]; solid: LBox[] } {
  const p = libraryPlan(b, r), render: FurnBox[] = [], solid: LBox[] = [];
  const rng = new Rng(seedOf(`${b.id}.${r.id}@${y.toFixed(1)}`));
  const put = (kind: Kind, q: LBox, skip: Face[] = ['bottom'], more: Partial<FurnBox> = {}) => render.push({ ...q, kind, skip, ...more });
  const { box, dir } = p, F = dir('f'), B = dir('b'), Lf = dir('l');
  const Fl = NET.floor, R = NET.rack, fy = y + Fl.h;
  const door = p.doors[0] ?? [-0.8, 0.8];
  const all: Face[] = ['+x', '-x', '+z', '-z', 'top', 'bottom'];
  const only = (...keep: Face[]) => all.filter(q => !keep.includes(q));

  // ── 防静电地板: everywhere but the entry pad inside the door, one step up (a solid you step onto)
  const pv0 = door[0] - Fl.padW, pv1 = door[1] + Fl.padW, pa = p.ba + Fl.pad;
  const raised: [number, number, number, number][] = [[pa, p.fa, p.wl, p.wr], [p.ba, pa, p.wl, pv0], [p.ba, pa, pv1, p.wr]];
  for (const [a0, a1, v0, v1] of raised) {
    if (a1 - a0 < 0.05 || v1 - v0 < 0.05) continue;
    put('tile', box(a0, a1, v0, v1, y, fy));
    solid.push(box(a0, a1, v0, v1, y, fy));
  }
  // its edge along the pad: an aluminium trim
  put('steel', box(pa, pa + 0.03, pv0, pv1, fy - 0.02, fy + 0.002), ['bottom', B]);
  for (const v of [pv0, pv1]) put('steel', box(p.ba, pa, v - 0.015, v + 0.015, fy - 0.02, fy + 0.002), ['bottom']);
  // seams on the tile grid (from the window wall and the room's left end), cut out over the pad
  const sy0 = fy + 0.001, sy1 = fy + 0.002, sm = Fl.seam / 2;
  for (let a = p.fa - Fl.tile; a > p.ba + 0.1; a -= Fl.tile) {
    const spans: [number, number][] = a > pa ? [[p.wl, p.wr]] : [[p.wl, pv0], [pv1, p.wr]];
    for (const [v0, v1] of spans) put('pedestal', box(a - sm, a + sm, v0, v1, sy0, sy1), only('top'));
  }
  for (let v = p.wl + Fl.tile; v < p.wr - 0.1; v += Fl.tile) put('pedestal', box(v > pv0 && v < pv1 ? pa : p.ba, p.fa, v - sm, v + sm, sy0, sy1), only('top'));
  // ── 机柜 rows facing each other across the cold aisle, the door end of the room clear
  const rows: { a0: number; a1: number; s: 1 | -1 }[] = [
    { a0: p.ba + R.rows[0], a1: p.ba + R.rows[0] + R.d, s: 1 },
    { a0: p.ba + R.rows[1], a1: p.ba + R.rows[1] + R.d, s: -1 },
  ];
  const rv0 = p.wl + R.v0, rv1 = rv0 + R.n * R.w;
  // 通风板 in the cold aisle, a row in front of each rack (perforated: darker, slotted)
  for (let v = rv0 + 0.05; v + Fl.tile < rv1; v += Fl.tile * 2) {
    const a0 = rows[0].a1 + 0.1, a1 = a0 + Fl.tile - 0.1;
    put('tileVent', box(a0, a1, v, v + Fl.tile - 0.1, fy, fy + Fl.vent * 0.02), only('top'));
    for (let k = 1; k < 5; k++) { const q = a0 + (k * (a1 - a0)) / 5; put('grille', box(q - 0.012, q + 0.012, v + 0.04, v + Fl.tile - 0.14, fy + 0.0018, fy + 0.0025), only('top')); }
  }
  for (const row of rows) {
    const front: Face = row.s > 0 ? F : B, af = row.s > 0 ? row.a1 : row.a0;
    const out = (d0: number, d1: number) => (row.s > 0 ? [af + d0, af + d1] : [af - d1, af - d0]) as [number, number];
    for (let i = 0; i < R.n; i++) {
      const v0 = rv0 + i * R.w + 0.01, v1 = v0 + R.w - 0.02, top = fy + R.h;
      put('rack', box(row.a0, row.a1, v0, v1, fy, top));
      // the posts down both sides of the front, a 编号 card on the top rail
      for (const v of [v0 + 0.02, v1 - 0.02]) put('steel', box(...out(0, 0.008), v - 0.018, v + 0.018, fy + 0.05, top - 0.05), only(front));
      put('paper', box(...out(0, 0.006), (v0 + v1) / 2 - 0.06, (v0 + v1) / 2 + 0.06, top - 0.09, top - 0.05), only(front));
      // the equipment, bottom up: 2U / 1U servers, 1U 交换机 with a row of port lights, blanks; some racks half empty
      let u = fy + 0.12;
      const fill = fy + (rng.next() < 0.3 ? rng.range(0.7, 1.2) : R.h - 0.15);
      while (u < fill) {
        const t = rng.next(), n = t < 0.4 ? 2 : 1, uh = n * R.unit, u1 = u + uh - 0.004;
        if (t > 0.88) { u += uh * (1 + Math.floor(rng.next() * 3)); continue; } // empty units: the dark inside of the rack
        const sw = t > 0.7, iv0 = v0 + 0.045, iv1 = v1 - 0.045;
        put(sw ? 'switch' : 'server', box(...out(0, 0.012), iv0, iv1, u, u1), only(front));
        // 指示灯: a switch's ports across its face, a server's few by its handle; most flicker, the power ones steady
        const leds = sw ? Array.from({ length: 8 }, (_, k) => iv0 + 0.08 + k * 0.045) : [iv1 - 0.05, iv1 - 0.075, iv1 - 0.1];
        leds.forEach((lv, k) => {
          const steady = sw ? rng.next() < 0.2 : k === 0, ly = sw ? u + uh * 0.55 : u + uh * 0.5;
          put(steady && !sw ? 'ledG' : rng.next() < 0.15 ? 'ledA' : 'ledG', box(...out(0.012, 0.016), lv - 0.009, lv + 0.009, ly - 0.007, ly + 0.007), only(front),
            { glow: 'led', phase: steady ? 1.5 : rng.next() });
        });
        u += uh;
      }
      // the back: a 网孔门 (two leaves, a lighter grey sheet punched in rows, read as slats a shade darker), a 把手,
      // and down one side the open 理线槽 with the patch cords hanging in it, so a row seen from behind reads as one
      const back: Face = row.s > 0 ? B : F, ab0 = row.s > 0 ? row.a0 : row.a1;
      const rear = (d0: number, d1: number) => (row.s > 0 ? [ab0 - d1, ab0 - d0] : [ab0 + d0, ab0 + d1]) as [number, number];
      const dv0 = v0 + 0.03, dv1 = v1 - 0.1, dy0 = fy + 0.06, dy1 = top - 0.06, dm = (dv0 + dv1) / 2;
      put('rackDoor', box(...rear(0, 0.006), dv0, dv1, dy0, dy1), only(back));
      for (let gy = dy0 + 0.08; gy < dy1 - 0.06; gy += 0.06) put('rackMesh', box(...rear(0.006, 0.008), dv0 + 0.03, dv1 - 0.03, gy, gy + 0.025), only(back));
      put('rack', box(...rear(0.006, 0.009), dm - 0.006, dm + 0.006, dy0, dy1), only(back));
      put('knob', box(...rear(0.008, 0.02), dm + 0.02, dm + 0.035, fy + 1.0, fy + 1.18), only(back));
      put('duct', box(...rear(0, 0.012), v1 - 0.09, v1 - 0.01, dy0, dy1), only(back, Lf, dir('r')));
      put('cable', box(...rear(0.012, 0.03), v1 - 0.07, v1 - 0.03, dy0 + 0.1, dy1 - 0.05), only(back, Lf, dir('r')));
      // a cable bundle from the 走线架 into the back of the rack
      const ab = row.s > 0 ? row.a0 + 0.12 : row.a1 - 0.12, vm = (v0 + v1) / 2;
      put('cable', box(ab - 0.04, ab + 0.04, vm - 0.05, vm + 0.05, top, fy + NET.tray.y), ['bottom', 'top']);
    }
    // the row's two 侧板 at its ends, the same light grey as the doors, a 列号 card at eye height
    for (const [ve, f] of [[rv0, Lf], [rv1, dir('r')]] as [number, Face][]) {
      const e = ve === rv0 ? [ve - 0.006, ve] : [ve, ve + 0.006];
      put('rackDoor', box(row.a0 + 0.02, row.a1 - 0.02, e[0], e[1], fy + 0.02, fy + R.h - 0.02), only(f));
      const c = ve === rv0 ? [ve - 0.009, ve - 0.006] : [ve + 0.006, ve + 0.009], am = (row.a0 + row.a1) / 2;
      put('paper', box(am - 0.12, am + 0.12, c[0], c[1], fy + 1.45, fy + 1.6), only(f));
    }
    solid.push(box(row.a0, row.a1, rv0, rv1, y, fy + R.h));
    // the 走线架 over the row: two rails, rungs, cables laid in it, hung on rods from the ceiling
    const ac = row.s > 0 ? row.a0 + 0.12 : row.a1 - 0.12, ty = fy + NET.tray.y, tw = NET.tray.w / 2;
    for (const e of [-1, 1]) put('steel', box(ac + e * tw - 0.015, ac + e * tw + 0.015, rv0, rv1, ty, ty + 0.06), []);
    for (let v = rv0 + 0.15; v < rv1; v += 0.3) put('steel', box(ac - tw, ac + tw, v - 0.012, v + 0.012, ty, ty + 0.015), ['top']);
    put('cable', box(ac - tw + 0.04, ac + tw - 0.04, rv0, rv1, ty + 0.015, ty + 0.05), ['bottom']);
    for (let v = rv0 + 0.4; v < rv1; v += 1.6) put('steel', box(ac - 0.008, ac + 0.008, v - 0.008, v + 0.008, ty + 0.06, ceilOf(b, y)), ['top', 'bottom']);
  }
  // ── against the window wall: two 精密空调 (front grille, a little 控制面板) opposite the hot aisle, the UPS and its
  // battery cabinet beside them
  const W = p.fa, unit = (kind: Kind, v0: number, v1: number, d: number, h: number) => {
    put(kind, box(W - d, W, v0, v1, fy, fy + h), ['bottom', F]);
    solid.push(box(W - d, W, v0, v1, y, fy + h));
  };
  for (const vc of [rv0 + 2.0, rv0 + 6.2, rv0 + 10.4]) {
    unit('aircon', vc - 0.9, vc + 0.9, 0.85, 1.95);
    for (let k = 0; k < 9; k++) { const gy = fy + 0.15 + k * 0.1; put('grille', box(W - 0.86, W - 0.85, vc - 0.8, vc + 0.8, gy, gy + 0.05), only(B)); }
    put('feed', box(W - 0.86, W - 0.85, vc - 0.3, vc - 0.1, fy + 1.55, fy + 1.68), only(B), { glow: 'led', phase: 1.5 });
    put('ink', box(W - 0.86, W - 0.85, vc + 0.1, vc + 0.5, fy + 1.55, fy + 1.68), only(B));
  }
  const uv0 = rv1 + 0.6;
  unit('aircon', uv0, uv0 + 0.6, 0.8, 1.6);
  put('ledG', box(W - 0.81, W - 0.8, uv0 + 0.2, uv0 + 0.22, fy + 1.35, fy + 1.37), only(B), { glow: 'led', phase: 1.5 });
  put('ledA', box(W - 0.81, W - 0.8, uv0 + 0.26, uv0 + 0.28, fy + 1.35, fy + 1.37), only(B), { glow: 'led', phase: 1.5 });
  unit('rack', uv0 + 0.65, uv0 + 1.55, 0.7, 1.4);
  // ── 值班桌 in the open end of the room, against the far end wall: two CRT 监控 on it, the 硬盘录像机 under it, a
  // chair, the 登记本 and a 搪瓷缸
  const D = { a0: p.ba + 3.2, a1: p.ba + 4.8, d: 0.7, h: 0.76 }, dv1 = p.wr, dv0 = dv1 - D.d, top = fy + D.h;
  put('desk', box(D.a0, D.a1, dv0, dv1, top - 0.04, top));
  for (const a of [D.a0 + 0.05, D.a1 - 0.05]) for (const v of [dv0 + 0.05, dv1 - 0.05]) put('desk', box(a - 0.025, a + 0.025, v - 0.025, v + 0.025, fy, top - 0.04), ['bottom', 'top']);
  put('desk', box(D.a1 - 0.45, D.a1 - 0.05, dv0 + 0.05, dv1 - 0.05, top - 0.2, top - 0.04), ['top']);
  solid.push(box(D.a0, D.a1, dv0, dv1, y, top));
  put('server', box(D.a0 + 0.1, D.a0 + 0.55, dv1 - 0.45, dv1 - 0.05, fy + 0.05, fy + 0.15), ['bottom'], {});
  put('ledG', box(D.a0 + 0.12, D.a0 + 0.13, dv1 - 0.452, dv1 - 0.45, fy + 0.12, fy + 0.13), only(Lf), { glow: 'led', phase: 0.37 });
  // the CRTs: a deep beige case, the screen on its face toward the room (-v), four snapped camera quarters on it
  const Fd = NET.feed;
  for (const ac of [D.a0 + 0.42, D.a1 - 0.42]) {
    const cw = 0.38, ch = 0.33, cy0 = top + 0.02, sv = dv0 + 0.1;
    put('switch', box(ac - cw / 2, ac + cw / 2, sv, sv + 0.4, cy0, cy0 + ch));
    put('switch', box(ac - 0.12, ac + 0.12, sv + 0.1, sv + 0.3, top, cy0), ['bottom', 'top']);
    // the picture: four camera quarters (FurnBox.phase = which camera) in a dark frame; the shader draws each feed
    // snapped to the feed grid in world space (along world x: the frame's a, the room's window wall being ±x) so
    // the shader finds each quarter's own coordinates by fract()
    const gy = Math.ceil((cy0 + 0.05) / Fd.h) * Fd.h, ga = Math.round((b.x + ac - Fd.w) / Fd.w) * Fd.w - b.x;
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
      const qa = ga + i * Fd.w, qy = gy + j * Fd.h;
      put('crt', box(qa, qa + Fd.w - 0.006, sv - 0.004, sv, qy, qy + Fd.h - 0.006), only(Lf), { glow: 'feed', phase: (i + 2 * j + 0.5) / 4 });
    }
  }
  put('paper', box(D.a0 + 0.95, D.a0 + 1.25, dv0 + 0.12, dv0 + 0.34, top, top + 0.012));
  put('ink', box(D.a0 + 1.0, D.a0 + 1.2, dv0 + 0.2, dv0 + 0.22, top + 0.012, top + 0.014), only('top'));
  put('enamel', box(D.a1 - 0.2, D.a1 - 0.12, dv0 + 0.14, dv0 + 0.22, top, top + 0.1));
  const cv = dv0 - 0.4, ca = (D.a0 + D.a1) / 2 + 0.1;
  put('chair', box(ca - 0.21, ca + 0.21, cv - 0.21, cv + 0.21, fy + 0.41, fy + 0.45));
  put('chair', box(ca - 0.21, ca + 0.21, cv - 0.23, cv - 0.19, fy + 0.45, fy + 0.86), ['bottom']);
  put('steel', box(ca - 0.02, ca + 0.02, cv - 0.02, cv + 0.02, fy, fy + 0.41), ['bottom', 'top']);
  solid.push(box(ca - 0.28, ca + 0.28, cv - 0.28, cv + 0.28, y, fy + 0.86));
  // ── a PVC 线槽 along the door wall at 1 m, broken at the doors, and one down into the floor by the racks
  const ly = y + 1.0, cuts = [p.wl + 0.1, ...p.doors.flatMap(([d0, d1]) => [d0 - 0.15, d1 + 0.15]), p.wr - 0.1].sort((q, w) => q - w);
  for (let k = 0; k + 1 < cuts.length; k += 2) put('duct', box(p.ba, p.ba + 0.05, cuts[k], cuts[k + 1], ly, ly + 0.08), ['bottom', B]);
  put('duct', box(p.ba, p.ba + 0.05, rv0 + 0.3, rv0 + 0.38, fy, ly), ['bottom', 'top', B]);
  render.push(...lampsAndFans(r, y, storeyH(b, y), 0).out);
  return { render, solid };
}

const storeyH = (b: BuildingDef, y: number) => floorStack(b).find(st => Math.abs(st.y - y) < 1e-6)?.h ?? b.floorHeight ?? FLOOR_HEIGHT;
/** The underside of the slab over the storey at y. */
const ceilOf = (b: BuildingDef, y: number) => y + storeyH(b, y) - STAIR.slab;
