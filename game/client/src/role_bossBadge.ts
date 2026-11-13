import * as THREE from 'three';
import type { Warden } from './warden/model.ts';

/** A hand-drawn red duty sash, chalk name card and chalk stick belong only to the gym boss. */
export class BossBadge {
  private readonly parts: THREE.Mesh[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly texture: THREE.CanvasTexture;
  constructor(figure: Warden) {
    const canvas = document.createElement('canvas'); canvas.width = 192; canvas.height = 160;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#762d31'; ctx.fillRect(0, 0, 192, 160);
    ctx.strokeStyle = '#e8dec6'; ctx.lineWidth = 5; ctx.setLineDash([13, 5]); ctx.strokeRect(9, 9, 174, 142);
    ctx.fillStyle = '#eee5cf'; ctx.font = 'bold 56px serif'; ctx.textAlign = 'center'; ctx.fillText('值周代号025', 96, 83);
    ctx.font = '26px serif'; ctx.fillText('值周总管', 96, 128);
    this.texture = new THREE.CanvasTexture(canvas); this.texture.colorSpace = THREE.SRGBColorSpace;
    const ink = new THREE.MeshLambertMaterial({ color: 0x8f3237 }), paper = new THREE.MeshLambertMaterial({ map: this.texture, side: THREE.DoubleSide });
    const chalk = new THREE.MeshLambertMaterial({ color: 0xe9dfc6 }); this.materials.push(ink, paper, chalk);
    const sash = new THREE.Mesh(new THREE.BoxGeometry(.47, .09, .025), ink);
    sash.name = 'ROLE_BOSS_DUTY_SASH'; sash.position.set(0, .07, .14); sash.rotation.z = -.42;
    const card = new THREE.Mesh(new THREE.PlaneGeometry(.29, .24), paper);
    card.name = 'ROLE_BOSS_CHALK_BADGE'; card.position.set(-.015, -.04, .155);
    figure.bones.chest.add(sash, card);
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(.012, .014, .17, 6), chalk);
    stick.name = 'ROLE_BOSS_CHALK_STICK'; stick.position.set(0, -.065, .04); stick.rotation.z = .4;
    figure.bones.handR.add(stick); this.parts.push(sash, card, stick);
  }
  dispose() {
    for (const part of this.parts) { part.removeFromParent(); part.geometry.dispose(); }
    for (const material of this.materials) material.dispose();
    this.texture.dispose();
  }
}
