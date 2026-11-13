import * as THREE from 'three';
import { BALL_RADIUS, gymStandBoxes, type GymDef, type GymSnap } from '../../shared/gym.ts';

function drawLabel(canvas: HTMLCanvasElement, text: string) {
  const { width: w, height: h } = canvas;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#101b21'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#a8d4bc'; ctx.lineWidth = 8; ctx.strokeRect(5, 5, w - 10, h - 10);
  ctx.fillStyle = '#f5eee0'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const lines = text.split('\n'); ctx.font = `bold ${Math.floor(h * 0.64 / lines.length)}px sans-serif`;
  lines.forEach((s, i) => ctx.fillText(s, w / 2, h * (i + 0.5) / lines.length, w - 25));
}

function label(text: string, w = 512, h = 192) {
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  drawLabel(canvas, text);
  const t = new THREE.CanvasTexture(canvas); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Visuals only: switch lamps, scoreboard, bleachers and balls all follow server snapshots. */
export class GymView {
  readonly root = new THREE.Group();
  readonly switchMeshes: { id: number; object: THREE.Object3D }[] = [];
  state?: GymSnap;
  private lamps: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[] = [];
  private statuses: { sprite: THREE.Sprite; name: string; text: string }[] = [];
  private balls = new Map<number, THREE.Group>();
  private caption = document.createElement('div');
  private captionUntil = 0;
  private captionPriority = 0;
  private disposed = false;
  constructor(scene: THREE.Scene, def: GymDef) {
    def.switches.forEach((s, i) => {
      const group = new THREE.Group(); group.position.set(s.x, s.y, s.z); group.rotation.y = s.yaw;
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.85, 1, 0.18), new THREE.MeshLambertMaterial({ color: 0x34454e }));
      panel.position.y = 1.25;
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.82, 0.37), new THREE.MeshBasicMaterial({ map: label(`${i + 1} · ${s.label}`), side: THREE.DoubleSide }));
      plate.position.set(0, 1.48, 0.101);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff553d, fog: false }));
      lamp.position.set(0, 1.1, 0.14);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.8, 6), new THREE.MeshLambertMaterial({ color: 0x879096 })); pole.position.y = 0.4;
      group.add(panel, plate, lamp, pole); this.root.add(group); this.lamps.push(lamp);
      this.switchMeshes.push({ id: i, object: group });
      // Face the viewer: the physical panel is edge-on or mirrored from some approaches.
      // State text also makes the timer readable without relying on the tiny red/green lamp.
      const name = `${i + 1} · ${s.label}`, text = `${name}\n待按`;
      const status = new THREE.Sprite(new THREE.SpriteMaterial({ map: label(text), depthTest: true, fog: false }));
      status.position.set(s.x, s.y + 2.3, s.z); status.scale.set(1.4, 0.6, 1); this.root.add(status);
      this.statuses.push({ sprite: status, name, text });
    });
    const board = new THREE.Mesh(new THREE.PlaneGeometry(5.5, 1.7), new THREE.MeshBasicMaterial({ map: label('四灯门禁 · 体育馆东门\n多人 5秒内按齐 / 单人锁定 20秒\n篮球会绊倒 · 看着值日生', 512, 160), side: THREE.DoubleSide }));
    board.position.set(-100, 4, 72.8); board.rotation.y = Math.PI; this.root.add(board);
    for (const b of gymStandBoxes(def)) {
      const seat = new THREE.Mesh(new THREE.BoxGeometry(b.maxX - b.minX, b.maxY, b.maxZ - b.minZ), new THREE.MeshLambertMaterial({ color: 0x667d89 }));
      seat.position.set((b.minX + b.maxX) / 2, b.maxY / 2, (b.minZ + b.maxZ) / 2); this.root.add(seat);
      const trim = new THREE.Mesh(new THREE.BoxGeometry(b.maxX - b.minX, 0.025, 0.06), new THREE.MeshBasicMaterial({ color: 0xbdad73 }));
      trim.position.set(seat.position.x, b.maxY + 0.013, b.minZ + 0.03); this.root.add(trim);
    }
    this.caption.id = 'gym-caption'; this.caption.hidden = true;
    Object.assign(this.caption.style, { position: 'fixed', bottom: '25%', left: '50%', transform: 'translateX(-50%)', color: '#ffe4a5', background: '#101b21dd', padding: '8px 14px', border: '1px solid #d8a754', pointerEvents: 'none', zIndex: '8', textAlign: 'center', maxWidth: '70vw' });
    document.getElementById('hud')?.appendChild(this.caption);
    scene.add(this.root);
  }
  apply(s: GymSnap) {
    if (this.disposed) return;
    this.state = s;
    this.lamps.forEach((l, i) => l.material.color.set(s.complete || s.until[i] > s.now ? 0x4fff9a : 0xff553d));
    this.statuses.forEach((status, i) => {
      const remaining = s.until[i] - s.now;
      const text = `${status.name}\n${s.complete ? '常亮 · 已解锁' : remaining > 0 ? `亮 · ${Math.max(0.1, remaining).toFixed(1)}秒` : '待按'}`;
      if (text === status.text) return;
      status.text = text;
      const texture = status.sprite.material.map!;
      drawLabel(texture.image as HTMLCanvasElement, text); texture.needsUpdate = true;
    });
    const ids = new Set(s.balls.map((b) => b.id));
    for (const [id, g] of this.balls) if (!ids.has(id)) { this.root.remove(g); this.disposeObject(g); this.balls.delete(id); }
    for (const b of s.balls) {
      let group = this.balls.get(b.id);
      if (!group) {
        group = new THREE.Group();
        group.add(new THREE.Mesh(new THREE.SphereGeometry(BALL_RADIUS, 16, 12), new THREE.MeshLambertMaterial({ color: 0xe58b29, emissive: 0x2e1002 })));
        for (let k = 0; k < 3; k++) {
          const seam = new THREE.Mesh(new THREE.TorusGeometry(BALL_RADIUS + 0.001, 0.007, 4, 32), new THREE.MeshBasicMaterial({ color: 0x25170b }));
          if (k === 1) seam.rotation.x = Math.PI / 2;
          if (k === 2) seam.rotation.y = Math.PI / 2;
          group.add(seam);
        }
        group.position.set(b.p[0], b.p[1] + BALL_RADIUS, b.p[2]);
        this.balls.set(b.id, group); this.root.add(group);
      }
    }
  }
  tripped(id: number) { return !!this.state?.trips.some((p) => p.id === id && p.until > this.state!.now); }
  say(text: string, seconds = 1.2, priority = 0) {
    if (this.disposed) return;
    if (priority < this.captionPriority && performance.now() < this.captionUntil) return;
    this.captionPriority = priority;
    this.caption.textContent = text; this.caption.hidden = false; this.captionUntil = performance.now() + seconds * 1000;
  }
  tick(dt: number, now: number) {
    if (this.disposed) return;
    if (now >= this.captionUntil) this.caption.hidden = true;
    for (const b of this.state?.balls ?? []) {
      const g = this.balls.get(b.id)!;
      const target = new THREE.Vector3(b.p[0], b.p[1] + BALL_RADIUS, b.p[2]);
      g.position.lerp(target, 1 - Math.exp(-22 * dt));
      g.rotation.x += b.v[1] * dt / BALL_RADIUS; g.rotation.z -= b.v[0] * dt / BALL_RADIUS;
    }
  }
  private disposeObject(root: THREE.Object3D) {
    root.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) { if ('map' in m) (m.map as THREE.Texture | null)?.dispose(); m.dispose(); }
      }
    });
  }
  dispose(scene: THREE.Scene) {
    if (this.disposed) return;
    this.disposed = true;
    scene.remove(this.root); this.disposeObject(this.root); this.root.clear();
    this.lamps.length = 0; this.statuses.length = 0; this.balls.clear(); this.state = undefined;
    this.switchMeshes.length = 0;
    this.caption.remove();
  }
}
