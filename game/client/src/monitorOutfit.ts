import * as THREE from 'three';
import type { Warden } from './warden/model.ts';

/** Per-instance clothes and head-bone accessories. Shared figure geometry and materials are never edited. */
export class MonitorOutfit {
  readonly hood: THREE.Mesh;
  readonly mask: THREE.Mesh;
  private readonly figure: Warden;
  private readonly owned: THREE.Material[] = [];
  private readonly previous = new Map<number, THREE.Material>();
  private readonly parts: THREE.Object3D[] = [];
  private disposed = false;

  constructor(figure: Warden) {
    this.figure = figure;
    const materials = [...figure.mesh.material as THREE.Material[]]; figure.mesh.material = materials;
    for (const index of [2, 3, 4, 9]) {
      const original = materials[index] as THREE.MeshStandardMaterial, material = original.clone();
      this.previous.set(index, original); material.color.setHex(index === 4 ? 0x15171a : 0x0e1013);
      material.roughness = .92; materials[index] = material; this.owned.push(material);
    }
    const cloth = new THREE.MeshStandardMaterial({ color: 0x0c0e11, roughness: .95, side: THREE.DoubleSide });
    this.owned.push(cloth);
    this.hood = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14, Math.PI / 2 + .95, Math.PI * 2 - 1.9, 0, Math.PI * .86), cloth);
    this.hood.name = 'MONITOR_BLACK_HOOD'; this.hood.scale.set(.157, .185, .172); this.hood.position.set(0, .085, -.025);
    const geometry = new THREE.PlaneGeometry(.215, .085, 12, 3), pos = geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) pos.setZ(i, .13 - .025 * (Math.abs(pos.getX(i)) / .108) ** 2);
    geometry.computeVertexNormals();
    this.mask = new THREE.Mesh(geometry, cloth); this.mask.name = 'MONITOR_BLACK_MASK'; this.mask.position.y = .01;
    this.parts.push(this.hood, this.mask);
    for (const side of [-1, 1]) {
      const path = new THREE.CatmullRomCurve3([new THREE.Vector3(side * .1, .03, .109), new THREE.Vector3(side * .137, .04, .02), new THREE.Vector3(side * .12, .02, -.03)]);
      this.parts.push(new THREE.Mesh(new THREE.TubeGeometry(path, 8, .0025, 4, false), cloth));
    }
    figure.bones.head.add(...this.parts);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const materials = this.figure.mesh.material as THREE.Material[];
    for (const [index, original] of this.previous) { const material = materials[index]; if (this.owned.includes(material)) materials[index] = original; }
    for (const part of this.parts) { part.removeFromParent(); (part as THREE.Mesh).geometry.dispose(); }
    for (const material of this.owned) material.dispose();
  }
}
