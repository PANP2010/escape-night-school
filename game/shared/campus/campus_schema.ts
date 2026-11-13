/**
 * Campus map format v1 (docs/03_campus.md 数据格式): data/campus/campus.json.
 * 建筑 → 楼层 → 房间 → 门/窗, plus stairwells that span floors. Pure (no three): types, a validator that lists
 * every problem, and small helpers the generators share. Coordinates: world metres (origin = 南门中心, +z north,
 * +x east) for buildings; everything inside a building is building-local (origin = footprint centre).
 */
import { STAIR, stairProblems } from './stairs.ts';

export type Side = '+x' | '-x' | '+z' | '-z';
const SIDES: readonly string[] = ['+x', '-x', '+z', '-z'];

/** A door in a room wall. `at` = offset of the door centre from the wall's midpoint, along the wall. */
export interface DoorDef { side: Side; at: number; width: number; height?: number; /** 钥匙 ID; absent = unlocked */ key?: string;
  /** a sheet-iron leaf (铁红, 加强带, a 门鼻 for the 挂锁: the 锅炉房's 煤仓门) instead of the painted wooden one */ iron?: boolean }
/** A window in a room wall; `depth` = reveal depth (≥ 0.15 m reads as an ink crease). */
export interface WindowDef {
  side: Side; at: number; width: number; sill: number; height: number; depth?: number;
  /** 门卫室的推拉小窗: the half toward -u slid open behind the other, and a 递物台 this deep outside the sill (m) */ hatch?: number;
}
export interface RoomDef {
  id: string; name: string;
  kind: 'classroom' | 'office' | 'corridor' | 'toilet' | 'water' | 'stairs' | 'storage' | 'hall' | 'guard' | 'stacks' | 'reading' | 'compact' | 'server' | 'court' | 'equip' | 'dining' | 'kitchen' | 'shop' | 'auditorium' | 'stage' | 'understage' | 'lab' | 'prep' | 'darkroom' | 'boiler' | 'other';
  /** building-local rect centre + size */
  x: number; z: number; w: number; d: number;
  doors?: DoorDef[]; windows?: WindowDef[];
}
/**
 * `level` 1 = ground floor, -1 = first basement (no 0). `h` overrides the building's floorHeight. `rooms` replaces the
 * storey's default layout (world/rooms.ts) outright; `rename` keeps it and gives rooms of it their own id / name
 * (default id → new), e.g. A 4F `{ "w1": { "id": "class7", "name": "高三（7）班" } }`, and optionally another `kind`
 * (same rect and doors: OFF 1F `{ "s4": { "id": "zawu", "name": "杂物间", "kind": "storage" } }`).
 */
export interface FloorDef { level: number; h?: number; rooms?: RoomDef[]; rename?: Record<string, { id: string; name: string; kind?: RoomDef['kind'] }> }
/** A stair core, building-local. The flight climbs along `dir`; it connects every level in [from, to]. */
export interface StairwellDef {
  id: string; x: number; z: number; w: number; d: number; dir: Side; from: number; to: number;
  /** 梯井 guard: 'panel' = 实心栏板 (default); 'bars' = 铁栏杆 + 木扶手 (老楼) */ rail?: 'panel' | 'bars';
  /**
   * its outer walls' windows: 'grid' = the facade rule runs through (default); 'landing' = no storey-height windows,
   * one per 休息平台 on each outer wall instead (a 转角窗 pair where two outer walls meet)
   */
  windows?: 'grid' | 'landing';
  /** 'sound' = a 声控灯 on the ceiling over every 楼层平台 (world/interior.ts stairLamps); default none */ lamp?: 'sound';
  /**
   * 楼梯间 standing free in a tall top storey (礼堂's 台仓 stair in the 侧台): its enclosure stops this high above the
   * top storey's floor under a lid slab, instead of running to the roof; default none
   */
  cap?: number;
  /**
   * 上屋面: the stair runs one more storey-height up from its top storey (`to`, the top floor) to the roof, under a
   * 出屋面 bulkhead (STAIR.roofH high) with a door onto the roof in its door-side wall; default it stops at `to`
   */
  roof?: boolean;
}
/**
 * 外立面窗规则: every above-ground floor gets a row of identical windows on each listed side, one per `bay` metres,
 * centred on the wall (`margin` kept clear at both ends). `depth` = reveal depth (≥ 0.15 m reads as an ink crease).
 */
export interface FacadeDef {
  bay: number; width: number; sill: number; height: number; depth: number;
  margin?: number; sides?: Side[]; /** 窗框 */ frame?: string; glass?: string;
}
/**
 * An entrance on the outer wall (`at` along the wall, like DoorDef); it replaces the windows of its storey it hits.
 * `level` (default 1, the ground floor): above it the doorway opens onto a 连廊 (CampusDef.bridges), no 雨棚.
 */
export interface EntranceDef {
  side: Side; at: number; width: number; height: number; level?: number;
  /** the ground-floor 雨棚's size where it is not the usual one (world/shelter.ts CANOPY): a 礼堂's 门廊 */ canopy?: Partial<CanopyDims>;
}
/** 雨棚 over an entrance: sticks `out` m out of the wall, `side` m wider than the opening each way, `gap` above its head, `t` thick. */
export interface CanopyDims { out: number; side: number; gap: number; t: number }
/**
 * 天井 (回字形): an open-air void through every storey, building-local rect of its clear opening (the courtyard walls'
 * outer faces). Its walls are WALL_T thick, on the ring side of the rect, and carry the facade window rule. `doors`:
 * ground-floor doorways out into it; `side` = the way the door faces (into the void, as the facade frames: '+z' is in
 * the void's south wall), `at` along that wall from the void's centre line.
 */
export interface CourtyardDef { x: number; z: number; w: number; d: number; doors?: EntranceDef[] }
export interface BuildingDef {
  id: string; name: string; x: number; z: number; w: number; d: number; color: string;
  floorHeight?: number; floors: FloorDef[]; stairwells?: StairwellDef[];
  facade?: FacadeDef; entrances?: EntranceDef[]; courtyard?: CourtyardDef; /** 女儿墙 height above the roof slab (default 0.9; 0 = none) */ parapet?: number;
  /** 墙面: 'brick' = 砖层 (render/facade.ts); default 'render' = 抹灰/涂料, flat */ material?: 'render' | 'brick';
  /** colour of the trims (勒脚/腰线/檐口/雨棚); default = `color` */ trim?: string;
  /** share of rooms with the light on at night, 0..1 (default 1: 晚自习 lights every classroom's windows) */ nightLit?: number;
  /** false = nobody uses it by day (快拆断电的实验楼, 礼堂 off-event): its 日光灯 stay off on a 阴雨天 too (render/interior_light.ts dayTubesOn); default true */ dayLit?: boolean;
  /** a `nightRooms` room's 日光灯 at night × this, 0..1 (default 1); below 1 the ceiling tube strips are not drawn, only its fixtures (锅炉房: one lamp) and its panes glow a grade dimmer */ nightTube?: number;
  /** default storey layout (world/rooms.ts): 'classroom' = 南教室 + 北走廊 (default); 'office' = 中走廊, 办公室 both sides */
  layout?: 'classroom' | 'office';
  /** 墙裙 colour indoors (default world/interior.ts DADO.color) */ dado?: string;
  /**
   * rooms whose 日光灯 are on at night, as `3F.yuwen` (level + room id; render/interior_light.ts nightLight): absent =
   * every room lit while the windows are (晚自习); given = only these, the corridors and every other room dark
   */
  nightRooms?: string[];
  /**
   * hollow and walk-in without a stairwell (a one-storey 门卫室): its entrances are open doorways, its rooms come from
   * floors[].rooms. A building with stairwells is enterable anyway.
   */
  enterable?: boolean;
  /** 砖烟囱 (锅炉房): a free-standing brick stack, building-local centre x, z (outside or against the footprint), plan size, height */
  chimney?: { x: number; z: number; w: number; d: number; h: number };
  /** 锅炉房's 煤仓: a low closed brick shed against the outside of a wall (centre local x, z; w, d, h), a locked 铁皮投煤口 on its outer (+z) face */
  coalStore?: { x: number; z: number; w: number; d: number; h: number };
  /**
   * 天台水箱间 (world/tankroom.ts): a little room on the roof, building-local centre x, z, plan size, height; its iron
   * door and its 爬梯 on a wall side at `at` (m from that wall's centre, along +x / +z); `back` = the wall it shares
   * with a 出屋面 bulkhead (not drawn). The steel 水箱 stands on its roof.
   */
  tankRoom?: { x: number; z: number; w: number; d: number; h: number; door: { side: Side; at: number }; ladder: { side: Side; at: number }; back?: Side };
}
export interface PlatformDef {
  id: string; name: string; x: number; z: number; w: number; d: number; h: number; color: string;
  stairs?: { side: Side; width: number; steps: number }; pole?: number;
}
/**
 * 铺装 (南门③, world/paving.ts): a paved rect on the ground. `pattern` = the joints drawn by the paving shader:
 * 'bond' = running-bond pavers (rows along x, every other row offset half a tile), 'grid' = slabs, 'checker' =
 * slabs in two alternating tones, 'lawn' = 草坪 (no joints, rows along x = 割草条纹 tile[1] wide); `tile` = [along x, along z] (m). `curb` = sides with a 路缘石 standing just outside
 * the edge, a side or `{ side, gaps }` with gaps = [from, to] along the edge in world x (z sides) / z (x sides) where
 * a path runs in. `border` = a band this wide in its own colour inside the edge (grid slabs). Rects must not
 * overlap (coplanar faces would z-fight).
 */
export interface CurbDef { side: Side; gaps: [number, number][] }
export type PavePattern = 'bond' | 'grid' | 'checker' | 'lawn';
export interface PavingDef {
  id: string; name: string; x: number; z: number; w: number; d: number; color: string;
  pattern: PavePattern; tile: [number, number]; curb?: (Side | CurbDef)[]; border?: { w: number; color: string };
  /** 绿篱 along these sides, standing just inside the edge (lawns), broken at the gaps like `curb` */ hedge?: (Side | CurbDef)[];
}
/**
 * 田径场 (world/field.ts): a stadium track centred at (x, z), long axis along x. `straight` = length of each straight,
 * `r` = radius of the infield's semicircles (the track's inner edge), `lanes` × `lane` m wide, then an `apron` of
 * concrete. The 看台 runs along the south (−z) side, `gap` m off the apron: `rows` rows `rise` high and `run` deep
 * over `len` m, with a 主席台 deck `dais` m wide in its middle (as high as row 4, under a canopy).
 */
export interface FieldDef {
  id: string; name: string; x: number; z: number; straight: number; r: number; lanes: number; lane: number; apron: number;
  stand: { len: number; rows: number; rise: number; run: number; gap: number; dais: number };
}
/** The field's footprint: track + apron, and the stand south of it. */
export function fieldRect(f: FieldDef): { x: number; z: number; w: number; d: number } {
  const half = f.r + f.lanes * f.lane + f.apron, back = f.z - half - f.stand.gap - f.stand.rows * f.stand.run;
  return { x: f.x, z: (back + f.z + half) / 2, w: Math.max(f.straight + 2 * half, f.stand.len), d: f.z + half - back };
}
/**
 * 西北矮墙 (docs/03_campus.md WALL, 结局3「远方」): a stretch of one side of the perimeter wall built only `h` high, from
 * `from` to `to` along it (world z on a ±x side, world x on a ±z side), with 碎玻璃 set in its 压顶 and 铁丝 on posts;
 * `tree` = the 梧桐 inside it (x, z). world/lowwall.ts.
 */
export interface LowWallDef { side: Side; from: number; to: number; h: number; tree: [number, number] }
export interface WallDef { minX: number; maxX: number; minZ: number; maxZ: number; h: number; t: number; gate: [number, number]; gateH: number; gateOpen?: [string, string][]; color: string; low?: LowWallDef }
/**
 * 连廊: an open walkway at storey `level` between two enterable buildings whose facing outer walls look at each other
 * across a gap (`between` = their ids). It runs straight across the gap; `at` = its centre line (world z when the
 * gap is along x, world x when along z), `width` = deck width. Each building has an entrance of that level on the
 * facing wall on the same centre line (the 连廊门): world/bridges.ts.
 */
export interface BridgeDef { id: string; name: string; between: [string, string]; level: number; at: number; width: number }
/**
 * 室外小件 (world/props.ts): bins = 分类双桶 [x, z, slots facing], benches = 长椅 [x, z, sitter facing],
 * beds = 花坛 [centre x, z, w (along x), d]; sheds = 自行车棚 (world/shed.ts) [centre x, z, length, open side].
 */
export interface CampusProps { bins?: [number, number, Side][]; benches?: [number, number, Side][]; beds?: [number, number, number, number][]; sheds?: [number, number, number, Side][] }
/**
 * 门外马路 (world/paving.ts streetParts): the street outside the south wall, from the wall's outer face outward (−z):
 * a sidewalk `walk` deep (pavers, broken by the 门口坡道: a dropped curb as wide as the gate), the carriageway `road`
 * wide (asphalt, `lanes` lanes, a 斑马线 `zebra` = [centre x, width along x]), the far sidewalk `far` deep and a 绿篱
 * `hedge` = [deep, high] along its back. Runs the full wall length; the ground is sized to reach past the hedge.
 * `lamps` = 对面人行道的高杆路灯 [pitch, high, arm]: a pair flanking the 斑马线 4 m clear, then one every `pitch` along x,
 * poles `high` at the far curb, the head on an `arm` reaching out over the road (world/paving.ts streetLamps).
 */
export interface StreetDef { walk: number; road: number; lanes: number; far: number; zebra: [number, number]; hedge: [number, number]; lamps?: [number, number, number] }
/**
 * 井盖 / 篦子 (world/paving.ts coverParts): flat iron in the paving, [kind, x, z, long axis]. 'grate' = 雨水篦子
 * (a slotted frame, 0.75 × 0.45 m, slots across the long axis, set against a curb), 'lid' = 检查井盖 (a round lid in a
 * square frame, 0.8 m). Each must lie on a paving rect, clear of the 树池.
 */
export type CoverDef = ['grate' | 'lid', number, number, 'x' | 'z'];
/**
 * 门头壁灯 (no pole): [x, z, head height, side]. (x, z) is the point on the wall face the bracket comes out of, `side` the
 * way the wall faces (the head sits WALL_LAMP_ARM out along it); no side = 吸顶 under a canopy, the head right at (x, z).
 */
export type WallLampDef = [number, number, number, ('+x' | '-x' | '+z' | '-z')?];
export interface CampusDef {
  version: 1;
  size: [number, number]; groundColor: string; axisTrees: number;
  wall: WallDef; lamps: [number, number][]; wallLamps?: WallLampDef[]; platforms: PlatformDef[]; buildings: BuildingDef[]; bridges?: BridgeDef[];
  paving?: PavingDef[]; field?: FieldDef; props?: CampusProps; street?: StreetDef; covers?: CoverDef[];
}

export const FLOOR_HEIGHT = 3.6;

/** Levels sorted bottom-up with their base height above ground (basements go below 0). */
export function floorStack(b: BuildingDef): { level: number; y: number; h: number }[] {
  const fh = b.floorHeight ?? FLOOR_HEIGHT;
  const sorted = [...b.floors].sort((p, q) => p.level - q.level);
  const out: { level: number; y: number; h: number }[] = [];
  let y = 0 - sorted.filter(f => f.level < 0).reduce((s, f) => s + (f.h ?? fh), 0); // (0 - 0, not -0)
  for (const f of sorted) { const h = f.h ?? fh; out.push({ level: f.level, y, h }); y += h; }
  return out;
}

/** Height of the roof above ground (above-ground floors only). */
export function buildingHeight(b: BuildingDef): number {
  return floorStack(b).filter(f => f.level > 0).reduce((s, f) => s + f.h, 0);
}

export const PARAPET = 0.9;

/** Storey an entrance opens on (1 = ground floor; above it a 连廊门) and the height of its sill above ground. */
export const entranceLevel = (e: EntranceDef) => e.level ?? 1;
export const entranceY = (b: BuildingDef, e: EntranceDef) => floorStack(b).find(st => st.level === entranceLevel(e))?.y ?? 0;
/** The ground-floor entrances (the ones with a 雨棚 and a 门厅 out to the open air). */
export const groundEntrances = (b: BuildingDef) => (b.entrances ?? []).filter(e => entranceLevel(e) === 1);

/** Outer wall thickness of an enterable building (window reveals must be shallower). */
export const WALL_T = 0.24;
/**
 * 可进入的楼 (docs/03 室内): a building with stairwells (or `enterable`) is generated hollow (walls, slabs, stairs;
 * world/interior.ts) and its entrances are open doorways; the others stay one solid box.
 */
export const isHollow = (b: BuildingDef) => (b.stairwells?.length ?? 0) > 0 || b.enterable === true;

/** Least ring depth (m, outer face to courtyard) on every side of a 天井: a room + corridor must fit. */
export const COURT_RING_MIN = 6;
/** The 天井 void (building-local), undefined when the building has none. */
export function courtRect(b: BuildingDef): { x0: number; x1: number; z0: number; z1: number } | undefined {
  const c = b.courtyard;
  return c && { x0: c.x - c.w / 2, x1: c.x + c.w / 2, z0: c.z - c.d / 2, z1: c.z + c.d / 2 };
}
/** The 天井 with its walls (void grown by WALL_T): what slabs, rooms and stairwells keep clear of. */
export function courtOuter(b: BuildingDef): { x0: number; x1: number; z0: number; z1: number } | undefined {
  const c = courtRect(b);
  return c && { x0: c.x0 - WALL_T, x1: c.x1 + WALL_T, z0: c.z0 - WALL_T, z1: c.z1 + WALL_T };
}

/** Top of the parapet (the eave line rain drips from). */
export const roofTop = (b: BuildingDef) => buildingHeight(b) + (b.parapet ?? PARAPET);

/**
 * A 连廊 in plan (world): `run` = the axis the deck runs along, [u0, u1] its span along it (the two facing wall faces),
 * `at` / `width` across it, `y` = deck top (the storey floor of `level` in both buildings), `ends` = each building
 * with its facing wall's side. Undefined when the two buildings do not face each other across a gap.
 */
export interface BridgeSpan { run: 'x' | 'z'; u0: number; u1: number; at: number; width: number; y: number; ends: [{ b: BuildingDef; side: Side }, { b: BuildingDef; side: Side }] }
export function bridgeSpan(c: Pick<CampusDef, 'buildings'>, br: BridgeDef): BridgeSpan | undefined {
  const p = c.buildings.find(b => b.id === br.between[0]), q = c.buildings.find(b => b.id === br.between[1]);
  if (!p || !q) return undefined;
  const y = floorStack(p).find(st => st.level === br.level)?.y ?? 0;
  for (const run of ['x', 'z'] as const) {
    const pos = (b: BuildingDef) => (run === 'x' ? b.x : b.z), half = (b: BuildingDef) => (run === 'x' ? b.w : b.d) / 2;
    const [lo, hi] = pos(p) < pos(q) ? [p, q] : [q, p];
    const u0 = pos(lo) + half(lo), u1 = pos(hi) - half(hi);
    // facing across a gap along `run`, and the deck's centre line inside both facing walls
    const across = (b: BuildingDef) => (run === 'x' ? [b.z - b.d / 2, b.z + b.d / 2] : [b.x - b.w / 2, b.x + b.w / 2]);
    if (u1 <= u0 + EPS || ![lo, hi].every(b => { const [a, z] = across(b); return br.at > a && br.at < z; })) continue;
    return { run, u0, u1, at: br.at, width: br.width, y, ends: [{ b: lo, side: `+${run}` }, { b: hi, side: `-${run}` }] };
  }
  return undefined;
}
/** The entrance of `b` on `side` at `level` whose centre line is world `at` (a 连廊门), if any. */
export function bridgeDoor(b: BuildingDef, side: Side, level: number, at: number): EntranceDef | undefined {
  const centre = side[1] === 'x' ? b.z : b.x;
  return (b.entrances ?? []).find(e => e.side === side && entranceLevel(e) === level && Math.abs(centre + e.at - at) < 1e-3);
}

/** Global room id, the form `?scene=` and saves use: `A.4F.class7`, basements `LIB.B1.stacks`. */
export const roomKey = (b: string, level: number, room: string) => `${b}.${level > 0 ? `${level}F` : `B${-level}`}.${room}`;

const KINDS: readonly string[] = ['classroom', 'office', 'corridor', 'toilet', 'water', 'stairs', 'storage', 'hall', 'guard', 'stacks', 'reading', 'compact', 'server', 'court', 'equip', 'dining', 'kitchen', 'shop', 'auditorium', 'stage', 'understage', 'lab', 'prep', 'darkroom', 'boiler', 'other'];
const EPS = 1e-6;
const PATTERNS: readonly string[] = ['bond', 'grid', 'checker', 'lawn'];
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPos = (v: unknown): v is number => isNum(v) && v > 0;
const isHex = (v: unknown) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
/** a nightRooms entry: storey (`3F`, basements `B1`) + room id */
export const NIGHT_ROOM = /^(?:[1-9]\d*F|B[1-9]\d*)\.[A-Za-z][A-Za-z0-9_-]*$/;
/** `3F.yuwen` → level 3 + room id (`B1.x` → level −1). */
export const parseNightRoom = (k: string) => {
  const [s, id] = k.split('.');
  return { level: s[0] === 'B' ? -Number(s.slice(1)) : Number(s.slice(0, -1)), id };
};
const isId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(v);
interface Rect { x: number; z: number; w: number; d: number }
const rectOk = (r: Partial<Rect>) => isNum(r.x) && isNum(r.z) && isPos(r.w) && isPos(r.d);
/** a fully inside b (b centred at the origin when local) */
const inside = (a: Rect, b: Rect) => Math.abs(a.x - b.x) + a.w / 2 <= b.w / 2 + EPS && Math.abs(a.z - b.z) + a.d / 2 <= b.d / 2 + EPS;
const overlap = (a: Rect, b: Rect) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 - EPS && Math.abs(a.z - b.z) < (a.d + b.d) / 2 - EPS;
/** length of the wall of `r` on `side` */
const wallLen = (r: Rect, side: Side) => side[1] === 'x' ? r.d : r.w;

/** Openings (doors + windows) of one room: in a wall, fitting the storey, not overlapping on the same side. */
function checkOpenings(room: RoomDef, floorH: number, at: string, errs: string[]): void {
  const spans: { side: Side; a: number; b: number; what: string }[] = [];
  const each = (list: unknown, what: 'door' | 'window') => {
    if (list === undefined) return;
    if (!Array.isArray(list)) { errs.push(`${at}: ${what}s must be an array`); return; }
    list.forEach((o: Partial<DoorDef & WindowDef>, i) => {
      const w = `${at} ${what}[${i}]`;
      if (!SIDES.includes(o.side as string)) { errs.push(`${w}: bad side ${String(o.side)}`); return; }
      if (!isNum(o.at) || !isPos(o.width)) { errs.push(`${w}: needs numeric at and width > 0`); return; }
      const half = wallLen(room, o.side as Side) / 2;
      if (Math.abs(o.at) + o.width / 2 > half + EPS) errs.push(`${w}: runs past the end of the ${o.side} wall`);
      if (what === 'door') {
        const h = o.height ?? 2.1;
        if (!isPos(h) || h > floorH) errs.push(`${w}: height ${h} does not fit the ${floorH} m storey`);
        if (o.key !== undefined && !isId(o.key)) errs.push(`${w}: bad key id ${String(o.key)}`);
        if (o.iron !== undefined && typeof o.iron !== 'boolean') errs.push(`${w}: iron must be true or false`);
      } else {
        if (!isNum(o.sill) || o.sill < 0 || !isPos(o.height)) errs.push(`${w}: needs sill ≥ 0 and height > 0`);
        else if (o.sill + o.height > floorH) errs.push(`${w}: top ${o.sill + o.height} m above the ${floorH} m storey`);
        if (o.depth !== undefined && !isPos(o.depth)) errs.push(`${w}: depth must be > 0`);
        if (o.hatch !== undefined && (!isPos(o.hatch) || o.hatch > 0.6)) errs.push(`${w}: hatch must be in (0, 0.6] m`);
      }
      const s = { side: o.side as Side, a: o.at - o.width / 2, b: o.at + o.width / 2, what: w };
      for (const t of spans) if (t.side === s.side && s.a < t.b - EPS && t.a < s.b - EPS) errs.push(`${w}: overlaps ${t.what}`);
      spans.push(s);
    });
  };
  each(room.doors, 'door');
  each(room.windows, 'window');
}

/** Facade rule, entrances and parapet: positive sizes, windows fit every storey and their bay, entrances fit the wall. */
function checkFacade(b: BuildingDef, errs: string[]): void {
  const at = `building ${b.id}`;
  if (b.parapet !== undefined && (!isNum(b.parapet) || b.parapet < 0)) errs.push(`${at}: parapet must be ≥ 0`);
  if (b.material !== undefined && b.material !== 'render' && b.material !== 'brick') errs.push(`${at}: bad material ${String(b.material)}`);
  if (b.trim !== undefined && !isHex(b.trim)) errs.push(`${at}: bad trim color ${String(b.trim)}`);
  if (b.layout !== undefined && b.layout !== 'classroom' && b.layout !== 'office') errs.push(`${at}: bad layout ${String(b.layout)}`);
  if (b.dado !== undefined && !isHex(b.dado)) errs.push(`${at}: bad dado color ${String(b.dado)}`);
  if (b.enterable !== undefined && typeof b.enterable !== 'boolean') errs.push(`${at}: enterable must be true / false`);
  const ch = b.chimney;
  if (ch !== undefined && !(isNum(ch.x) && isNum(ch.z) && isPos(ch.w) && isPos(ch.d) && isPos(ch.h))) errs.push(`${at}: chimney needs x, z and w, d, h > 0`);
  const cs = b.coalStore;
  if (cs !== undefined && !(isNum(cs.x) && isNum(cs.z) && isPos(cs.w) && isPos(cs.d) && isPos(cs.h))) errs.push(`${at}: coalStore needs x, z and w, d, h > 0`);
  const tr = b.tankRoom;
  if (tr !== undefined && !(isNum(tr.x) && isNum(tr.z) && isPos(tr.w) && isPos(tr.d) && isPos(tr.h) && SIDES.includes(tr.door?.side) && isNum(tr.door?.at)
    && SIDES.includes(tr.ladder?.side) && isNum(tr.ladder?.at) && (tr.back === undefined || SIDES.includes(tr.back)))) errs.push(`${at}: tankRoom needs x, z, w, d, h > 0, door / ladder { side, at }`);
  if (b.nightTube !== undefined && (!isNum(b.nightTube) || b.nightTube < 0 || b.nightTube > 1 || !b.nightRooms)) errs.push(`${at}: nightTube must be 0..1, with nightRooms`);
  if (b.dayLit !== undefined && typeof b.dayLit !== 'boolean') errs.push(`${at}: dayLit must be a boolean`);
  if (b.nightLit !== undefined && (!isNum(b.nightLit) || b.nightLit < 0 || b.nightLit > 1)) errs.push(`${at}: nightLit must be 0..1`);
  if (b.nightRooms !== undefined && (!Array.isArray(b.nightRooms) || b.nightRooms.some(k => typeof k !== 'string' || !NIGHT_ROOM.test(k))))
    errs.push(`${at}: nightRooms must be a list of '3F.room' keys`);
  const fh = b.floorHeight ?? FLOOR_HEIGHT;
  const storeys = b.floors.filter(f => Number.isInteger(f.level) && f.level > 0).map(f => f.h ?? fh);
  const lowest = storeys.length ? Math.min(...storeys) : fh;
  const f = b.facade as Partial<FacadeDef> | undefined;
  if (f !== undefined) {
    const fat = `${at} facade`;
    if (!isPos(f.bay) || !isPos(f.width) || !isPos(f.height) || !isPos(f.depth) || !isNum(f.sill) || f.sill < 0) errs.push(`${fat}: needs bay, width, height, depth > 0 and sill ≥ 0`);
    else {
      if (f.width > f.bay - 0.2 + EPS) errs.push(`${fat}: width ${f.width} leaves < 0.2 m of wall in a ${f.bay} m bay`);
      if (f.sill + f.height > lowest - 0.3 + EPS) errs.push(`${fat}: window top ${f.sill + f.height} m leaves < 0.3 m under the ${lowest} m storey`);
      if (f.depth > 0.6) errs.push(`${fat}: depth ${f.depth} deeper than a wall`);
    }
    if (f.margin !== undefined && (!isNum(f.margin) || f.margin < 0)) errs.push(`${fat}: margin must be ≥ 0`);
    if (f.sides !== undefined && (!Array.isArray(f.sides) || !f.sides.every(s => SIDES.includes(s)))) errs.push(`${fat}: bad sides`);
    for (const k of ['frame', 'glass'] as const) if (f[k] !== undefined && !isHex(f[k])) errs.push(`${fat}: bad ${k} color ${String(f[k])}`);
  }
  if (b.entrances === undefined) return;
  if (!Array.isArray(b.entrances)) { errs.push(`${at}: entrances must be an array`); return; }
  const spans: { side: Side; level: number; a: number; b: number }[] = [];
  b.entrances.forEach((e: Partial<EntranceDef>, i) => {
    const eat = `${at} entrance[${i}]`;
    if (!SIDES.includes(e.side as string)) { errs.push(`${eat}: bad side ${String(e.side)}`); return; }
    if (!isNum(e.at) || !isPos(e.width) || !isPos(e.height)) { errs.push(`${eat}: needs numeric at, width and height > 0`); return; }
    const level = e.level ?? 1, storey = b.floors.find(fl => fl.level === level);
    if (!Number.isInteger(level) || level < 1 || !storey) { errs.push(`${eat}: level ${String(e.level)} is not an above-ground storey of the building`); return; }
    const sh = storey.h ?? fh, what = level === 1 ? 'ground storey' : `${level}F storey`;
    if (Math.abs(e.at) + e.width / 2 > wallLen(b, e.side as Side) / 2 - 0.3 + EPS) errs.push(`${eat}: runs past the end of the ${e.side} wall`);
    if (e.height > sh - 0.3 + EPS) errs.push(`${eat}: height ${e.height} does not fit the ${sh} m ${what}`);
    if (e.canopy !== undefined && (level !== 1 || Object.values(e.canopy).some(v => !isPos(v)))) errs.push(`${eat}: canopy is a ground entrance's, its sizes > 0`);
    const s = { side: e.side as Side, level, a: e.at - e.width / 2, b: e.at + e.width / 2 };
    if (spans.some(t => t.side === s.side && t.level === s.level && s.a < t.b + 0.2 && t.a < s.b + 0.2)) errs.push(`${eat}: overlaps another entrance`);
    spans.push(s);
  });
}

/** 天井: an enterable building, a ring ≥ COURT_RING_MIN deep all round, no room or stairwell in it or its walls. */
function checkCourtyard(b: BuildingDef, errs: string[]): void {
  const c = b.courtyard as Partial<CourtyardDef> | undefined;
  if (c === undefined) return;
  const at = `building ${b.id} courtyard`;
  if (!rectOk(c)) { errs.push(`${at}: needs x, z and w, d > 0`); return; }
  if (!isHollow(b)) errs.push(`${at}: only an enterable building (with stairwells) can have one`);
  const r = courtOuter(b)!;
  const ring = Math.min(r.x0 + b.w / 2, b.w / 2 - r.x1, r.z0 + b.d / 2, b.d / 2 - r.z1) + WALL_T;
  if (ring < COURT_RING_MIN - EPS) errs.push(`${at}: leaves a ${ring.toFixed(2)} m ring (< ${COURT_RING_MIN} m) to the outer wall`);
  const wall: Rect = { x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2, w: r.x1 - r.x0, d: r.z1 - r.z0 };
  for (const s of b.stairwells ?? []) if (rectOk(s) && overlap(s, wall)) errs.push(`${at}: overlaps stairwell ${s.id}`);
  for (const f of b.floors) for (const room of f.rooms ?? []) if (rectOk(room) && overlap(room, wall)) errs.push(`${at}: overlaps room ${f.level}F ${room.id}`);
  if (c.doors === undefined) return;
  if (!Array.isArray(c.doors)) { errs.push(`${at}: doors must be an array`); return; }
  const gh = b.floors.find(fl => fl.level === 1)?.h ?? b.floorHeight ?? FLOOR_HEIGHT;
  const spans: { side: Side; a: number; b: number }[] = [];
  c.doors.forEach((e: Partial<EntranceDef>, i) => {
    const eat = `${at} door[${i}]`;
    if (!SIDES.includes(e.side as string)) { errs.push(`${eat}: bad side ${String(e.side)}`); return; }
    if (!isNum(e.at) || !isPos(e.width) || !isPos(e.height)) { errs.push(`${eat}: needs numeric at, width and height > 0`); return; }
    if (Math.abs(e.at) + e.width / 2 > wallLen(c as Rect, e.side as Side) / 2 - 0.3 + EPS) errs.push(`${eat}: runs past the end of the ${e.side} wall`);
    if (e.height > gh - 0.3 + EPS) errs.push(`${eat}: height ${e.height} does not fit the ${gh} m ground storey`);
    const s = { side: e.side as Side, a: e.at - e.width / 2, b: e.at + e.width / 2 };
    if (spans.some(t => t.side === s.side && s.a < t.b + 0.2 && t.a < s.b + 0.2)) errs.push(`${eat}: overlaps another door`);
    spans.push(s);
  });
}

/** rename: shape only (whether its keys are in the default layout is world/rooms.ts renameProblems, at load). */
function checkRename(f: FloorDef, at: string, errs: string[]): void {
  const r = f.rename as unknown;
  if (r === undefined) return;
  if (!r || typeof r !== 'object' || Array.isArray(r)) { errs.push(`${at}: rename must be an object`); return; }
  if (f.rooms !== undefined) errs.push(`${at}: rename only applies to the default layout, not with explicit rooms`);
  const ids = new Set<string>();
  for (const [k, v] of Object.entries(r as Record<string, Partial<{ id: unknown; name: unknown; kind: unknown }>>)) {
    const rat = `${at} rename ${k}`;
    if (!isId(k)) errs.push(`${rat}: bad room id`);
    if (!v || typeof v !== 'object' || !isId(v.id)) { errs.push(`${rat}: needs a valid new id`); continue; }
    if (ids.has(v.id)) errs.push(`${rat}: duplicate new id ${v.id}`);
    ids.add(v.id);
    if (typeof v.name !== 'string' || !v.name) errs.push(`${rat}: missing name`);
    if (v.kind !== undefined && !KINDS.includes(v.kind as string)) errs.push(`${rat}: bad kind ${String(v.kind)}`);
  }
}

function checkBuilding(b: Partial<BuildingDef>, errs: string[]): void {
  const at = `building ${String(b.id)}`;
  if (!isId(b.id)) errs.push(`${at}: bad id`);
  if (typeof b.name !== 'string' || !b.name) errs.push(`${at}: missing name`);
  if (!isHex(b.color)) errs.push(`${at}: bad color ${String(b.color)}`);
  if (!rectOk(b)) { errs.push(`${at}: needs x, z and w, d > 0`); return; }
  if (b.floorHeight !== undefined && !isPos(b.floorHeight)) errs.push(`${at}: floorHeight must be > 0`);
  if (!Array.isArray(b.floors) || !b.floors.length) { errs.push(`${at}: needs ≥ 1 floor`); return; }
  const local: Rect = { x: 0, z: 0, w: b.w as number, d: b.d as number };
  const fh = b.floorHeight ?? FLOOR_HEIGHT;
  const levels = new Set<number>();
  for (const f of b.floors) {
    const fat = `${at} level ${String(f.level)}`;
    if (!Number.isInteger(f.level) || f.level === 0) { errs.push(`${fat}: level must be a non-zero integer`); continue; }
    if (levels.has(f.level)) errs.push(`${fat}: duplicate level`);
    levels.add(f.level);
    if (f.h !== undefined && !isPos(f.h)) errs.push(`${fat}: h must be > 0`);
    checkRename(f, fat, errs);
    if (f.rooms === undefined) continue;
    if (!Array.isArray(f.rooms)) { errs.push(`${fat}: rooms must be an array`); continue; }
    const ids = new Set<string>();
    const placed: RoomDef[] = [];
    for (const r of f.rooms as Partial<RoomDef>[]) {
      const rat = `${fat} room ${String(r.id)}`;
      if (!isId(r.id)) errs.push(`${rat}: bad id`);
      else if (ids.has(r.id)) errs.push(`${rat}: duplicate id`);
      ids.add(r.id as string);
      if (typeof r.name !== 'string' || !r.name) errs.push(`${rat}: missing name`);
      if (!KINDS.includes(r.kind as string)) errs.push(`${rat}: bad kind ${String(r.kind)}`);
      if (!rectOk(r)) { errs.push(`${rat}: needs x, z and w, d > 0`); continue; }
      const room = r as RoomDef;
      if (!inside(room, local)) errs.push(`${rat}: outside the building footprint`);
      for (const o of placed) if (overlap(room, o)) errs.push(`${rat}: overlaps room ${o.id}`);
      placed.push(room);
      checkOpenings(room, f.h ?? fh, rat, errs);
    }
  }
  checkFacade(b as BuildingDef, errs);
  checkCourtyard(b as BuildingDef, errs);
  const lv = [...levels];
  if (!levels.has(1)) errs.push(`${at}: needs a ground floor (level 1)`);
  const top = Math.max(...lv, 0), bottom = Math.min(...lv, 0);
  for (let l = bottom; l <= top; l++) if (l !== 0 && !levels.has(l)) errs.push(`${at}: level ${l} missing (floors must be contiguous)`);
  if (b.stairwells === undefined) return;
  if (!Array.isArray(b.stairwells)) { errs.push(`${at}: stairwells must be an array`); return; }
  const sids = new Set<string>();
  for (const s of b.stairwells as Partial<StairwellDef>[]) {
    const sat = `${at} stairwell ${String(s.id)}`;
    if (!isId(s.id)) errs.push(`${sat}: bad id`);
    else if (sids.has(s.id)) errs.push(`${sat}: duplicate id`);
    sids.add(s.id as string);
    if (!rectOk(s)) { errs.push(`${sat}: needs x, z and w, d > 0`); continue; }
    if (!inside(s as Rect, local)) errs.push(`${sat}: outside the building footprint`);
    if (!SIDES.includes(s.dir as string)) errs.push(`${sat}: bad dir ${String(s.dir)}`);
    if (s.rail !== undefined && s.rail !== 'panel' && s.rail !== 'bars') errs.push(`${sat}: bad rail ${String(s.rail)}`);
    if (s.windows !== undefined && s.windows !== 'grid' && s.windows !== 'landing') errs.push(`${sat}: bad windows ${String(s.windows)}`);
    if (s.lamp !== undefined && s.lamp !== 'sound') errs.push(`${sat}: bad lamp ${String(s.lamp)}`);
    if (s.cap !== undefined && !(isPos(s.cap) && s.cap >= STAIR.door.h + 0.2)) errs.push(`${sat}: cap must clear the door`);
    if (s.roof !== undefined && typeof s.roof !== 'boolean') errs.push(`${sat}: roof must be a boolean`);
    if (s.roof && s.cap !== undefined) errs.push(`${sat}: roof and cap exclude each other`);
    if (s.roof && Number.isInteger(s.to) && s.to !== Math.max(...levels)) errs.push(`${sat}: roof needs to = the top floor`);
    if (!Number.isInteger(s.from) || !Number.isInteger(s.to) || (s.from as number) >= (s.to as number)) errs.push(`${sat}: needs integer from < to`);
    else if (!levels.has(s.from as number) || !levels.has(s.to as number)) errs.push(`${sat}: connects a level the building does not have`);
    else if (SIDES.includes(s.dir as string)) for (const e of stairProblems(b as BuildingDef, s as StairwellDef, WALL_T)) errs.push(`${sat}: ${e}`);
  }
}

/** Every problem with a campus definition; empty = valid. Takes unknown so it can guard raw JSON. */
export function validateCampus(def: unknown): string[] {
  const c = def as Partial<CampusDef> | null;
  if (!c || typeof c !== 'object') return ['not an object'];
  const errs: string[] = [];
  if (c.version !== 1) errs.push(`unsupported version ${String(c.version)}`);
  if (!Array.isArray(c.size) || c.size.length !== 2 || !c.size.every(isPos)) errs.push('size must be [w, d] > 0');
  if (!isHex(c.groundColor)) errs.push(`bad groundColor ${String(c.groundColor)}`);
  if (!Number.isInteger(c.axisTrees) || (c.axisTrees as number) < 0) errs.push('axisTrees must be an integer ≥ 0');
  const w = c.wall as Partial<WallDef> | undefined;
  const bounds = w && isNum(w.minX) && isNum(w.maxX) && isNum(w.minZ) && isNum(w.maxZ) && w.minX < w.maxX && w.minZ < w.maxZ
    ? { x: (w.minX + w.maxX) / 2, z: (w.minZ + w.maxZ) / 2, w: w.maxX - w.minX, d: w.maxZ - w.minZ } : undefined;
  if (!w || !bounds) errs.push('wall needs minX < maxX, minZ < maxZ');
  else {
    if (!isPos(w.h) || !isPos(w.t) || !isPos(w.gateH)) errs.push('wall h, t, gateH must be > 0');
    const hhmm = (v: unknown) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
    if (w.gateOpen !== undefined && !(Array.isArray(w.gateOpen) && w.gateOpen.every(p => Array.isArray(p) && p.length === 2 && hhmm(p[0]) && hhmm(p[1]) && p[0] < p[1]))) errs.push('wall gateOpen must be [["HH:MM", "HH:MM"], …] windows, from < to');
    if (!isHex(w.color)) errs.push(`bad wall color ${String(w.color)}`);
    const g = w.gate;
    if (!Array.isArray(g) || !isNum(g[0]) || !isNum(g[1]) || g[0] >= g[1] || g[0] <= bounds.x - bounds.w / 2 || g[1] >= bounds.x + bounds.w / 2) errs.push('wall gate must be [x0 < x1] inside the south side');
    const lo = w.low;
    if (lo !== undefined) {
      const [a, b] = lo.side?.[1] === 'x' ? [bounds.z - bounds.d / 2, bounds.z + bounds.d / 2] : [bounds.x - bounds.w / 2, bounds.x + bounds.w / 2];
      if (!SIDES.includes(lo.side)) errs.push(`wall low: bad side ${String(lo.side)}`);
      else if (lo.side === '-z') errs.push('wall low: not on the gate side');
      else if (!isNum(lo.from) || !isNum(lo.to) || lo.from >= lo.to || lo.from < a + 1 || lo.to > b - 1) errs.push('wall low: needs from < to, ≥ 1 m in from the corners');
      if (!isPos(lo.h) || !isPos(w.h) || lo.h >= w.h) errs.push('wall low: h must be > 0 and below the wall');
      if (!Array.isArray(lo.tree) || lo.tree.length !== 2 || !lo.tree.every(isNum) || !inside({ x: lo.tree[0], z: lo.tree[1], w: 1, d: 1 }, bounds)) errs.push('wall low: tree must be [x, z] inside the wall');
    }
  }
  const within = (r: Rect) => !bounds || inside(r, bounds);
  if (!Array.isArray(c.lamps)) errs.push('lamps must be an array');
  else c.lamps.forEach((p, i) => {
    if (!Array.isArray(p) || p.length !== 2 || !p.every(isNum)) errs.push(`lamp[${i}]: must be [x, z]`);
    else if (!within({ x: p[0], z: p[1], w: 0, d: 0 })) errs.push(`lamp[${i}]: outside the wall`);
  });
  const wl = (c as { wallLamps?: unknown }).wallLamps;
  if (wl !== undefined && !Array.isArray(wl)) errs.push('wallLamps must be an array');
  else (wl as unknown[] | undefined)?.forEach((p, i) => {
    if (!Array.isArray(p) || p.length < 3 || p.length > 4 || !p.slice(0, 3).every(isNum) || !(p[2] > 0)
      || (p.length === 4 && !['+x', '-x', '+z', '-z'].includes(p[3]))) errs.push(`wallLamp[${i}]: must be [x, z, high > 0, side?]`);
    else if (!within({ x: p[0], z: p[1], w: 0, d: 0 })) errs.push(`wallLamp[${i}]: outside the wall`);
  });
  const props = c.props as Partial<Record<string, unknown[]>> | undefined;
  if (props !== undefined) {
    const placed = (k: string, ok: (p: unknown[]) => boolean, shape: string) => {
      const list = props[k];
      if (list === undefined) return;
      if (!Array.isArray(list)) { errs.push(`props.${k} must be an array`); return; }
      list.forEach((p, i) => {
        if (!Array.isArray(p) || !ok(p)) errs.push(`props.${k}[${i}]: must be ${shape}`);
        else if (!within({ x: p[0] as number, z: p[1] as number, w: 0, d: 0 })) errs.push(`props.${k}[${i}]: outside the wall`);
      });
    };
    const faced = (p: unknown[]) => p.length === 3 && isNum(p[0]) && isNum(p[1]) && SIDES.includes(p[2] as string);
    placed('bins', faced, '[x, z, side]');
    placed('benches', faced, '[x, z, side]');
    placed('beds', p => p.length === 4 && isNum(p[0]) && isNum(p[1]) && isPos(p[2]) && isPos(p[3]), '[x, z, w, d]');
    placed('sheds', p => p.length === 4 && isNum(p[0]) && isNum(p[1]) && isPos(p[2]) && SIDES.includes(p[3] as string), '[x, z, length, side]');
  }
  const ids = new Set<string>();
  const claim = (id: unknown, what: string) => { if (typeof id === 'string') { if (ids.has(id)) errs.push(`${what} ${id}: id already used`); ids.add(id); } };
  if (!Array.isArray(c.platforms)) errs.push('platforms must be an array');
  else for (const p of c.platforms as Partial<PlatformDef>[]) {
    const at = `platform ${String(p.id)}`;
    claim(p.id, 'platform');
    if (!isId(p.id)) errs.push(`${at}: bad id`);
    if (!rectOk(p) || !isPos(p.h)) { errs.push(`${at}: needs x, z and w, d, h > 0`); continue; }
    if (!isHex(p.color)) errs.push(`${at}: bad color ${String(p.color)}`);
    if (!within(p as Rect)) errs.push(`${at}: outside the wall`);
    if (p.stairs && (!SIDES.includes(p.stairs.side) || !isPos(p.stairs.width) || !Number.isInteger(p.stairs.steps) || p.stairs.steps < 2)) errs.push(`${at}: stairs need a side, width > 0, steps ≥ 2`);
    if (p.pole !== undefined && !isPos(p.pole)) errs.push(`${at}: pole must be > 0`);
  }
  if (c.paving !== undefined) {
    if (!Array.isArray(c.paving)) errs.push('paving must be an array');
    else {
      const ok: Rect[] = [];
      for (const p of c.paving as Partial<PavingDef>[]) {
        const at = `paving ${String(p.id)}`;
        claim(p.id, 'paving');
        if (!isId(p.id)) errs.push(`${at}: bad id`);
        if (!rectOk(p)) { errs.push(`${at}: needs x, z and w, d > 0`); continue; }
        if (!isHex(p.color)) errs.push(`${at}: bad color ${String(p.color)}`);
        if (!within(p as Rect)) errs.push(`${at}: outside the wall`);
        if (!PATTERNS.includes(p.pattern as string)) errs.push(`${at}: bad pattern ${String(p.pattern)}`);
        if (!Array.isArray(p.tile) || p.tile.length !== 2 || !p.tile.every(isPos)) errs.push(`${at}: tile must be [x, z] > 0`);
        const curbOk = (k: unknown) => SIDES.includes(k as string) || (!!k && typeof k === 'object' && SIDES.includes((k as CurbDef).side)
          && Array.isArray((k as CurbDef).gaps) && (k as CurbDef).gaps.every(g => Array.isArray(g) && g.length === 2 && g.every(isNum) && g[0] < g[1]));
        if (p.curb !== undefined && (!Array.isArray(p.curb) || !p.curb.every(curbOk))) errs.push(`${at}: curb must list sides or { side, gaps: [[from < to]] }`);
        if (p.hedge !== undefined && (!Array.isArray(p.hedge) || !p.hedge.every(curbOk))) errs.push(`${at}: hedge must list sides or { side, gaps: [[from < to]] }`);
        const b = p.border;
        if (b !== undefined && (!isPos(b.w) || !isHex(b.color) || b.w * 2 >= Math.min(p.w as number, p.d as number))) errs.push(`${at}: border needs a color and 0 < w < half the rect`);
        if (ok.some(r => overlap(r, p as Rect))) errs.push(`${at}: overlaps another paving rect`);
        ok.push(p as Rect);
      }
    }
  }
  if (c.covers !== undefined) {
    if (!Array.isArray(c.covers)) errs.push('covers must be an array');
    else for (const k of c.covers as unknown[]) {
      const v = k as unknown[], at = `cover ${JSON.stringify(k)}`;
      if (!Array.isArray(v) || v.length !== 4 || !['grate', 'lid'].includes(v[0] as string) || !isNum(v[1]) || !isNum(v[2]) || !['x', 'z'].includes(v[3] as string)) { errs.push(`${at}: must be [grate|lid, x, z, x|z]`); continue; }
      const [x, z] = [v[1] as number, v[2] as number], [a, b] = v[0] === 'lid' ? [0.4, 0.4] : [0.375, 0.225];
      const [hx, hz] = v[3] === 'x' ? [a, b] : [b, a];
      const on = (c.paving ?? []).some(p => Math.abs(x - p.x) <= p.w / 2 - hx + 1e-6 && Math.abs(z - p.z) <= p.d / 2 - hz + 1e-6);
      if (!on) errs.push(`${at}: not on a paving rect`);
    }
  }
  const sd = c.street as Partial<StreetDef> | undefined;
  if (sd !== undefined) {
    if (![sd.walk, sd.road, sd.far].every(isPos)) errs.push('street: walk, road, far must be > 0');
    if (!Number.isInteger(sd.lanes) || (sd.lanes as number) < 2 || (sd.lanes as number) % 2) errs.push('street: lanes must be an even integer ≥ 2');
    if (!Array.isArray(sd.zebra) || sd.zebra.length !== 2 || !isNum(sd.zebra[0]) || !isPos(sd.zebra[1])) errs.push('street: zebra must be [x, width > 0]');
    if (!Array.isArray(sd.hedge) || sd.hedge.length !== 2 || !sd.hedge.every(isPos)) errs.push('street: hedge must be [deep, high] > 0');
    const sl = sd.lamps;
    if (sl !== undefined && (!Array.isArray(sl) || sl.length !== 3 || !sl.every(isPos))) errs.push('street: lamps must be [pitch, high, arm] > 0');
    else if (sl !== undefined && isPos(sd.road) && sl[2] >= sd.road / 2) errs.push('street: lamp arm must stay on the far half of the road');
  }
  const f = c.field as Partial<FieldDef> | undefined, st = f?.stand;
  let fieldR: Rect | undefined;
  if (f !== undefined) {
    claim(f.id, 'field');
    if (!isId(f.id)) errs.push(`field ${String(f.id)}: bad id`);
    if (!isNum(f.x) || !isNum(f.z) || ![f.straight, f.r, f.lane, f.apron].every(isPos) || !Number.isInteger(f.lanes) || (f.lanes as number) < 1) errs.push('field needs x, z, straight, r, lane, apron > 0 and lanes ≥ 1');
    else if (!st || ![st.len, st.rise, st.run, st.gap, st.dais].every(isPos) || !Number.isInteger(st.rows) || st.rows < 4 || st.dais >= st.len) errs.push('field stand needs len > dais > 0, rise, run, gap > 0 and rows ≥ 4');
    else if (!within(fieldR = fieldRect(f as FieldDef))) errs.push(`field ${f.id}: outside the wall`);
  }
  if (!Array.isArray(c.buildings) || !c.buildings.length) return [...errs, 'needs ≥ 1 building'];
  const placed: BuildingDef[] = [], sound = new Set<BuildingDef>();
  for (const b of c.buildings as Partial<BuildingDef>[]) {
    claim(b.id, 'building');
    const before = errs.length;
    checkBuilding(b, errs);
    if (errs.length === before) sound.add(b as BuildingDef);
    if (errs.length > before && !rectOk(b)) continue;
    if (!within(b as Rect)) errs.push(`building ${String(b.id)}: outside the wall`);
    for (const o of placed) if (overlap(b as Rect, o)) errs.push(`building ${String(b.id)}: overlaps building ${o.id}`);
    if (fieldR && overlap(b as Rect, fieldR)) errs.push(`building ${String(b.id)}: overlaps the field`);
    placed.push(b as BuildingDef);
  }
  if (c.bridges === undefined) return errs;
  if (!Array.isArray(c.bridges)) return [...errs, 'bridges must be an array'];
  for (const br of c.bridges as Partial<BridgeDef>[]) {
    const at = `bridge ${String(br.id)}`;
    claim(br.id, 'bridge');
    if (!isId(br.id)) errs.push(`${at}: bad id`);
    if (typeof br.name !== 'string' || !br.name) errs.push(`${at}: missing name`);
    if (!Array.isArray(br.between) || br.between.length !== 2 || br.between[0] === br.between[1]) { errs.push(`${at}: between must name two buildings`); continue; }
    const ends = br.between.map(id => placed.find(b => b.id === id));
    if (ends.some(b => !b || !isHollow(b))) { errs.push(`${at}: between must name two enterable buildings (with stairwells)`); continue; }
    if (ends.some(b => !sound.has(b!))) continue; // (their own problems are listed already)
    if (!Number.isInteger(br.level) || (br.level as number) < 2 || !isNum(br.at) || !isPos(br.width)) { errs.push(`${at}: needs an integer level ≥ 2, numeric at and width > 0`); continue; }
    const ys = ends.map(b => floorStack(b!).find(st => st.level === br.level)?.y);
    if (ys.some(y => y === undefined)) { errs.push(`${at}: level ${br.level} is not a storey of both buildings`); continue; }
    if (Math.abs(ys[0]! - ys[1]!) > EPS) errs.push(`${at}: the ${br.level}F floors are at different heights (${ys.join(' vs ')})`);
    const span = bridgeSpan({ buildings: placed }, br as BridgeDef);
    if (!span) { errs.push(`${at}: the buildings do not face each other across a gap on its centre line`); continue; }
    for (const { b, side } of span.ends) {
      const d = bridgeDoor(b, side, br.level as number, br.at);
      if (!d) errs.push(`${at}: building ${b.id} has no ${br.level}F entrance on its ${side} wall at ${br.at}`);
      else if (d.width > (br.width as number) - 0.4 + EPS) errs.push(`${at}: building ${b.id}'s 连廊门 (${d.width} m) leaves < 0.2 m of deck either side`);
    }
  }
  return errs;
}

/** Validated campus or a thrown error listing every problem (boot must not run on a broken map). */
export function loadCampus(def: unknown): CampusDef {
  const errs = validateCampus(def);
  if (errs.length) throw new Error(`campus.json invalid:\n  ${errs.join('\n  ')}`);
  return def as CampusDef;
}
