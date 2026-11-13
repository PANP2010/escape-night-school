import * as THREE from 'three';
import type { BossSnap } from '../../shared/protocol.ts';
import './bossView.css';

/** Code-drawn chalk warnings, shared by desktop and touch screens. */
export class BossView {
  private readonly root = new THREE.Group();
  private readonly circleMat = new THREE.MeshBasicMaterial({ color: 0xffd6a0, transparent: true, opacity: .9, depthWrite: false, side: THREE.DoubleSide });
  private readonly fillMat = new THREE.MeshBasicMaterial({ color: 0xd96363, transparent: true, opacity: .2, depthWrite: false, side: THREE.DoubleSide });
  private readonly circle = new THREE.Mesh(new THREE.RingGeometry(.93, 1, 48), this.circleMat);
  private readonly fill = new THREE.Mesh(new THREE.CircleGeometry(1, 48), this.fillMat);
  private readonly sweep = new THREE.Mesh(new THREE.BoxGeometry(1, .025, 1), this.fillMat);
  private readonly edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, .025, 1)), new THREE.LineBasicMaterial({ color: 0xffd6a0 }));
  private readonly label = document.createElement('div');

  constructor(scene: THREE.Scene) {
    this.circle.rotation.x = this.fill.rotation.x = -Math.PI / 2;
    this.root.add(this.circle, this.fill, this.sweep, this.edges);
    this.root.visible = false; scene.add(this.root);
    this.label.setAttribute('role', 'status');
    this.label.id = 'role_boss-warning'; this.label.setAttribute('aria-live', 'polite'); this.label.setAttribute('aria-atomic', 'true');
    this.label.hidden = true; document.body.append(this.label);
  }

  receive(state?: BossSnap) {
    const show = !!state && (state.phase === 'windup' || state.phase === 'active');
    this.root.visible = show; this.label.hidden = !show;
    if (!state || !show) return;
    const circle = state.skill === 'chalk-circle';
    this.circle.visible = this.fill.visible = circle;
    this.sweep.visible = this.edges.visible = !circle;
    const y = state.target[1] + .055;
    this.circle.position.set(state.target[0], y + .006, state.target[2]);
    this.fill.position.set(state.target[0], y, state.target[2]);
    this.circle.scale.setScalar(state.radius); this.fill.scale.setScalar(state.radius);
    const dx = state.target[0] - state.origin[0], dz = state.target[2] - state.origin[2], d = Math.hypot(dx, dz) || 1;
    for (const mesh of [this.sweep, this.edges]) {
      mesh.position.set(state.origin[0] + dx / d * state.length / 2, y, state.origin[2] + dz / d * state.length / 2);
      mesh.scale.set(state.width, 1, state.length); mesh.rotation.y = Math.atan2(dx, dz);
    }
    this.fillMat.opacity = state.phase === 'active' ? .55 : .2;
    this.label.textContent = state.phase === 'active' ? '值周代号025 · 点名生效！' : `值周代号025 · ${circle ? '粉笔圈' : '点名扫线'} ${state.remaining.toFixed(1)}秒\n${circle ? '离开地上的粉笔圈' : '向侧面躲开粉笔线'}！`;
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.root); this.label.remove();
    for (const mesh of [this.circle, this.fill, this.sweep, this.edges]) mesh.geometry.dispose();
    this.circleMat.dispose(); this.fillMat.dispose(); this.edges.material.dispose();
  }
}
