import * as THREE from 'three';
import type { LevelDef } from '../../shared/levels/def.ts';

/** Readable chalk clues and numbered real doorways; no additional collision or imaginary doors. */
export function buildLoopView(def: LevelDef) {
  const root = new THREE.Group(), loop = def.loop;
  const resources: { dispose(): void }[] = [];
  const plate = (lines: string[], w: number, h: number, color: string, bg: string) => {
    const c = document.createElement('canvas'); c.width = 512; c.height = 256;
    const g = c.getContext('2d')!;
    g.fillStyle = bg; g.fillRect(0, 0, 512, 256);
    g.strokeStyle = color; g.lineWidth = 3; g.strokeRect(9, 9, 494, 238);
    g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
    lines.forEach((s, i) => {
      g.font = `bold ${i === 1 ? 34 : 25}px sans-serif`;
      g.fillText(s, 256, (i + 0.5) * 230 / lines.length + 13, 476);
    });
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({ map: tex });
    const geometry = new THREE.PlaneGeometry(w, h), mesh = new THREE.Mesh(geometry, mat);
    resources.push(tex, mat, geometry); root.add(mesh);
    return mesh;
  };
  let exit: THREE.Mesh | undefined;
  if (loop) {
    // The nearest spawn is only 1.5 m from this wall: keep the whole clue inside its opening view.
    const board = plate(['不要相信走廊的长度', loop.sequence.join(' → '), '每人依次开门，走进教室，再回走廊', '越过尽头粉笔线会回环，门序进度保留'], 2.4, 1.1, '#e5e8d5', '#18332e');
    board.position.set(loop.clue.x, loop.clue.y + 1.6, loop.clue.z);
    board.rotation.y = Math.PI;
    // An actual chalk threshold makes the intentional warp readable; it has no collider or input gate.
    const seam = new THREE.Mesh(new THREE.PlaneGeometry(.07, 2.4), new THREE.MeshBasicMaterial({ color: '#e5e8d5', transparent: true, opacity: .65, side: THREE.DoubleSide }));
    resources.push(seam.geometry, seam.material); root.add(seam);
    seam.name = 'loop-seam'; seam.rotation.x = -Math.PI / 2;
    seam.position.set(loop.endX, def.exit.y + .025, loop.corridorZ + 1.2);
    for (const d of loop.doors) {
      const sign = plate(['三楼教室', d.label, '跨过门槛才算数'], 0.9, 0.45, '#f2e6bb', '#173c45');
      sign.position.set(d.x, d.y + 2.5, d.z + 0.13);
    }
    exit = plate(['西端出口', '解开门序后在此集合', '未解开者仍会回环'], 2.6, 1.15, '#c5ffdc', '#164d32');
    exit.position.set(def.exit.x, def.exit.y + 1.8, 85.66); exit.rotation.y = Math.PI;
    const ring = new THREE.Mesh(new THREE.RingGeometry(def.exit.r - 0.08, def.exit.r, 48), new THREE.MeshBasicMaterial({ color: 0x73e8aa, transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
    resources.push(ring.geometry, ring.material); root.add(ring);
    ring.rotation.x = -Math.PI / 2; ring.position.set(def.exit.x, def.exit.y + 0.02, def.exit.z);
  }
  return { root, dispose: () => resources.forEach((r) => r.dispose()) };
}
