import { buildingHeight, type BuildingDef, type CampusDef } from '../../../../shared/campus/campus_schema.ts';
import { box, type AABB } from '../../../../shared/campus/collision.ts';
import type { PropPart } from './props.ts';

/**
 * 食堂楼后 (data/campus/campus.json CAN, its +z 后门 out of the 后厨's west end): what a 后厨 puts out the back door and
 * up on the roof. Out of the door: two 泔水桶 under their lids east of it, a stack of 菜筐 (one with greens in it), and
 * west of it the 煤气罐笼 (a steel cage, a padlocked mesh front, four bottles chained in). Along the north wall, in
 * the 窗间墙 over each storey's 后厨 windows, a 排风扇 (a framed hole, the blades in it, the 油渍 run down the wall
 * under it). On the roof over the 后厨: a 排烟风机 per hood duct (a galvanized box on a concrete plinth, the duct
 * coming up out of the slab and bent over into it, a rain cap on the outlet). World-space parts; pure. The render
 * goes into the campus props mesh (world/props.ts propGeometry), the yard things also collide.
 */
export const YARD = {
  /** 排风扇: hole side, frame proud of the wall, centre height above the storey floor, 窗间墙 u along the wall */
  fan: { s: 0.5, frame: 0.07, y: 2.2, at: [-6, -2, 2, 6] },
  /** 泔水桶: radius, height; 菜筐: x, y, z */ bucket: { r: 0.28, h: 0.72 }, crate: [0.6, 0.28, 0.42] as const,
  /** 煤气罐笼: width (along the wall), depth, height; bottle radius, height */ cage: { w: 1.7, d: 0.75, h: 1.5, r: 0.17, bh: 1.2 },
  /** 排烟风机: housing (x, y, z), plinth height, duct side, the duct's riser height over the slab, the u of each */
  roofFan: { box: [1.1, 0.8, 0.9] as const, plinth: 0.15, duct: 0.45, rise: 1.5, at: [-6, 0, 6] },
};

/** The 后门 (a +z entrance) of a building whose 后厨 has one. */
const backDoor = (b: BuildingDef) => (b.entrances ?? []).find(e => e.side === '+z' && (e.level ?? 1) === 1 && b.floors.some(f => f.rooms?.some(r => r.kind === 'kitchen')));

export function canYardParts(c: CampusDef): PropPart[] {
  const out: PropPart[] = [];
  for (const b of c.buildings) {
    const d = backDoor(b);
    if (!d) continue;
    const zw = b.z + b.d / 2, P = (kind: PropPart['kind'], x: number, y: number, z: number, sx: number, sy: number, sz: number, round?: true) =>
      out.push({ kind, c: [b.x + x, y, zw + z], s: [sx, sy, sz], ...(round ? { round } : {}) });
    const dx = d.at, dw = d.width / 2;
    // ── 泔水桶 east of the door, against the wall; a lid on one, the other's lid leant on it
    const B = YARD.bucket;
    for (const [k, ox] of [0.75, 1.4].entries()) {
      const x = dx + dw + ox;
      P('slopBin', x, B.h / 2, B.r + 0.12, 2 * B.r, B.h, 2 * B.r, true);
      P('slopRim', x, B.h - 0.03, B.r + 0.12, 2 * B.r + 0.04, 0.06, 2 * B.r + 0.04, true);
      if (!k) P('slopLid', x, B.h + 0.02, B.r + 0.12, 2 * B.r + 0.02, 0.03, 2 * B.r + 0.02, true);
      else P('slop', x, B.h - 0.06, B.r + 0.12, 2 * B.r - 0.04, 0.02, 2 * B.r - 0.04, true);
    }
    // ── 菜筐: three crates stacked, a fourth on the ground beside them with greens heaped in it
    const [cx, cy, cz] = YARD.crate, kx = dx + dw + 2.6;
    for (const [n, kind] of (['crateR', 'crateG', 'crateR'] as const).entries()) P(kind, kx, cy / 2 + n * cy, cz / 2 + 0.1, cx, cy - 0.01, cz);
    P('crateG', kx + 0.72, cy / 2, cz / 2 + 0.18, cx, cy - 0.01, cz);
    P('greens', kx + 0.72, cy + 0.03, cz / 2 + 0.18, cx - 0.08, 0.1, cz - 0.08);
    // ── 煤气罐笼 west of the door: corner posts, top and bottom frames, a mesh front of bars, the bottles inside
    const G = YARD.cage, gx = dx - dw - 0.6 - G.w / 2, gz = G.d / 2 + 0.08;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) P('cageFrame', gx + sx * (G.w / 2 - 0.02), G.h / 2, gz + sz * (G.d / 2 - 0.02), 0.04, G.h, 0.04);
    for (const y of [0.05, G.h - 0.02]) {
      P('cageFrame', gx, y, gz + G.d / 2 - 0.02, G.w, 0.04, 0.04); P('cageFrame', gx, y, gz - G.d / 2 + 0.02, G.w, 0.04, 0.04);
      for (const sx of [-1, 1]) P('cageFrame', gx + sx * (G.w / 2 - 0.02), y, gz, 0.04, 0.04, G.d);
    }
    P('cageFrame', gx, G.h, gz, G.w, 0.02, G.d);
    for (let u = -G.w / 2 + 0.12; u < G.w / 2 - 0.05; u += 0.12) P('cageBar', gx + u, G.h / 2, gz + G.d / 2 - 0.02, 0.015, G.h - 0.06, 0.015);
    for (const sx of [-1, 1]) for (let z = -G.d / 2 + 0.12; z < G.d / 2 - 0.05; z += 0.12) P('cageBar', gx + sx * (G.w / 2 - 0.02), G.h / 2, gz + z, 0.015, G.h - 0.06, 0.015);
    P('lock', gx + 0.15, 0.85, gz + G.d / 2 + 0.01, 0.06, 0.08, 0.03);
    for (let n = 0; n < 4; n++) {
      const x = gx - G.w / 2 + 0.25 + n * ((G.w - 0.5) / 3);
      P('gasBottle', x, 0.08 + G.bh / 2, gz - 0.05, 2 * G.r, G.bh, 2 * G.r, true);
      P('gasCollar', x, 0.08 + G.bh + 0.06, gz - 0.05, 0.16, 0.12, 0.16, true);
      P('gasBand', x, 0.08 + G.bh * 0.62, gz - 0.05, 2 * G.r + 0.01, 0.1, 2 * G.r + 0.01, true);
    }
    P('cageBar', gx, 0.78, gz - G.d / 2 + 0.04, G.w - 0.1, 0.012, 0.012);
    // ── 排风扇 in the 窗间墙 of each storey the 后厨 is on, the 油渍 run down under it
    const F = YARD.fan, fy = (lv: number) => (lv - 1) * (b.floorHeight ?? 3.6);
    for (const f of b.floors) {
      if (!f.rooms?.some(r => r.kind === 'kitchen')) continue;
      for (const u of F.at) {
        const y = fy(f.level) + F.y, s = F.s + 2 * F.frame;
        P('fanFrame', u, y, F.frame / 2, s, s, F.frame);
        P('fanHole', u, y, F.frame + 0.002, F.s, F.s, 0.004);
        P('fanBlade', u, y, F.frame + 0.006, F.s - 0.06, 0.07, 0.008);
        P('fanBlade', u, y, F.frame + 0.006, 0.07, F.s - 0.06, 0.008);
        P('fanFrame', u, y - s / 2 - 0.02, F.frame + 0.05, s + 0.04, 0.03, 0.14);
        P('grease', u + 0.03, y - s / 2 - 0.45, 0.004, s * 0.32, 0.8, 0.008);
        P('greaseD', u + 0.02, y - s / 2 - 0.15, 0.006, s * 0.5, 0.22, 0.008);
      }
    }
    // ── 排烟风机 on the roof over the 后厨 (kitchen strip: north of z 5.5 building-local)
    const R = YARD.roofFan, H = buildingHeight(b), [hx, hh, hz] = R.box, rz = -2.6;
    for (const u of R.at) {
      P('plinth', u, H + R.plinth / 2, rz, hx + 0.3, R.plinth, hz + 0.3);
      P('fanBox', u, H + R.plinth + hh / 2, rz, hx, hh, hz);
      P('fanSeam', u, H + R.plinth + hh / 2, rz - hz / 2 - 0.005, 0.03, hh, 0.01);
      P('fanSeam', u, H + R.plinth + hh + 0.01, rz, hx + 0.04, 0.03, hz + 0.04);
      // the duct up out of the slab beside it (behind, north) and over into the housing's back
      const dz = rz + hz / 2 + 0.55, dt = H + R.rise, w = R.duct;
      P('duct', u, H + (R.rise - w / 2) / 2, dz, w, R.rise - w / 2, w);
      P('duct', u, dt - w / 2, (dz + rz) / 2 + 0.1, w, w, dz - rz - hz / 2 + w / 2 + 0.1);
      P('duct', u, (dt - w / 2 + H + R.plinth + hh) / 2, rz + hz / 2 - 0.15, w, dt - w / 2 - (H + R.plinth + hh) + 0.02, w);
      P('fanFrame', u, H + 0.04, dz, w + 0.16, 0.08, w + 0.16);
      // the outlet on the south face, a 防雨罩 hood over it, a soot smear on the slab in front
      P('fanHole', u, H + R.plinth + hh / 2, rz - hz / 2 - 0.01, hx * 0.6, hh * 0.55, 0.02);
      P('fanSeam', u, H + R.plinth + hh * 0.85, rz - hz / 2 - 0.12, hx * 0.7, 0.03, 0.24);
      P('greaseD', u, H + 0.006, rz - hz / 2 - 0.5, hx * 0.7, 0.008, 0.8);
    }
  }
  return out;
}

/** The yard things out of the 后门 (not the wall fans or the roof): a box per 泔水桶 and 菜筐, one round the 煤气罐笼. */
export function canYardColliders(c: CampusDef): AABB[] {
  const parts = canYardParts(c), out: AABB[] = [];
  const tall = (q: PropPart) => box(q.c[0], q.c[2], q.s[0], q.s[2], q.c[1] + q.s[1] / 2);
  out.push(...parts.filter(q => q.kind === 'slopBin' || q.kind === 'crateR' || q.kind === 'crateG').map(tall));
  // the cage: the span of its frame, per building (frames lie within a couple of metres of each other)
  const cage = parts.filter(q => q.kind === 'cageFrame' && q.c[1] < YARD.cage.h + 0.1);
  for (const q of cage.filter(p => p.s[1] < 0.03)) {
    const m = cage.filter(p => Math.abs(p.c[0] - q.c[0]) < YARD.cage.w && Math.abs(p.c[2] - q.c[2]) < YARD.cage.d);
    const x0 = Math.min(...m.map(p => p.c[0] - p.s[0] / 2)), x1 = Math.max(...m.map(p => p.c[0] + p.s[0] / 2));
    const z0 = Math.min(...m.map(p => p.c[2] - p.s[2] / 2)), z1 = Math.max(...m.map(p => p.c[2] + p.s[2] / 2));
    out.push(box((x0 + x1) / 2, (z0 + z1) / 2, x1 - x0, z1 - z0, YARD.cage.h + 0.02));
  }
  return out;
}
