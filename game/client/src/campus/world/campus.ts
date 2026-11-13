import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import campusJson from '../../../../shared/campus/campus.json';
import { box, cylinder, stairs, type AABB } from '../../../../shared/campus/collision.ts';
import { buildingGeometry, facadeFrames, facadeOpenings, frameAxes } from './building.ts';
import { groundHoles, interiorColliders, interiorGeometry, stairPlans } from './interior.ts';
import { STAIR } from '../../../../shared/campus/stairs.ts';
import { groundPlane } from './wet.ts';
import { nightRoomProblems, renameProblems } from './rooms.ts';
import { furnitureGeometry, storeyFurniture } from './classroom.ts';
import { tankRoomColliders, tankRoomFurniture, tankRoomGeometry } from './tankroom.ts';
import { roofDrainGeometry } from './roofdrain.ts';
import { Blackboards, examCountdown } from './blackboard.ts';
import { Decals } from './decals.ts';
import { Flats } from './flats.ts';
import { gateColliders, SlidingGate } from './gate.ts';
import { lowWallColliders, lowWallGeometry, patchLowWall } from './lowwall.ts';
import { perimeterGeometry, perimeterParts } from './perimeter.ts';
import { COLOR as OUT_COLOR, outskirtsGeometry, outskirtsWires, patchOutskirts } from './outskirts.ts';
import { curbBoxes, flagPoleColliders, hedgeBoxes, patchPaving, pavingGeometry, streetParts, treePitBoxes } from './paving.ts';
import { bridgeColliders, bridgeGeometry, bridgeLamps } from './bridges.ts';
import { fieldColliders } from './field.ts';
import { cabinetColliders, Noticeboards } from './noticeboard.ts';
import { AxisTrees, TREE } from './trees.ts';
import { Flag } from './flag.ts';
import { propColliders, propGeometry } from './props.ts';
import { shedColliders, shedGeometry } from './shed.ts';
import { outdoorCameraParts } from './safety.ts';
import { canYardColliders, canYardParts } from './canyard.ts';
import { gymFrontParts, gymSideColliders, gymSideParts, gymWestColliders, gymWestParts } from './gymfront.ts';
import { hallBackColliders, hallBackParts, hallFrontColliders, hallFrontParts } from './hallfront.ts';
import { createFacadeUniforms, patchFacade, type FacadeUniforms } from '../render/facade.ts';
import { createInteriorLightUniforms, interiorLightMaterial, type InteriorLightUniforms } from '../render/interior_light.ts';
import { buildingHeight, courtRect, floorStack, isHollow, loadCampus, roofTop, type BuildingDef, type CampusDef, type PlatformDef, type Side, type WallDef } from '../../../../shared/campus/campus_schema.ts';
import { runBuildStages, type BuildStageOptions } from '../buildStages.ts';

/** Split one big mesh into 30 m cells (by triangle centroid) so frustum culling can drop the far ones. */
function addCells(scene: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, name: string, cell = 30): void {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.getAttribute('position');
  const buckets = new Map<string, number[]>();
  for (let t = 0; t + 2 < pos.count; t += 3) {
    const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3, cz = (pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2)) / 3;
    const k = `${Math.floor(cx / cell)},${Math.floor(cz / cell)}`;
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(t, t + 1, t + 2);
  }
  for (const [k, verts] of buckets) {
    const out = new THREE.BufferGeometry();
    for (const [an, a] of Object.entries(g.attributes)) {
      const arr = new (a.array.constructor as new (n: number) => Float32Array)(verts.length * a.itemSize);
      verts.forEach((v, i) => { for (let c = 0; c < a.itemSize; c++) arr[i * a.itemSize + c] = a.array[v * a.itemSize + c]; });
      out.setAttribute(an, new THREE.BufferAttribute(arr, a.itemSize, a.normalized));
    }
    out.computeBoundingSphere();
    const m = new THREE.Mesh(out, mat);
    m.name = `${name}@${k}`;
    scene.add(m);
  }
}

export { FLOOR_HEIGHT } from '../../../../shared/campus/campus_schema.ts';
export type { BuildingDef, PlatformDef, WallDef } from '../../../../shared/campus/campus_schema.ts';

/** data/campus/campus.json, validated once at import (a broken map fails loudly at boot, not as odd geometry). */
export const CAMPUS: CampusDef = loadCampus(campusJson);
{
  const errs = [...renameProblems(CAMPUS), ...nightRoomProblems(CAMPUS)];
  if (errs.length) throw new Error(`campus.json invalid:\n  ${errs.join('\n  ')}`);
}
const campus = CAMPUS;
/** 梧桐 trunk collider radius: the bark's base radius (world/trees.ts TREE.trunkR[0]), a cylinder so walking past glances off */
const TRUNK_R = TREE.trunkR[0];

/** Axis tree trunk positions (x, z), shared by the instanced mesh and the colliders. */
export function treePositions(n = campus.axisTrees): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) for (let s = 0; s < 2; s++) out.push([s ? 6 : -6, 8 + i * 6]);
  return out;
}

/** Platform body + its stairs (flight descends away from the chosen side) + the pole's column (`pole: false` drops it). */
export function platformBoxes(p: PlatformDef, pole = true): AABB[] {
  const out = [box(p.x, p.z, p.w, p.d, p.h)];
  if (p.stairs) {
    const { side, width, steps } = p.stairs;
    const rise = p.h / steps, run = 0.3;
    const len = (steps - 1) * run;
    // stairs() builds upward along dir, so start at the far foot and walk toward the platform
    const inward = (side[0] === '+' ? '-' : '+') + side[1] as Side;
    const fx = side === '+x' ? p.x + p.w / 2 + len : side === '-x' ? p.x - p.w / 2 - len : p.x;
    const fz = side === '+z' ? p.z + p.d / 2 + len : side === '-z' ? p.z - p.d / 2 - len : p.z;
    out.push(...stairs(fx, fz, inward, width, steps - 1, rise, run)); // top step is the platform itself
  }
  if (p.pole && pole) out.push(box(p.x, p.z + p.d / 4, 0.16, 0.16, p.h + p.pole));
  return out;
}

/**
 * Perimeter wall as 4 sides with a gate gap in the south side (the 电动伸缩门 and 门柱 in it: world/gate.ts); the side
 * with the 西北矮墙 (`low`) in three pieces, the middle one `low.h` high (its 压顶, 碎玻璃, 铁丝, 墙垛: world/lowwall.ts).
 */
export function wallBoxes(w: WallDef): AABB[] {
  const cx = (w.minX + w.maxX) / 2, cz = (w.minZ + w.maxZ) / 2;
  const W = w.maxX - w.minX, D = w.maxZ - w.minZ;
  const [g0, g1] = w.gate;
  const side = (s: Side, full: AABB): AABB[] => {
    const lo = w.low;
    if (!lo || lo.side !== s) return [full];
    // along z on a ±x side (x fixed), along x on +z
    const alongZ = s[1] === 'x', at = alongZ ? (full.minX + full.maxX) / 2 : (full.minZ + full.maxZ) / 2;
    const [a, b] = alongZ ? [full.minZ, full.maxZ] : [full.minX, full.maxX];
    const piece = (u0: number, u1: number, h: number) =>
      alongZ ? box(at, (u0 + u1) / 2, w.t, u1 - u0, h) : box((u0 + u1) / 2, at, u1 - u0, w.t, h);
    return [piece(a, lo.from, w.h), piece(lo.from, lo.to, lo.h), piece(lo.to, b, w.h)];
  };
  return [
    ...side('+z', box(cx, w.maxZ, W + w.t, w.t, w.h)),
    ...side('-x', box(w.minX, cz, w.t, D, w.h)),
    ...side('+x', box(w.maxX, cz, w.t, D, w.h)),
    box((w.minX + g0) / 2, w.minZ, g0 - w.minX + w.t, w.t, w.h),
    box((g1 + w.maxX) / 2, w.minZ, w.maxX - g1 + w.t, w.t, w.h),
  ];
}

/** Every 梧桐 (x, z): the axis pairs, then the one inside the 西北矮墙 (appended, so the axis seeds stay put). */
export function allTreePositions(): [number, number][] {
  return [...treePositions(), ...(campus.wall.low ? [campus.wall.low.tree] : [])];
}

/** South edge of the ground (world z): 10 m past the 门外马路's 绿篱, or 2 m outside the wall with no street. */
export function groundSouth(c: CampusDef): number {
  const w = c.wall, s = c.street;
  return s ? w.minZ - w.t / 2 - s.walk - s.road - s.far - s.hedge[0] - 10 : w.minZ - 2;
}
/** The campus ground: size, centre (x, z) and the stairwell holes cut into it (shared by the ground and the puddle layer). */
export const GROUND = {
  size: campus.size as [number, number], center: [0, campus.size[1] / 2 + groundSouth(campus)] as [number, number],
  holes: campus.buildings.flatMap(b => groundHoles(b).stairs),
  /** the puddle layer's holes (main.ts WetGround): every building's whole footprint, its 天井 kept wet (the stairwell
   *  holes lie inside), so no puddle shows through a ground-floor floor. */
  wetHoles: campus.buildings.map(b => ({ x0: b.x - b.w / 2, x1: b.x + b.w / 2, z0: b.z - b.d / 2, z1: b.z + b.d / 2, court: ((c = courtRect(b)) => c && { x0: b.x + c.x0, x1: b.x + c.x1, z0: b.z + c.z0, z1: b.z + c.z1 })() })),
};
/** Footprints with no ground plane for the walker (buildings over a 地下室: CollisionWorld.addHole). */
export const groundlessFootprints = () => campus.buildings.flatMap(b => { const f = groundHoles(b).footprint; return f ? [f] : []; });

/** Four unseen walls (1 m thick, 30 m high) just outside the ground's edge: past the 矮墙 or out of the gate the 荒地
 *  looks like it runs on (world/outskirts.ts), but the walker stops where the ground plane ends. */
export function groundEdgeColliders(): AABB[] {
  const [sx, sz] = GROUND.size, [cx, cz] = GROUND.center, t = 1, h = 30;
  return [
    box(cx - sx / 2 - t / 2, cz, t, sz + 2 * t, h), box(cx + sx / 2 + t / 2, cz, t, sz + 2 * t, h),
    box(cx, cz - sz / 2 - t / 2, sx + 2 * t, t, h), box(cx, cz + sz / 2 + t / 2, sx + 2 * t, t, h),
  ];
}

/** Every static collider of the greybox campus (buildings, 连廊, wall, platforms, tree trunks). */
export function campusColliders(): AABB[] {
  // enterable buildings are hollow (walls, slabs, stairs: world/interior.ts); the rest stay one solid box
  const out: AABB[] = campus.buildings.flatMap(b => (isHollow(b) ? interiorColliders(b) : [box(b.x, b.z, b.w, b.d, buildingHeight(b))]));
  for (const b of campus.buildings) if (b.chimney) out.push(box(b.x + b.chimney.x, b.z + b.chimney.z, b.chimney.w, b.chimney.d, b.chimney.h));
  for (const b of campus.buildings) if (b.coalStore) out.push(box(b.x + b.coalStore.x, b.z + b.coalStore.z, b.coalStore.w, b.coalStore.d, b.coalStore.h));
  for (const b of campus.buildings) out.push(...tankRoomColliders(b));
  out.push(...bridgeColliders(campus));
  out.push(...wallBoxes(campus.wall), ...gateColliders(campus.wall), ...lowWallColliders(campus.wall));
  for (const p of campus.platforms) out.push(...platformBoxes(p), ...flagPoleColliders(p));
  for (const [x, z] of allTreePositions()) out.push(cylinder(x, z, TRUNK_R, 5));
  out.push(...cabinetColliders());
  // 垃圾桶 / 长椅 / 花坛 (world/props.ts)
  out.push(...propColliders(campus.props));
  // 食堂楼后: 泔水桶, 菜筐, 煤气罐笼 (world/canyard.ts)
  out.push(...canYardColliders(campus), ...hallFrontColliders(campus), ...hallBackColliders(campus), ...gymSideColliders(campus), ...gymWestColliders(campus));
  // 自行车棚 (world/shed.ts): posts, slab, the rack with its bikes
  out.push(...shedColliders(campus.props));
  // 田径场: 看台 rows (each one step), seats, 主席台, goals (world/field.ts)
  if (campus.field) out.push(...fieldColliders(campus.field));
  // 路缘石 and 树池 frames: low enough to step onto (world/paving.ts)
  const st = campus.street ? streetParts(campus.wall, campus.street, campus.paving?.find(p => p.id === 'AXIS_ROAD')) : undefined;
  out.push(...groundEdgeColliders());
  for (const b of [...curbBoxes(campus.paving ?? []), ...treePitBoxes(treePositions()), ...hedgeBoxes(campus.paving ?? []).filter(b => !b.top), ...(st ? [...st.curbs, st.hedge[0]] : [])]) out.push({ minX: b.x0, minY: b.y0, minZ: b.z0, maxX: b.x1, maxY: b.y1, maxZ: b.z1 });
  return out;
}

/** One merged mesh for a list of boxes (a single draw call). */
function boxesMesh(boxes: AABB[], color: string): THREE.Mesh {
  const geo = mergeGeometries(boxes.map(b => {
    const g = new THREE.BoxGeometry(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ);
    g.translate((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
    return g;
  }));
  return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
}

/**
 * A storey's furniture mesh and the storey's height span (world y); `doors`: the storey's doorways seen from outside
 * (its entrances, 连廊门, 门卫室 hatch: interiorPortals).
 */
export interface FurnitureMesh { mesh: THREE.Mesh; b: BuildingDef; y0: number; y1: number; doors?: Portal[] }

/** Out in front of a doorway close enough to see in: how far out (m), how far past its jambs, how far below its storey. */
export const DOOR_VIEW = { out: 6, side: 2, below: 1.5 };

/** Whether the feet (x, y, z) stand outside `p` (its normal side), within DOOR_VIEW of it, at its storey's height. */
function beforeDoor(p: Portal, f: FurnitureMesh, x: number, y: number, z: number): boolean {
  const o = (x - p.c.x) * p.n.x + (z - p.c.z) * p.n.z;
  // along the doorway: its horizontal axis is the one the normal is not on
  const u = p.n.x !== 0 ? Math.abs(z - p.c.z) - (p.box.max.z - p.box.min.z) / 2 : Math.abs(x - p.c.x) - (p.box.max.x - p.box.min.x) / 2;
  return o > 0 && o < DOOR_VIEW.out && u < DOOR_VIEW.side && y >= f.y0 - DOOR_VIEW.below && y < f.y1 - 0.05;
}

/**
 * Only the storey the eye is on gets its furniture drawn (1 draw call indoors, none outside): through a window or
 * across the 天井 another storey's desks are a few dark pixels, not worth a draw call each. Standing out in front of
 * one of its doorways counts too, so the 门厅 / 门卫室 is furnished before the threshold, not filled in on it.
 */
export function showFurniture(list: FurnitureMesh[], x: number, y: number, z: number): void {
  for (const f of list) {
    const inside = Math.abs(x - f.b.x) < f.b.w / 2 && Math.abs(z - f.b.z) < f.b.d / 2;
    f.mesh.visible = inside ? y >= f.y0 - 0.05 && y < f.y1 - 0.05 : !!f.doors?.some(p => beforeDoor(p, f, x, y, z));
  }
}

/**
 * An opening the interior shows through from outside: its world box and outward normal (the side it is seen from);
 * `minEye`: lowest eye height it can be seen from (a door on the roof is behind the parapet from the ground).
 */
export interface Portal { box: THREE.Box3; c: THREE.Vector3; n: THREE.Vector3; minEye: number }
/** A building's interior mesh, the box the eye counts as in it (roof and 出屋面 included), and its open portals. */
export interface InteriorMesh { mesh: THREE.Mesh; b: BuildingDef; box: THREE.Box3; portals: Portal[] }

/**
 * Where an enterable building's inside can be seen from outside: the glass is opaque (render/facade.ts), so only
 * through its doorways — entrances and 连廊门 (facadeOpenings), a 门卫室 hatch, the 上屋面 door. (A 天井 door is
 * only seen from the well or the roof, both inside the building's box.)
 */
export function interiorPortals(b: BuildingDef): Portal[] {
  const out: Portal[] = [];
  const add = (p0: THREE.Vector3, p1: THREE.Vector3, n: THREE.Vector3, minEye = -Infinity) => {
    const box = new THREE.Box3().setFromPoints([p0, p1]);
    out.push({ box, c: box.getCenter(new THREE.Vector3()), n, minEye });
  };
  const openings = facadeOpenings(b).filter(o => o.kind === 'entrance' || o.hatch);
  for (const fr of facadeFrames(b).filter(f => !f.court)) {
    const { n, at } = frameAxes(fr);
    for (const o of openings) if (o.side === fr.side) add(at(o.u0, o.y0, 0), at(o.u1, o.y1, 0), n);
  }
  // 上屋面: the bulkhead's doorway on its door side (world/building.ts bulkhead), facing out onto the roof
  const H = buildingHeight(b);
  for (const p of stairPlans(b)) if (p.def.roof) {
    const s = p.doorSide, r = p.rect, x = s[1] === 'x', w = s[0] === '+' ? (x ? r.x1 : r.z1) : (x ? r.x0 : r.z0);
    const pt = (u: number, y: number) => (x ? new THREE.Vector3(b.x + w, y, b.z + u) : new THREE.Vector3(b.x + u, y, b.z + w));
    const n = new THREE.Vector3(x ? (s[0] === '+' ? 1 : -1) : 0, 0, x ? 0 : (s[0] === '+' ? 1 : -1));
    add(pt(p.door[0], H), pt(p.door[1], H + STAIR.door.h), n, roofTop(b));
  }
  return out;
}

/** Whether the eye is inside one of the buildings under its roof (the roof and 出屋面 count as outside: the whole campus is in view from there); `inset` shrinks (<0) or grows the footprint tested. */
export function eyeIndoors(list: InteriorMesh[], x: number, y: number, z: number, inset = 0): boolean {
  return list.some(it => Math.abs(x - it.b.x) < it.b.w / 2 + inset && Math.abs(z - it.b.z) < it.b.d / 2 + inset && y < buildingHeight(it.b) - 0.2);
}

const _frustum = new THREE.Frustum(), _m = new THREE.Matrix4(), _eye = new THREE.Vector3(), _d = new THREE.Vector3();
const _ray = new THREE.Ray(), _hit = new THREE.Vector3(), _pt = new THREE.Vector3();
/** Solid boxes of the buildings (footprint × height, shrunk a little so a grazing sight line is never cut). */
const occluders = (list: InteriorMesh[]) => list.map(it => ({ b: it.b, box: new THREE.Box3(
  new THREE.Vector3(it.b.x - it.b.w / 2 + 0.3, 0, it.b.z - it.b.d / 2 + 0.3), new THREE.Vector3(it.b.x + it.b.w / 2 - 0.3, buildingHeight(it.b) - 0.3, it.b.z + it.b.d / 2 - 0.3)) }));
let _occ: { list: InteriorMesh[]; boxes: ReturnType<typeof occluders> } | null = null;

/** Whether some other building's box stands between the eye and every corner (and the centre) of the portal. */
function hidden(p: Portal, own: BuildingDef, boxes: ReturnType<typeof occluders>): boolean {
  const { min, max } = p.box;
  const pts: [number, number, number][] = [[p.c.x, p.c.y, p.c.z]];
  for (const y of [min.y, max.y]) for (const k of [0, 1]) pts.push([k ? max.x : min.x, y, k ? max.z : min.z]);
  return pts.every(([x, y, z]) => {
    _pt.set(x, y, z);
    const len = _d.subVectors(_pt, _eye).length();
    _ray.set(_eye, _d.divideScalar(len));
    // (the building the eye is in does not count: from its 连廊门 the neighbour's is seen across the bridge)
    return boxes.some(o => o.b !== own && !o.box.containsPoint(_eye) && _ray.intersectBox(o.box, _hit) !== null && _hit.distanceTo(_eye) < len);
  });
}

/**
 * Interiors drawn only where they can be seen (+1 draw call and 1~5k triangles each): with the eye in the building,
 * or one of its portals in view, the eye on the outside of it (no peeking at a door from behind the building), and
 * not every sight line to it through another building. Run on the camera actually rendered (main.ts hooks it on
 * scene.onBeforeRender, so camera lag is included).
 */
export function showInteriors(list: InteriorMesh[], cam: THREE.Camera): void {
  _frustum.setFromProjectionMatrix(_m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
  cam.getWorldPosition(_eye);
  if (_occ?.list !== list) _occ = { list, boxes: occluders(list) };
  for (const it of list) {
    it.mesh.visible = it.box.containsPoint(_eye) || it.portals.some(p => _eye.y > p.minEye
      && _d.subVectors(_eye, p.c).dot(p.n) > 0 && _frustum.intersectsBox(p.box) && !hidden(p, it.b, _occ!.boxes));
  }
}

/** Campus built purely from data/campus/campus.json. */
// Frees the CPU-side vertex arrays once the GPU has them (a second page on a 3 GB box otherwise OOMs). Bounds are
// computed first so culling still works; dynamic-usage attributes (rewritten per frame) are left alone.
export function releaseCpuGeometry(root: THREE.Object3D): void {
  const seen = new Set<THREE.BufferGeometry>();
  root.traverse(o => {
    const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (!g || seen.has(g) || g.userData.keepCpu) return;
    seen.add(g);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    const attrs = [...Object.values(g.attributes), ...(g.index ? [g.index] : [])];
    for (const a of attrs) {
      if (!(a instanceof THREE.BufferAttribute) || a.usage !== THREE.StaticDrawUsage) continue;
      a.onUpload(function (this: THREE.BufferAttribute) { (this as { array: unknown }).array = null; });
    }
  });
}

export interface CampusWorld {
  buildings: BuildingDef[]; colliders: AABB[];
  ground: THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
  paving: { material: THREE.MeshLambertMaterial };
  facade: FacadeUniforms; interior: InteriorLightUniforms;
  interiors: InteriorMesh[]; furniture: FurnitureMesh[];
  boards: Blackboards; decals: Decals; flats: Flats; notices: Noticeboards;
  trees: AxisTrees; flag: Flag; gate: SlidingGate; outskirtsLit: { value: number };
}

/** Fixed, cheap-to-count milestones. Cell checkpoints report timing without pretending every cell costs the same. */
export const CAMPUS_BUILD_MILESTONES: readonly string[] = Object.freeze([
  'ground', 'blackboards', 'decals',
  ...campus.buildings.flatMap(b => [
    `${b.id}:facade`,
    ...(isHollow(b) ? [`${b.id}:interior`, ...floorStack(b).map(st => `${b.id}:${st.level}F:floor`)] : []),
  ]),
  'roof-drains', 'bridges', 'perimeter-gate', 'low-wall', 'outskirts', 'outskirts-wires', 'paving', 'noticeboards',
  ...campus.platforms.map(p => `platform:${p.id}`),
  'outdoor-props', 'sheds', 'trees', 'flag', 'geometry-bounds', 'colliders',
]);

/** The original synchronous API remains available to geometry tests and tooling. */
export function buildCampus(scene: THREE.Scene): CampusWorld {
  const stages = buildCampusStages(scene);
  let result = stages.next();
  while (!result.done) result = stages.next();
  return result.value;
}

/** Build on a staging scene; its owner handles disposal if construction is cancelled. */
export function buildCampusAsync(scene: THREE.Scene, options: BuildStageOptions = {}): Promise<CampusWorld> {
  return runBuildStages(buildCampusStages(scene), options);
}

/** Identical construction order and output to buildCampus, with checkpoints between independent pieces. */
export function* buildCampusStages(scene: THREE.Scene): Generator<string, CampusWorld, void> {
  const buildings = campus.buildings;
  // the ground, open over the stairwells down into a 地下室 (world/interior.ts groundHoles)
  const ground = new THREE.Mesh(
    groundPlane(GROUND.size, GROUND.center, 0, GROUND.holes),
    new THREE.MeshLambertMaterial({ color: campus.groundColor }),
  );
  ground.name = 'GROUND';
  scene.add(ground);
  yield 'ground';
  // one mesh per building (world/building.ts: walls with window reveals, courses, parapet, roof), one shared material
  // (brick courses, sky in the glass and lit windows at night come from the per-vertex `surf` tag, render/facade.ts)
  const buildingMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const facade = createFacadeUniforms();
  // (+ the 连廊吸顶灯 on the walls round each 连廊门, under its roof: render/facade.ts BRIDGE_LIGHT)
  const bridgeLit = bridgeLamps(campus);
  patchFacade(buildingMat, facade, bridgeLit);
  // interiors: lit through their own windows (render/interior_light.ts), never snowed on
  const interior = createInteriorLightUniforms();
  const furniture: FurnitureMesh[] = [], interiors: InteriorMesh[] = [];
  const boards = new Blackboards();
  yield 'blackboards';
  const decals = new Decals(buildings);
  yield 'decals';
  const flats = new Flats();
  for (const b of buildings) {
    const m = new THREE.Mesh(buildingGeometry(b), buildingMat);
    m.name = b.id;
    scene.add(m);
    // a 天台水箱间 (world/tankroom.ts): its own mesh under the building material (the building keeps its 5k budget;
    // +1 draw call, frustum-culled off screen)
    const tank = tankRoomGeometry(b);
    if (tank) { const t = new THREE.Mesh(tank, buildingMat); t.name = `${b.id}.tank`; scene.add(t); }
    yield `${b.id}:facade`;
    if (isHollow(b)) {
      // +1 draw call per enterable building; its own material (window mask + wall list), so no snow cover indoors
      const inner = new THREE.Mesh(interiorGeometry(b), interiorLightMaterial(b, interior));
      inner.name = `${b.id}.interior`;
      scene.add(inner);
      // drawn only from inside or through a doorway in view (showInteriors); the box reaches from a 地下室 up past a 出屋面
      const y0 = Math.min(0, floorStack(b)[0].y), y1 = roofTop(b) + STAIR.roofH;
      const portals = interiorPortals(b);
      interiors.push({ mesh: inner, b, box: new THREE.Box3(new THREE.Vector3(b.x - b.w / 2, y0, b.z - b.d / 2), new THREE.Vector3(b.x + b.w / 2, y1, b.z + b.d / 2)), portals });
      yield `${b.id}:interior`;
      // inside the 水箱间 (据点 #1): lining + 陈设 under the interior material, shown while the eye is on the roof
      const tr = tankRoomFurniture(b).render;
      if (tr.length) {
        const m = new THREE.Mesh(furnitureGeometry(b, tr), inner.material), y = buildingHeight(b);
        m.name = `${b.id}.tank.furniture`;
        furniture.push({ mesh: m, b, y0: y, y1: y + b.tankRoom!.h });
        scene.add(m);
        yield `${b.id}:tank-furniture`;
      }
      // 教室陈设 (world/classroom.ts): one mesh per storey under the same material, shown on the player's storey only
      for (const st of floorStack(b)) {
        const f = storeyFurniture(b, st.level).render;
        if (!f.length) { yield `${b.id}:${st.level}F:floor`; continue; }
        // the storey's mesh is an empty parent (shown/hidden as a whole); its boxes are split into 12 m cells of child
        // meshes so the frustum culls the classrooms behind the eye (a storey is ~22k triangles)
        const m = new THREE.Mesh(new THREE.BufferGeometry(), inner.material);
        m.name = `${b.id}.${st.level}F.furniture`;
        // Own partial cells immediately, so a cancelled staging scene can release them too.
        scene.add(m);
        const cells = new Map<string, typeof f>();
        for (const q of f) {
          const k = `${Math.floor((q.x0 + q.x1) / 24)},${Math.floor((q.z0 + q.z1) / 24)}`;
          (cells.get(k) ?? cells.set(k, []).get(k)!).push(q);
        }
        for (const [k, qs] of cells) {
          const c = new THREE.Mesh(furnitureGeometry(b, qs), inner.material);
          c.name = `${m.name}@${k}`; m.add(c);
          yield `${b.id}:${st.level}F:furniture@${k}`;
        }
        // the chalked faces of its 黑板 / 黑板报 (world/blackboard.ts): +1 draw call, shown and hidden with the furniture
        const bm = boards.storeyMesh(b, st.level, inner.material);
        if (bm) { bm.name = `${b.id}.${st.level}F.boards`; m.add(bm); }
        // 班牌 etc. (world/decals.ts, data/decals.json): +1 draw call, shown and hidden with the furniture
        const dm = decals.storeyMesh(b, st.level, inner.material);
        if (dm) { dm.name = `${b.id}.${st.level}F.decals`; m.add(dm); }
        // the 台仓's painted 布景 flats (world/flats.ts): +1 draw call
        const fm = flats.storeyMesh(b, st.level, inner.material);
        if (fm) { fm.name = `${b.id}.${st.level}F.flats`; m.add(fm); }
        // (the 上屋面 door, seen from the roof only, is inside the footprint anyway)
        const doors = portals.filter(p => p.minEye === -Infinity && p.box.min.y >= st.y - 0.05 && p.box.min.y < st.y + st.h - 0.05);
        furniture.push({ mesh: m, b, y0: st.y, y1: st.y + st.h, doors });
        yield `${b.id}:${st.level}F:floor`;
      }
    }
  }
  // 屋面排水 (world/roofdrain.ts): 过水孔, 雨水斗, 落水管 of every building, one mesh under the building material (+1 draw call)
  const drains = new THREE.Mesh(roofDrainGeometry(campus), buildingMat);
  drains.name = 'ROOF_DRAINS';
  scene.add(drains);
  yield 'roof-drains';
  // 连廊 (world/bridges.ts): one mesh for all of them under the building material (snow lies on the roofs), and one
  // for what is under their roofs, on a facade material that opts out of lying snow
  if (campus.bridges?.length) {
    const g = bridgeGeometry(campus);
    const m = new THREE.Mesh(g.open, buildingMat);
    m.name = 'BRIDGES';
    const dryMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    patchFacade(dryMat, facade, bridgeLit);
    dryMat.userData.noSnow = true;
    const dry = new THREE.Mesh(g.covered, dryMat);
    dry.name = 'BRIDGES.covered';
    scene.add(m, dry);
  }
  yield 'bridges';
  // 围墙 + 勒脚 + 墙垛 + 压顶, one vertex-coloured mesh (world/perimeter.ts)
  const wall = new THREE.Mesh(perimeterGeometry(perimeterParts(campus.wall, wallBoxes(campus.wall))),
    new THREE.MeshLambertMaterial({ vertexColors: true }));
  wall.name = 'WALL';
  // 电动伸缩门 + 门柱: one vertex-coloured mesh rewritten as it opens and shuts, its 显示屏 line one more (world/gate.ts)
  const gate = new SlidingGate(campus.wall, examCountdown);
  gate.mesh.name = 'GATE.door';
  scene.add(wall, gate.mesh);
  if (gate.led) scene.add(gate.led);
  yield 'perimeter-gate';
  // 西北矮墙: 压顶 + 碎玻璃 + 铁丝 + 墙垛, one vertex-coloured mesh
  const lowGeo = lowWallGeometry(campus.wall);
  if (lowGeo) {
    const lowMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    patchLowWall(lowMat);
    const low = new THREE.Mesh(lowGeo, lowMat);
    low.name = 'WALL.low';
    scene.add(low);
  }
  yield 'low-wall';
  // 墙外: 荒地, 土路 + 电线杆, 平房 / 自建房 / 居民楼, a 塔吊 (world/outskirts.ts), one vertex-coloured mesh; its windows
  // lit at night from `outskirtsLit` (main.ts syncFacade ← townLit)
  const outMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const { outskirtsLit } = patchOutskirts(outMat);
  addCells(scene, outskirtsGeometry(GROUND, !!campus.street), outMat, 'OUTSKIRTS');
  yield 'outskirts';
  // the 电线 again as 1 px lines down each box's axis: far off a 0.11 m wire is under a pixel and broke into dashes
  const wireGeo = new THREE.BufferGeometry();
  wireGeo.setAttribute('position', new THREE.BufferAttribute(outskirtsWires(GROUND, !!campus.street), 3));
  const wires = new THREE.LineSegments(wireGeo, new THREE.LineBasicMaterial({ color: OUT_COLOR.wire }));
  wires.name = 'OUTSKIRTS.wires';
  scene.add(wires);
  yield 'outskirts-wires';
  // 铺装 + 路缘石 + 树池 + 旗杆底座 (world/paving.ts): one vertex-coloured mesh, joints drawn in its shader; its colour
  // carries the ground's weather tint (main.ts → TimeOfDay `tinted`)
  const pavingMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  patchPaving(pavingMat);
  addCells(scene, pavingGeometry(campus, treePositions()), pavingMat, 'PAVING');
  yield 'paving';
  // 宣传栏 (world/noticeboard.ts, data/noticeboard.json): steel + paper, 2 draw calls
  const notices = new Noticeboards();
  scene.add(notices.group);
  yield 'noticeboards';
  for (const p of campus.platforms) {
    // the pole is drawn with its 底座 in the paving mesh
    const m = boxesMesh(platformBoxes(p, false), p.color);
    m.name = p.id;
    scene.add(m);
    yield `platform:${p.id}`;
  }
  // 垃圾桶 / 长椅 / 花坛 (world/props.ts) + the outdoor 监控 (world/safety.ts): one vertex-coloured mesh for the whole campus
  const propGeo = propGeometry(campus.props, [...outdoorCameraParts(campus), ...canYardParts(campus), ...hallFrontParts(campus), ...hallBackParts(campus), ...gymFrontParts(campus), ...gymSideParts(campus), ...gymWestParts(campus)]);
  if (propGeo) {
    addCells(scene, propGeo, new THREE.MeshLambertMaterial({ vertexColors: true }), 'PROPS');
  }
  yield 'outdoor-props';
  // 自行车棚 (world/shed.ts): the 彩钢瓦 sheet takes lying snow, nothing under it does
  const shed = shedGeometry(campus.props);
  if (shed) {
    const under = new THREE.MeshLambertMaterial({ vertexColors: true });
    under.userData.noSnow = true;
    const roof = new THREE.Mesh(shed.roof, new THREE.MeshLambertMaterial({ vertexColors: true })), rest = new THREE.Mesh(shed.under, under);
    roof.name = 'SHEDS.roof';
    rest.name = 'SHEDS';
    scene.add(roof, rest);
  }
  yield 'sheds';
  // 梧桐 along the central axis and the one by the 西北矮墙 (world/trees.ts, data/trees.json): wood + crowns + leaves,
  // the season by game day
  const trees = new AxisTrees(allTreePositions());
  scene.add(trees.group);
  yield 'trees';
  // 旗 on the 升旗台's pole (world/flag.ts): its own mesh, the wave in its vertex shader
  const flag = new Flag(campus.platforms);
  if (flag.mesh) scene.add(flag.mesh);
  yield 'flag';
  releaseCpuGeometry(scene);
  yield 'geometry-bounds';
  const colliders = campusColliders();
  yield 'colliders';
  return { buildings, colliders, ground, paving: { material: pavingMat }, facade, interior, interiors, furniture, boards, decals, flats, notices, trees, flag, gate, outskirtsLit };
}
