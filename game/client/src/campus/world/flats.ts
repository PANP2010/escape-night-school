import * as THREE from 'three';
import { floorStack, type BuildingDef } from '../../../../shared/campus/campus_schema.ts';
import { storeyRooms } from './rooms.ts';
import { QuadBuf } from './decals.ts';
import { underFlats } from './hall.ts';

/**
 * 台仓 布景 flats' painted faces (world/hall.ts underFlats): public/art/flats.jpg, three faded scenes the art teacher
 * painted (genimg, #161), stacked 512 × 340 px rows down a 512 × 1024 atlas — 0 sky and hills, 1 a whitewashed
 * courtyard wall with a red lattice window, 2 poplars and bushes.
 */
export const FLAT_ATLAS = { url: 'art/flats.jpg', w: 512, h: 1024, row: 341, tile: 340 };
/** Atlas uv rect of row `k`: corners bottom-left, bottom-right, top-right, top-left (flipY: v up). */
export function flatUV(k: number): [number, number][] {
  const v1 = 1 - (k * FLAT_ATLAS.row) / FLAT_ATLAS.h, v0 = v1 - FLAT_ATLAS.tile / FLAT_ATLAS.h;
  return [[0, v0], [1, v0], [1, v1], [0, v1]];
}

/** The flats mesh per storey (+1 draw call where there is a 台仓), on a copy of the interior material with the atlas. */
export class Flats {
  readonly texture: THREE.Texture | null = null;
  /** the atlas image is in (e2e waits on it) */
  loaded = false;
  constructor() {
    if (typeof document === 'undefined') return;
    const tex = new THREE.TextureLoader().load(import.meta.env.BASE_URL + FLAT_ATLAS.url, () => { this.loaded = true; });
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    this.texture = tex;
  }
  storeyMesh(b: BuildingDef, level: number, interior: THREE.MeshLambertMaterial): THREE.Mesh | null {
    const st = floorStack(b).find(s => s.level === level);
    if (!st) return null;
    const faces = storeyRooms(b, level).filter(r => r.kind === 'understage').flatMap(r => underFlats(r, st.y));
    if (!faces.length) return null;
    const buf = new QuadBuf(b);
    for (const f of faces) buf.quad(f.q, f.n, flatUV(f.tile));
    return new THREE.Mesh(buf.geometry(), this.material(interior));
  }
  private mats = new Map<THREE.Material, THREE.MeshLambertMaterial>();
  private material(interior: THREE.MeshLambertMaterial): THREE.MeshLambertMaterial {
    let m = this.mats.get(interior);
    if (!m) {
      // without the image (tests, no DOM) a faded sky-blue board
      m = new THREE.MeshLambertMaterial({ vertexColors: true, map: this.texture, color: this.texture ? 0xffffff : 0xa3b6bc });
      m.onBeforeCompile = interior.onBeforeCompile;
      m.customProgramCacheKey = interior.customProgramCacheKey;
      m.userData.noSnow = true;
      this.mats.set(interior, m);
    }
    return m;
  }
}
