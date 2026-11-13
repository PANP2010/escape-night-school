import { WALL_T, type BuildingDef, type RoomDef } from '../../../../shared/campus/campus_schema.ts';
import { lampsAndFans, type Face, type FurnBox, type Kind } from './classroom.ts';
import { seedOf } from './office.ts';
import { Rng } from '../core/rng.ts';
import type { LBox } from '../../../../shared/campus/stairs.ts';

/**
 * 锅炉房 (docs/03_campus.md, data/campus/campus.json BOIL): one tall room, 7.2 m to the roof, high windows.
 * - the 卧式锅炉 lies east–west in the north half: a 耐火砖 setting, the lagged shell on it (a cylinder of three
 *   stacked boxes, iron bands round it), the 炉门 plate at the west end facing the 煤堆 (two 炉门; it has been cold
 *   ten-odd years since the school went on 集中供暖: the 观火孔 dark, the lower door hanging open on a black 炉膛), 压力表 / 水位计 / 安全阀 on top, the 主汽管 up off it to a 分汽缸 along the
 *   north wall (石棉-lagged pipes, red 手轮 on the valves);
 * - the 烟道 from its east end up and out through the north wall to the 砖烟囱 behind the building (building.ts);
 * - what's left of the 煤堆 in the north-west corner (a low slump of dusty old cinders, the 铁锹 stood by it) and east
 *   of it the 煤仓门 in the north wall, 挂锁 on (the 煤仓 behind it never built), 角色061's
 *   things heaped west of the door (old 课桌椅, 纸箱 tied in string, 拖把桶, 扫帚) and a 竹梯 against the west wall, the
 *   软化水箱 and its 水泵 in the south-east corner, the old 值班桌 east of the door his tool table.
 * Building-local boxes; pure. The render goes through classroom.ts furnitureGeometry.
 */
export const BOIL = {
  /** the shell: west / east ends, centre z, axis height, radius; the 耐火砖 setting under it */
  shell: { x0: -2.3, x1: 2.9, z: 2.5, y: 2.1, r: 1.1, base: 1.0 },
  /** 烟道 cross-section (square), the height it runs at over the windows, the chimney's x (campus.json BOIL chimney) */
  flue: { s: 0.8, y: 6.4, x: 1.5 },
  /** 分汽缸 / pipe run along the north wall: height, pipe width */
  pipe: { y: 4.4, w: 0.16 },
  /** the lower 炉门 swung open this far (rad) on its hinge */
  doorOpen: 0.7,
};

type Out = { render: FurnBox[]; solid: LBox[] };
type Put = (kind: Kind, q: LBox, skip?: Face[], more?: Partial<FurnBox>) => void;
const bx = (x0: number, x1: number, z0: number, z1: number, y0: number, y1: number): LBox => ({ x0, x1, z0, z1, y0, y1 });
const ALL: Face[] = ['+x', '-x', '+z', '-z', 'top', 'bottom'];
const only = (...keep: Face[]) => ALL.filter(q => !keep.includes(q));

export const isBoilerRoom = (r: RoomDef) => r.kind === 'boiler';

/** The room's usable rect (it fills the building: the outer walls' inner faces). */
const inner = (b: BuildingDef) => ({ x0: -b.w / 2 + WALL_T, x1: b.w / 2 - WALL_T, z0: -b.d / 2 + WALL_T, z1: b.d / 2 - WALL_T });

/** Where a walker stands in it: 1.2 m inside the south door. */
export function boilerSpot(b: BuildingDef, r: RoomDef): [number, number] {
  const e = b.entrances?.[0], I = inner(b);
  return e ? [e.at, I.z0 + 1.2] : [r.x, r.z];
}

/** Furniture of the 锅炉间 (building-local, y = its floor, h = its height). */
export function boilerFurniture(b: BuildingDef, r: RoomDef, y: number, h: number): Out {
  const out: Out = { render: [], solid: [] }, rng = new Rng(seedOf(`${b.id}.${r.id}@${y.toFixed(1)}`));
  const put: Put = (kind, q, skip = ['bottom'], more = {}) => out.render.push({ ...q, kind, skip, ...more });
  const I = inner(b);
  boiler(put, out.solid, y);
  flueAndPipes(put, out.solid, I, y);
  coal(put, out.solid, I, y, rng);
  coalDoor(put, out.solid, I, r, y);
  doorSide(put, out.solid, I, b, y, rng);
  out.render.push(...oneLamp(r, y, h, b.entrances?.[0]?.at ?? 0, 0));
  return out;
}

type Rect = { x0: number; x1: number; z0: number; z1: number };

/**
 * 夜里只亮一盏灯 (docs/08 S3.7「里面亮着一盏灯」): of the 教室 日光灯 grid only the fixture nearest (`dx`, `dz`) (the
 * room's middle row, in line with the door) is hung; with campus.json `nightTube` the interior shader lights the room for one tube
 * and draws no ceiling strips (render/interior_light.ts). Its housing, tube and two rods: every box over its footprint.
 */
export function oneLamp(r: RoomDef, y: number, h: number, dx: number, dz: number): FurnBox[] {
  const k = oneLampBox(r, y, h, dx, dz);
  return lampsAndFans(r, y, h, 0).out.filter(q => q.x0 >= k.x0 - 1e-6 && q.x1 <= k.x1 + 1e-6 && q.z0 >= k.z0 - 1e-6 && q.z1 <= k.z1 + 1e-6);
}
/** oneLamp's housing (building-local): the lattice fixture nearest (`dx`, `dz`). */
export function oneLampBox(r: RoomDef, y: number, h: number, dx: number, dz: number): LBox {
  const d = (l: LBox) => Math.hypot((l.x0 + l.x1) / 2 - dx, (l.z0 + l.z1) / 2 - dz);
  return lampsAndFans(r, y, h, 0).lamps.reduce((a, l) => (d(l) < d(a) ? l : a));
}

/** The 卧式锅炉: its 耐火砖 setting, the lagged shell, iron bands, the 炉门 front at the west end, gauges on top. */
function boiler(put: Put, solid: LBox[], y: number): void {
  const S = BOIL.shell, cy = y + S.y, r = S.r, z = S.z;
  // the setting: a brick plinth the length of the shell, a step out at the front for the 炉门 plate
  put('blrBrick', bx(S.x0 - 0.3, S.x1 + 0.2, z - r - 0.15, z + r + 0.15, y, y + S.base));
  solid.push(bx(S.x0 - 0.3, S.x1 + 0.2, z - r - 0.15, z + r + 0.15, y, y + S.base));
  // the shell: a fat middle box and two narrower ones over and under it (an octagon end on)
  const k = 0.7;
  put('blrLag', bx(S.x0, S.x1, z - r, z + r, cy - r * 0.45, cy + r * 0.45), ['bottom']);
  put('blrLag', bx(S.x0, S.x1, z - r * k, z + r * k, cy + r * 0.45, cy + r), ['bottom']);
  put('blrLagD', bx(S.x0, S.x1, z - r * k, z + r * k, y + S.base, cy - r * 0.45), ['bottom']);
  solid.push(bx(S.x0, S.x1, z - r, z + r, y, cy + r));
  // iron bands round it every 1.2 m
  for (let x = S.x0 + 0.5; x < S.x1 - 0.2; x += 1.2) {
    put('blrIron', bx(x, x + 0.06, z - r - 0.015, z + r + 0.015, cy - r * 0.45 - 0.01, cy + r * 0.45 + 0.01), ['bottom']);
    put('blrIron', bx(x, x + 0.06, z - r * k - 0.015, z + r * k + 0.015, cy + r * 0.45, cy + r + 0.015), ['bottom']);
  }
  // the front plate: iron, two 炉门 one over the other with a 观火孔 each. Cold these ten-odd years (docs/03 BOIL): the
  // 观火孔 dark glass, the lower door left swung open on its hinge (the +z edge) on a black 炉膛 with a skin of old ash
  const fx = S.x0 - 0.3;
  put('blrIron', bx(fx, S.x0, z - r - 0.05, z + r + 0.05, y + S.base, cy + r + 0.05), ['bottom', '+x']);
  const peep = (x: number, zz: number, yc: number) => bx(x - 0.0025, x + 0.0025, zz - 0.12, zz + 0.12, yc - 0.06, yc + 0.06);
  const [u0, u1] = [y + 2.05, y + 2.55];
  put('blrDoor', bx(fx - 0.06, fx - 0.005, z - 0.4, z + 0.4, u0, u1), ['+x']);
  put('blrHearth', peep(fx - 0.0625, z, (u0 + u1) / 2), only('-x'));
  put('steel', bx(fx - 0.14, fx - 0.06, z + 0.28, z + 0.32, (u0 + u1) / 2 - 0.02, (u0 + u1) / 2 + 0.02));
  const [l0, l1] = [y + 1.15, y + 1.75], lc = (l0 + l1) / 2, a = BOIL.doorOpen, ca = Math.cos(a), sa = Math.sin(a);
  // the open door: a box turned by -a about its centre, the centre set so its +z edge stays on the hinge (fx - 0.03, z + 0.4):
  // it swings out toward the 煤堆 and leaves the doorway open to the way in. What's on it turns with it (local dx out of
  // the face, dz along it from the centre)
  const hx = fx - 0.0325, hz = z + 0.4, dcx = hx - 0.4 * sa, dcz = hz - 0.4 * ca;
  const on = (dx: number, dz: number, w: number, d: number, y0: number, y1: number, kind: Kind, skip: Face[] = ['bottom']) => {
    const px = dcx + dx * ca + dz * sa, pz = dcz - dx * sa + dz * ca;
    put(kind, bx(px - w / 2, px + w / 2, pz - d / 2, pz + d / 2, y0, y1), skip, { rot: -a });
  };
  on(0, 0, 0.055, 0.8, l0, l1, 'blrDoor', []);
  on(-0.03, 0, 0.005, 0.24, lc - 0.06, lc + 0.06, 'blrHearth', only('-x'));
  on(-0.0675, -0.3, 0.08, 0.04, lc - 0.02, lc + 0.02, 'steel');
  // the 炉膛 through the doorway: black, a grey drift of old ash along its floor, the door's frame round it
  put('blrHearth', bx(fx - 0.004, fx - 0.001, z - 0.4, z + 0.4, l0, l1), only('-x'));
  put('ash', bx(fx - 0.006, fx - 0.004, z - 0.36, z + 0.3, l0, l0 + 0.09), only('-x'));
  put('blrBand', bx(fx - 0.02, fx, z - 0.44, z + 0.44, l0 - 0.04, l0), ['+x']);
  put('blrBand', bx(fx - 0.02, fx, z - 0.44, z + 0.44, l1, l1 + 0.04), ['+x']);
  solid.push(bx(hx - 0.8 * sa, hx, hz - 0.8 * ca, hz, l0, l1));
  // the 灰门 at the foot, half open on the ash pit
  put('blrDoor', bx(fx - 0.04, fx, z - 0.45, z + 0.45, y + 0.15, y + 0.6), ['+x']);
  put('ashB', bx(fx - 0.03, fx - 0.02, z - 0.38, z + 0.38, y + 0.2, y + 0.55), only('-x'));
  // on top: the 汽包 dome, 安全阀, the 压力表 on its siphon facing the front, the 水位计 glass on the front plate
  put('blrLag', bx(-1.3, -0.7, z - 0.3, z + 0.3, cy + r, cy + r + 0.35));
  put('blrIron', bx(0.6, 0.72, z - 0.06, z + 0.06, cy + r, cy + r + 0.45), ['bottom']);
  put('blrIron', bx(0.5, 0.82, z - 0.12, z + 0.12, cy + r + 0.45, cy + r + 0.52));
  put('steel', bx(S.x0 + 0.2, S.x0 + 0.24, z - 0.5, z - 0.46, cy + r, cy + r + 0.5), ['bottom']);
  put('blrIron', bx(S.x0 + 0.15, S.x0 + 0.27, z - 0.62, z - 0.34, cy + r + 0.5, cy + r + 0.78));
  put('blrGauge', bx(S.x0 + 0.145, S.x0 + 0.15, z - 0.6, z - 0.36, cy + r + 0.52, cy + r + 0.76), only('-x'));
  put('steel', bx(fx - 0.08, fx - 0.04, z + 0.62, z + 0.66, cy - 0.1, cy + 0.7), ['bottom']);
  put('hoodGlass', bx(fx - 0.075, fx - 0.045, z + 0.615, z + 0.665, cy + 0.05, cy + 0.55), ['bottom', 'top', '+x']);
}

/**
 * 烟道 off the east end (a smoke box, up over the high windows, then north through the wall into the 砖烟囱 behind) and the steam pipes: the
 * 主汽管 up off the dome and along to the 分汽缸 under the north wall's windows, pipes off it east through the wall.
 */
function flueAndPipes(put: Put, solid: LBox[], I: Rect, y: number): void {
  const S = BOIL.shell, F = BOIL.flue, P = BOIL.pipe, z = S.z, h = F.s / 2, fxc = S.x1 + 0.75;
  put('blrIron', bx(S.x1, S.x1 + 1.2, z - 0.7, z + 0.7, y + S.base, y + S.base + 1.9));
  solid.push(bx(S.x1, S.x1 + 1.2, z - 0.7, z + 0.7, y, y + S.base + 1.9));
  put('blrIron', bx(fxc - h, fxc + h, z - h, z + h, y + S.base + 1.9, y + F.y + h), ['bottom']);
  // north to the wall, then west along it (over the high windows) and in at the chimney's foot (x = BOIL.flue.x)
  const zn = I.z1 - h - 0.05;
  put('blrIron', bx(fxc - h, fxc + h, z + h, zn - h, y + F.y - h, y + F.y + h), ['-z', '+z']);
  put('blrIron', bx(F.x - h, fxc + h, zn - h, I.z1, y + F.y - h, y + F.y + h), ['+z']);
  for (const yy of [y + 3.6, y + F.y - h - 0.06]) put('blrBand', bx(fxc - h - 0.02, fxc + h + 0.02, z - h - 0.02, z + h + 0.02, yy, yy + 0.06), ['top', 'bottom']);
  // 主汽管: up from the dome, then north to the 分汽缸
  const pw = P.w / 2, px = -1.0, py = y + P.y, hz = I.z1 - 0.35;
  const cy = y + S.y + S.r + 0.35;
  put('blrLag', bx(px - pw, px + pw, z - pw, z + pw, cy, py + pw), ['bottom']);
  put('blrLag', bx(px - pw, px + pw, z - pw, hz, py - pw, py + pw), ['-z']);
  put('blrLag', bx(-2.6, 1.6, hz - 0.18, hz + 0.18, py - 0.2, py + 0.2));
  for (const x of [-2.6, 1.6]) put('blrIron', bx(x - 0.02, x + 0.02, hz - 0.2, hz + 0.2, py - 0.22, py + 0.22));
  // brackets into the wall, two branch pipes east along it through the end wall, a 截止阀 with its red 手轮 on each
  for (const x of [-2.2, 1.2]) put('blrIron', bx(x - 0.03, x + 0.03, hz + 0.18, I.z1, py - 0.03, py + 0.03), ['+z']);
  for (const [k, x] of [[0, -0.8], [1, 0.6]] as const) {
    const zz = hz - 0.1 + k * 0.2, top = py + 0.2;
    put('blrLag', bx(x - pw * 0.7, x + pw * 0.7, zz - pw * 0.7, zz + pw * 0.7, top, py + 0.85 + k * 0.3), ['bottom']);
    put('blrLag', bx(x - pw * 0.7, I.x1, zz - pw * 0.7, zz + pw * 0.7, py + 0.85 + k * 0.3 - pw * 1.4, py + 0.85 + k * 0.3), ['+x']);
    const vy = py + 0.55;
    put('blrIron', bx(x - 0.1, x + 0.1, zz - 0.1, zz + 0.1, vy - 0.08, vy + 0.08));
    put('steel', bx(x - 0.015, x + 0.015, zz - 0.18, zz - 0.1, vy - 0.015, vy + 0.015));
    put('blrValve', bx(x - 0.15, x + 0.15, zz - 0.21, zz - 0.18, vy - 0.15, vy + 0.15), ['top', 'bottom'], { rot: Math.PI / 4 });
  }
  // the 给水管 from the 水泵 (south-east corner) along the east wall and in at the shell's foot
  put('steel', bx(I.x1 - 0.2, I.x1 - 0.1, -2.4, z - 0.4, y + 0.6, y + 0.7), ['-z']);
  put('steel', bx(S.x1 + 1.2, I.x1 - 0.1, z - 0.45, z - 0.35, y + 0.6, y + 0.7), ['+x', '-x']);
}

/**
 * What's left of the 煤堆 in the north-west corner: a low slump of old cinders gone grey with dust, a few lumps rolled
 * off it, the 铁锹 stood in the corner against the wall. Nothing spread to the 炉门: no one has shovelled here in years.
 */
function coal(put: Put, solid: LBox[], I: Rect, y: number, rng: Rng): void {
  const x0 = I.x0, z1 = I.z1;
  // the slump: a few flat lumps, highest in the corner, the dust settled on it (ashB over coal)
  for (let k = 0; k < 5; k++) {
    const cx = x0 + 0.3 + (k % 2) * 0.45 + rng.range(-0.05, 0.05), cz = z1 - 0.3 - Math.floor(k / 2) * 0.4;
    const hh = (0.34 - 0.06 * k) * rng.range(0.85, 1.1), s = rng.range(0.24, 0.34);
    put(k % 2 ? 'coalDust' : 'coalB', bx(cx - s, cx + s, cz - s, cz + s, y, y + hh), ['bottom'], { rot: rng.range(-0.5, 0.5) });
    const t = s * 0.6, h2 = hh + rng.range(0.08, 0.14);
    put(k % 2 ? 'coalB' : 'coalDust', bx(cx - t, cx + t, cz - t, cz + t, y + hh, y + h2), ['bottom'], { rot: rng.range(0, 1.5) });
    put(k % 2 ? 'ash' : 'ashB', bx(cx - t * 0.8, cx + t * 0.8, cz - t * 0.8, cz + t * 0.8, y + h2, y + h2 + 0.015), ['bottom'], { rot: rng.range(0, 1.5) });
  }
  solid.push(bx(x0, x0 + 1.05, z1 - 1.3, z1, y, y + 0.3));
  for (let k = 0; k < 6; k++) {
    const x = rng.range(x0 + 0.2, x0 + 1.1), zz = rng.range(z1 - 1.7, z1 - 1.2), s = rng.range(0.04, 0.08);
    put(k % 2 ? 'coalB' : 'coalDust', bx(x - s, x + s, zz - s * 0.8, zz + s * 0.8, y, y + s * 1.1));
  }
  // the 铁锹 stood blade-down against the west wall just south of the cinders (the 煤仓门 swings east of them)
  const sx = x0 + 0.06, sz = z1 - 1.95;
  put('steel', bx(sx - 0.02, sx + 0.02, sz - 0.13, sz + 0.13, y, y + 0.3), ['bottom']);
  put('chopping', bx(sx - 0.02, sx + 0.02, sz - 0.02, sz + 0.02, y + 0.3, y + 1.35));
  solid.push(bx(I.x0, sx + 0.05, sz - 0.15, sz + 0.15, y, y + 1.35));
}

/**
 * The 煤仓门 (campus.json: the room's `iron` door, keyed; the leaf and its 挂锁 are world/doors.ts's): an angle-iron
 * frame on the outer wall's inside face, flush with the shut leaf, the 门鼻 on the jamb at its free edge, and black
 * behind it: the 煤仓 is never built, an opened door shows only the dark.
 */
function coalDoor(put: Put, solid: LBox[], I: Rect, r: RoomDef, y: number): void {
  const d = r.doors?.find(q => q.iron);
  if (!d) return;
  const alongX = d.side[1] === 'z', mid = (alongX ? r.x : r.z) + d.at, u0 = mid - d.width / 2, u1 = mid + d.width / 2, H = d.height ?? 2.1;
  // a box on that wall's face: u along it (+x / +z), v out of it into the room
  const at = (a0: number, a1: number, v0: number, v1: number, y0: number, y1: number): LBox =>
    d.side === '+z' ? bx(a0, a1, I.z1 - v1, I.z1 - v0, y0, y1) : d.side === '-z' ? bx(a0, a1, I.z0 + v0, I.z0 + v1, y0, y1)
      : d.side === '+x' ? bx(I.x1 - v1, I.x1 - v0, a0, a1, y0, y1) : bx(I.x0 + v0, I.x0 + v1, a0, a1, y0, y1);
  const room = ({ '+z': '-z', '-z': '+z', '+x': '-x', '-x': '+x' } as const)[d.side];
  // the leaf (doors.ts) hangs PART.t / 2 off the face: its room face 8 cm out; the frame stands out to meet it
  const F = 0.08, v = 0.08;
  put('ironBand', at(u0 - F, u0, 0, v, y, y + H + F), ['bottom', d.side]);
  put('ironBand', at(u1, u1 + F, 0, v, y, y + H + F), ['bottom', d.side]);
  put('ironBand', at(u0, u1, 0, v, y + H, y + H + F), [d.side]);
  put('blrHearth', at(u0, u1, 0.002, 0.012, y, y + H), only(room));
  // the 门鼻: a staple out of the jamb through the strap's slot, where the 挂锁 hangs
  put('steel', at(u1 + 0.008, u1 + 0.032, v, v + 0.05, y + 1.085, y + 1.115), [d.side]);
  solid.push(at(u0 - F, u1 + F, 0, v, y, y + H + F));
}
/**
 * The door side: 角色061's things heaped in the corner west of the door (two old 课桌, one upside down on the other, a
 * chair upturned on the third; 纸箱 tied up in string; the 拖把桶 with a mop in it and a 扫帚 by the door), a 竹梯
 * stood against the west wall; the 软化水箱 and 水泵 in the south-east corner; the old 值班桌 east of the door, now his
 * tool table (a 工具箱, 搪瓷缸, 暖壶, a chair pushed in).
 */
function doorSide(put: Put, solid: LBox[], I: Rect, b: BuildingDef, y: number, rng: Rng): void {
  const door = b.entrances?.[0]?.at ?? 0, dw = (b.entrances?.[0]?.width ?? 1.6) / 2;
  // 课桌 against the south wall: a pair stacked (the top one upside down), a third beside them, a chair upturned on it
  const hw = 0.3, hd = 0.21, H = 0.76, dz = I.z0 + hd + 0.04;
  const desk = (dx: number, y0: number, up: boolean) => {
    const tp = up ? y0 + H - 0.03 : y0, tq = tp + 0.03;
    put('wood', bx(dx - hw, dx + hw, dz - hd, dz + hd, tp, tq), up ? ['bottom'] : []);
    const m0 = up ? tp - 0.15 : tq, m1 = up ? tp : tq + 0.15;
    put('steel', bx(dx - hw + 0.03, dx + hw - 0.03, dz - hd + 0.02, dz + hd - 0.02, m0, m1), [], { mouth: '+z' });
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const lx = dx + sx * (hw - 0.03), lz = dz + sz * (hd - 0.03);
      put('steel', bx(lx - 0.015, lx + 0.015, lz - 0.015, lz + 0.015, up ? y0 : tq, up ? tp : tq + H - 0.03), ['bottom', 'top']);
    }
  };
  const d0 = I.x0 + hw + 0.05, d1 = d0 + 2 * hw + 0.06;
  desk(d0, y, true); desk(d0, y + H, false);
  solid.push(bx(d0 - hw, d0 + hw, dz - hd, dz + hd, y, y + 2 * H));
  desk(d1, y, true);
  solid.push(bx(d1 - hw, d1 + hw, dz - hd, dz + hd, y, y + H));
  // the chair upside down on it: seat on the desk top, legs up, the back hanging over the room-side edge
  const top = y + H, s = 0.19, cz = dz - 0.02;
  put('wood', bx(d1 - s, d1 + s, cz - s, cz + s, top, top + 0.02));
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const lx = d1 + sx * (s - 0.03), lz = cz + sz * (s - 0.03);
    put('steel', bx(lx - 0.012, lx + 0.012, lz - 0.012, lz + 0.012, top + 0.02, top + 0.45), ['bottom']);
  }
  put('wood', bx(d1 - s, d1 + s, cz + s - 0.01, cz + s + 0.015, top - 0.4, top - 0.12));
  put('steel', bx(d1 - 0.012, d1 + 0.012, cz + s - 0.01, cz + s + 0.015, top - 0.12, top), ['top']);
  solid.push(bx(d1 - hw, d1 + hw, dz - hd, cz + s + 0.03, y, top + 0.45));
  // 纸箱 tied up in string, stacked along the west wall north of the desks, the top one turned a little
  const bz = I.z0 + 0.7;
  for (const [k, w, d, h] of [[0, 0.55, 0.45, 0.38], [1, 0.55, 0.45, 0.32], [2, 0.42, 0.36, 0.28]] as const) {
    const y0 = y + [0, 0.38, 0.7][k], x0 = I.x0 + 0.03, zc = bz + 0.25 + (k === 2 ? 0.03 : 0), xc = x0 + w / 2;
    const rot = k === 2 ? 0.18 : k * 0.04;
    put(k % 2 ? 'boxB' : 'box', bx(x0, x0 + w, zc - d / 2, zc + d / 2, y0, y0 + h), k ? ['bottom'] : [], { rot });
    for (const e of [-0.25, 0.25]) put('twine', bx(xc + e * w - 0.01, xc + e * w + 0.01, zc - d / 2 - 0.004, zc + d / 2 + 0.004, y0 - 0.004, y0 + h + 0.004), ['bottom'], { rot });
    put('twine', bx(x0 - 0.004, x0 + w + 0.004, zc - 0.01, zc + 0.01, y0 + h, y0 + h + 0.004), ['bottom'], { rot });
  }
  solid.push(bx(I.x0, I.x0 + 0.6, bz, bz + 0.52, y, y + 1.0));
  // 拖把桶 by the door with the mop stood in it, the 扫帚 against the wall beside it
  const mx = door - dw - 0.4, mz = I.z0 + 0.3;
  put('pail', bx(mx - 0.16, mx + 0.16, mz - 0.16, mz + 0.16, y, y + 0.34), ['bottom'], { rot: 0.4 });
  put('ink', bx(mx - 0.13, mx + 0.13, mz - 0.13, mz + 0.13, y + 0.3, y + 0.31), ['bottom'], { rot: 0.4 });
  put('cloth', bx(mx - 0.1, mx + 0.1, mz - 0.1, mz + 0.1, y + 0.31, y + 0.42), ['bottom'], { rot: 0.9 });
  put('bamboo', bx(mx - 0.015, mx + 0.015, mz - 0.015, mz + 0.015, y + 0.42, y + 1.45), ['bottom']);
  const bxx = mx - 0.5;
  put('straw', bx(bxx - 0.14, bxx + 0.14, I.z0, I.z0 + 0.07, y, y + 0.32), ['bottom', '-z']);
  put('twine', bx(bxx - 0.06, bxx + 0.06, I.z0, I.z0 + 0.08, y + 0.3, y + 0.38), ['bottom', '-z']);
  put('bamboo', bx(bxx - 0.015, bxx + 0.015, I.z0 + 0.02, I.z0 + 0.05, y + 0.38, y + 1.3), ['bottom', '-z']);
  solid.push(bx(bxx - 0.15, mx + 0.17, I.z0, mz + 0.17, y, y + 1.4));
  // 竹梯 stood up against the west wall, two poles and rungs every 0.3 m
  const lz0 = -1.7, lz1 = lz0 + 0.42, lx = I.x0 + 0.04, LH = 3.3;
  for (const z of [lz0, lz1]) put('bamboo', bx(lx, lx + 0.05, z - 0.025, z + 0.025, y, y + LH), ['-x']);
  for (let k = 1; k * 0.3 < LH - 0.1; k++) put('bamboo', bx(lx + 0.01, lx + 0.04, lz0 + 0.025, lz1 - 0.025, y + k * 0.3 - 0.015, y + k * 0.3 + 0.015), ['-x', '+z', '-z']);
  solid.push(bx(I.x0, lx + 0.05, lz0 - 0.03, lz1 + 0.03, y, y + LH));
  // 软化水箱: a riveted steel tank on a brick sill, the 水泵 beside it, a pipe from one to the other
  const tx0 = I.x1 - 1.7, tx1 = I.x1 - 0.25, tz0 = I.z0 + 0.25, tz1 = I.z0 + 1.6;
  put('blrBrick', bx(tx0 - 0.05, tx1 + 0.05, tz0 - 0.05, tz1 + 0.05, y, y + 0.3));
  put('blrTank', bx(tx0, tx1, tz0, tz1, y + 0.3, y + 1.9));
  put('blrIron', bx(tx0 - 0.02, tx1 + 0.02, tz0 - 0.02, tz1 + 0.02, y + 1.1, y + 1.15), ['top', 'bottom']);
  put('blrIron', bx(tx0 - 0.02, tx1 + 0.02, tz0 - 0.02, tz1 + 0.02, y + 1.85, y + 1.9), ['bottom']);
  put('steel', bx(tx0 + 0.3, tx0 + 0.36, tz1, tz1 + 0.04, y + 1.9, y + 2.6), ['bottom']);
  solid.push(bx(tx0 - 0.05, tx1 + 0.05, tz0 - 0.05, tz1 + 0.05, y, y + 1.9));
  const pz = tz1 + 0.55, px = I.x1 - 0.55;
  put('blrBrick', bx(px - 0.35, px + 0.35, pz - 0.25, pz + 0.25, y, y + 0.15));
  put('blrPump', bx(px - 0.3, px + 0.1, pz - 0.15, pz + 0.15, y + 0.15, y + 0.45));
  put('blrPump', bx(px + 0.1, px + 0.3, pz - 0.12, pz + 0.12, y + 0.18, y + 0.42));
  put('steel', bx(px + 0.15, I.x1 - 0.1, pz - 0.05, pz + 0.05, y + 0.6, y + 0.7));
  put('steel', bx(px + 0.15, px + 0.25, pz - 0.05, pz + 0.05, y + 0.42, y + 0.6), ['top']);
  put('steel', bx(px - 0.05, px + 0.05, tz1, pz - 0.15, y + 0.3, y + 0.4));
  solid.push(bx(px - 0.35, px + 0.35, pz - 0.25, pz + 0.25, y, y + 0.45));
  // the old 值班桌 against the south wall east of the door, his tool table now: a 工具箱, 搪瓷缸, 暖壶, a chair pushed in
  const dx0 = door + dw + 0.5, dx1 = dx0 + 1.2, dz0 = I.z0, dz1 = I.z0 + 0.6, tt = y + 0.76;
  put('desk', bx(dx0, dx1, dz0, dz1, tt - 0.04, tt), ['bottom', '-z']);
  for (const x of [dx0 + 0.03, dx1 - 0.07]) put('desk', bx(x, x + 0.04, dz0 + 0.03, dz1 - 0.03, y, tt - 0.04), ['bottom', 'top']);
  solid.push(bx(dx0, dx1, dz0, dz1, y, tt));
  put('blrBand', bx(dx0 + 0.1, dx0 + 0.55, dz0 + 0.12, dz0 + 0.34, tt, tt + 0.18), ['bottom'], { rot: rng.range(-0.1, 0.1) });
  put('steel', bx(dx0 + 0.25, dx0 + 0.4, dz0 + 0.22, dz0 + 0.24, tt + 0.18, tt + 0.23), ['bottom']);
  put('enamel', bx(dx0 + 0.75, dx0 + 0.83, dz0 + 0.2, dz0 + 0.28, tt, tt + 0.1));
  put('thermos', bx(dx1 - 0.2, dx1 - 0.08, dz0 + 0.1, dz0 + 0.22, tt, tt + 0.36));
  put('chair', bx(dx0 + 0.35, dx0 + 0.75, dz1 - 0.1, dz1 + 0.3, y + 0.42, y + 0.45));
  put('chair', bx(dx0 + 0.35, dx0 + 0.75, dz1 + 0.27, dz1 + 0.3, y + 0.45, y + 0.9), ['bottom']);
  for (const [lx, lz] of [[0.37, -0.08], [0.71, -0.08], [0.37, 0.26], [0.71, 0.26]]) put('chair', bx(dx0 + lx, dx0 + lx + 0.03, dz1 + lz, dz1 + lz + 0.03, y, y + 0.42), ['bottom', 'top']);
  solid.push(bx(dx0 + 0.35, dx0 + 0.75, dz1 - 0.1, dz1 + 0.3, y, y + 0.9));
}
