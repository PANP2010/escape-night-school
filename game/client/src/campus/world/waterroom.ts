import { FLOOR_HEIGHT, type BuildingDef, type RoomDef } from '../../../../shared/campus/campus_schema.ts';
import { lampsAndFans, type Face, type FurnBox, type Kind } from './classroom.ts';
import { toiletPlan } from './toilet.ts';
import type { LBox } from '../../../../shared/campus/stairs.ts';

/**
 * 开水间 / 饮水机间 (kind 'water', world/rooms.ts): a floor-standing 电热开水器 against the side wall away from the door
 * (stainless cabinet, a lit 指示灯 panel, a row of 龙头 over a 接水槽 with its grate, cabinet doors under it, a 电源箱
 * with its conduit up the wall), 白瓷砖 on that wall behind it, a 地漏 in front, a few 暖水瓶 left on the floor. The
 * 「节约用水」/「小心烫伤」 signs are data/decals.json posters. Same frame as the 厕所 (world/toilet.ts toiletPlan: a from
 * the door wall to the far wall, v across, `s` the side the door is not on). Pure; rendered through furnitureGeometry.
 */
export const WATER = {
  /** 开水器 cabinet: along the wall (a, centred on `at`), out from the wall, height; its 龙头 count and height */
  boiler: { w: 1.0, d: 0.5, h: 1.65, at: 0.15, taps: 3, tapY: 0.92 },
  /** 接水槽: its top, how far it stands out of the cabinet front */ trough: { y: 0.62, out: 0.16, h: 0.08 },
  /** 白瓷砖 behind it: height, how far past the cabinet ends */ splash: { h: 1.8, over: 0.3 },
  /** 地漏 (square) in front of the trough */ drain: 0.14,
};

export const isWaterRoom = (r: RoomDef) => r.kind === 'water';

/** Everything in a 开水间 (building-local, y = its storey floor): render boxes and colliders (the cabinet). */
export function waterFurniture(b: BuildingDef, r: RoomDef, y: number, h = FLOOR_HEIGHT): { render: FurnBox[]; solid: LBox[] } {
  const p = toiletPlan(b, r), W = WATER, render: FurnBox[] = [], solid: LBox[] = [];
  const { box, dir, s } = p, wall = s > 0 ? p.wl : p.wr, Wd = s > 0 ? dir('l') : dir('r');
  const put = (kind: Kind, q: LBox, skip: Face[] = ['bottom'], more: Partial<FurnBox> = {}) => render.push({ ...q, kind, skip, ...more });
  const vs = (a: number, c: number): [number, number] => (a < c ? [a, c] : [c, a]);
  /** across span from `o0` to `o1` metres out of the side wall */
  const out = (o0: number, o1: number) => vs(wall + s * o0, wall + s * o1);
  const B = W.boiler, a0 = B.at - B.w / 2, a1 = B.at + B.w / 2;
  // ── 白瓷砖 on the wall behind it
  const S = W.splash, [t0, t1] = out(0, 0.012);
  put('tileWhite', box(a0 - S.over, a1 + S.over, t0, t1, y, y + S.h), ['bottom', Wd]);
  // ── the cabinet on a black 踢脚, a bright 折边 round its top, a seam between the 门 below the trough
  const [c0, c1] = out(0.012, 0.012 + B.d);
  const [k0, k1] = out(0.012, 0.012 + B.d - 0.04);
  put('mouth', box(a0 + 0.04, a1 - 0.04, k0, k1, y, y + 0.08), ['bottom', Wd]);
  put('stainless', box(a0, a1, c0, c1, y + 0.08, y + B.h), ['bottom', Wd]);
  solid.push(box(a0, a1, c0, c1, y, y + B.h));
  put('stainlessHi', box(a0 - 0.01, a1 + 0.01, ...out(0.012, 0.022 + B.d), y + B.h - 0.03, y + B.h + 0.005), ['bottom', Wd]);
  const [f0, f1] = out(0.012 + B.d, 0.012 + B.d + 0.004);
  put('hoodFilter', box(B.at - 0.006, B.at + 0.006, f0, f1, y + 0.1, y + W.trough.y - 0.06), ['bottom', Wd]); // 门缝
  for (const m of [-1, 1]) put('steel', box(B.at + m * 0.05 - 0.012, B.at + m * 0.05 + 0.012, ...out(0.012 + B.d, 0.03 + B.d), y + 0.36, y + 0.44)); // 门把
  // 指示灯 panel up top: a dark strip, a green 加热 and a red 满水 lamp on it
  const py = y + B.h - 0.3;
  put('hoodFilter', box(B.at - 0.3, B.at + 0.3, f0, f1, py, py + 0.14), ['bottom', Wd]);
  put('exitSign', box(B.at - 0.22, B.at - 0.14, f1, f1 + 0.004, py + 0.03, py + 0.11), ['bottom', Wd]);
  put('valve', box(B.at + 0.14, B.at + 0.22, f1, f1 + 0.004, py + 0.03, py + 0.11), ['bottom', Wd]);
  // ── 接水槽 out of the front under the taps: a bright rim, the dark grate in it
  const T = W.trough, [g0, g1] = out(0.012 + B.d, 0.012 + B.d + T.out);
  put('stainlessHi', box(a0 + 0.06, a1 - 0.06, g0, g1, y + T.y - T.h, y + T.y), ['bottom']);
  put('hoodFilter', box(a0 + 0.1, a1 - 0.1, ...out(0.012 + B.d + 0.02, 0.012 + B.d + T.out - 0.03), y + T.y, y + T.y + 0.002), ['bottom']);
  solid.push(box(a0 + 0.06, a1 - 0.06, g0, g1, y, y + T.y));
  // ── a row of 龙头 over it: a spout out of the front, turned down, a red-marked handle on top
  for (let i = 0; i < B.taps; i++) {
    const ta = a0 + ((i + 0.5) * B.w) / B.taps, ty = y + B.tapY;
    put('stainlessHi', box(ta - 0.02, ta + 0.02, ...out(0.012 + B.d, 0.012 + B.d + 0.09), ty - 0.02, ty + 0.02));
    put('stainlessHi', box(ta - 0.016, ta + 0.016, ...out(0.012 + B.d + 0.06, 0.012 + B.d + 0.09), ty - 0.09, ty - 0.02), ['top']);
    put('valve', box(ta - 0.04, ta + 0.04, ...out(0.012 + B.d + 0.02, 0.012 + B.d + 0.05), ty + 0.02, ty + 0.045));
  }
  // ── 电源箱 on the wall past the cabinet's door-side end, its conduit up to the ceiling
  const ea = a1 + 0.2, ey = y + 1.45, ceil = y + h - 0.12;
  put('enamel', box(ea - 0.12, ea + 0.12, ...out(0.012, 0.1), ey - 0.15, ey + 0.15), ['bottom', Wd]);
  put('ink', box(ea - 0.03, ea + 0.03, ...out(0.1, 0.11), ey - 0.03, ey + 0.05), ['bottom', Wd]);
  put('steel', box(ea - 0.015, ea + 0.015, ...out(0.012, 0.042), ey + 0.15, ceil), ['bottom', 'top', Wd]);
  put('steel', box(ea - 0.015, a1 - 0.1, ...out(0.012, 0.042), y + B.h - 0.12, y + B.h - 0.09), ['top', 'bottom', Wd]); // feed into the cabinet
  // ── 地漏 in the floor in front of the trough, a darker wet patch round it
  const dv = wall + s * (0.012 + B.d + T.out + 0.3), D = W.drain;
  put('stallFoot', box(B.at - 0.35, B.at + 0.35, ...vs(dv - 0.32, dv + 0.32), y, y + 0.002), ['bottom']);
  put('steel', box(B.at - D / 2, B.at + D / 2, dv - D / 2, dv + D / 2, y + 0.002, y + 0.004), ['bottom']);
  for (let i = 1; i < 4; i++) put('ink', box(B.at - D / 2 + 0.015, B.at + D / 2 - 0.015, dv - D / 2 + (i * D) / 4 - 0.005, dv - D / 2 + (i * D) / 4 + 0.005, y + 0.004, y + 0.005), ['bottom']);
  // ── 暖水瓶 left in a row on the floor by the far end of the cabinet (shell, cork 塞 on top)
  ['valve', 'counterBody', 'board'].forEach((kind, i) => {
    const ba = a0 - 0.14 - i * 0.16, bv = wall + s * (0.12 + (i % 2) * 0.06);
    const q = box(ba - 0.055, ba + 0.055, bv - 0.055, bv + 0.055, y, y + 0.36);
    put(kind as Kind, q); solid.push(q);
    put('lid', box(ba - 0.025, ba + 0.025, bv - 0.025, bv + 0.025, y + 0.36, y + 0.4));
  });
  render.push(...lampsAndFans(r, y, h, 0).out);
  return { render, solid };
}
