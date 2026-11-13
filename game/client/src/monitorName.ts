import * as THREE from 'three';

export const MONITOR_NAME_DISTANCE = 9;
const position = new THREE.Vector3(), direction = new THREE.Vector3(), toward = new THREE.Vector3();

/** A nearby, visible student's name. Depth testing and an authoritative-world sight check prevent wall labels. */
export class MonitorName {
  readonly sprite: THREE.Sprite;
  private readonly texture: THREE.CanvasTexture;
  readonly text: string;

  constructor(text: string) {
    this.text = text;
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 80;
    const g = canvas.getContext('2d')!;
    g.fillStyle = 'rgba(15,18,19,0.82)'; g.fillRect(8, 8, 240, 64);
    g.fillStyle = '#b6493b'; g.fillRect(8, 8, 4, 64);
    g.font = '500 38px "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#eee8d7';
    g.fillText(text, 132, 42);
    this.texture = new THREE.CanvasTexture(canvas); this.texture.colorSpace = THREE.SRGBColorSpace;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.texture, transparent: true, depthTest: true, depthWrite: false, fog: true }));
    this.sprite.name = 'MONITOR_NAME'; this.sprite.userData.displayName = text;
    this.sprite.position.y = 2.18; this.sprite.scale.set(1.12, .35, 1); this.sprite.visible = false;
  }

  update(camera?: THREE.Camera, visible?: (from: THREE.Vector3, to: THREE.Vector3) => boolean): void {
    this.sprite.visible = false;
    if (!camera || !visible) return;
    this.sprite.getWorldPosition(position);
    const distance = camera.position.distanceTo(position);
    if (distance > MONITOR_NAME_DISTANCE) return;
    camera.getWorldDirection(direction); toward.copy(position).sub(camera.position).normalize();
    if (direction.dot(toward) < .5 || !visible(camera.position, position)) return;
    this.sprite.visible = true;
    (this.sprite.material as THREE.SpriteMaterial).opacity = Math.min(1, (MONITOR_NAME_DISTANCE - distance) / 2);
  }

  dispose(): void {
    this.sprite.removeFromParent(); this.sprite.material.dispose(); this.texture.dispose();
  }
}
