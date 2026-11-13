import * as THREE from 'three';
import type { Warden } from './warden/model.ts';

/** A monitor owns only its inked face; the paper skin, clothing and rig remain shared. */
export class MonitorFace {
  readonly texture: THREE.CanvasTexture;
  readonly material: THREE.MeshStandardMaterial;
  readonly name: string;
  private readonly original: THREE.Material;
  private readonly figure: Warden;
  private readonly originalScale: THREE.Vector3;
  private readonly originalHeadScale: THREE.Vector3;
  private disposed = false;

  constructor(figure: Warden, name: string) {
    this.figure = figure;
    this.originalScale = figure.mesh.scale.clone();
    this.originalHeadScale = figure.bones.head.scale.clone();
    // Only the visible instance changes: the authoritative root, movement and capsule stay intact.
    if (name === '角色020') {
      figure.mesh.scale.multiply(new THREE.Vector3(1.32, .74, 1.28));
      // Retain a rounded head instead of flattening its face with the shorter torso and legs.
      figure.bones.head.scale.multiply(new THREE.Vector3(.9, 1 / .74, .92));
    }
    this.name = name;
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 256;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#e4e0d2'; g.fillRect(0, 0, 512, 256);
    g.strokeStyle = 'rgba(120,110,95,0.18)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(60, 120); g.quadraticCurveTo(128, 132, 196, 118); g.stroke();
    g.beginPath(); g.moveTo(128, 70); g.lineTo(126, 190); g.stroke();
    // Same equirectangular UV as the real head: u=.25 is its face, not the back of the sphere.
    if (name === '角色094') {
      g.strokeStyle = '#39332e'; g.lineWidth = 2.7; g.lineCap = 'round';
      for (const x of [104, 152]) {
        g.beginPath(); g.moveTo(x - 11, 120); g.quadraticCurveTo(x, 115, x + 11, 120); g.stroke();
        g.lineWidth = 1.2; g.beginPath(); g.moveTo(x - 9, 122); g.quadraticCurveTo(x, 124, x + 9, 122); g.stroke(); g.lineWidth = 2.7;
      }
    } else {
      g.save(); g.translate(128, 130); g.rotate(-0.055);
      g.font = '600 32px "Songti SC", "Noto Serif CJK SC", "SimSun", serif';
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#39332e';
      g.fillText(name, 0, 0, 108); g.restore();
    }
    this.texture = new THREE.CanvasTexture(canvas); this.texture.colorSpace = THREE.SRGBColorSpace;
    const materials = [...figure.mesh.material as THREE.Material[]];
    this.original = materials[0];
    this.material = (this.original as THREE.MeshStandardMaterial).clone();
    this.material.name = 'MONITOR_NAMED_FACE'; this.material.map = this.texture;
    this.material.userData.displayName = name;
    materials[0] = this.material; figure.mesh.material = materials;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const materials = this.figure.mesh.material as THREE.Material[];
    if (materials[0] === this.material) materials[0] = this.original;
    this.figure.mesh.scale.copy(this.originalScale);
    this.figure.bones.head.scale.copy(this.originalHeadScale);
    this.material.dispose(); this.texture.dispose();
  }
}
