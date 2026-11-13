import * as THREE from 'three';
import { ACT_REACH } from '../../shared/interact.ts';
import { canReadStory, StoryState, type StoryNoteSite } from '../../shared/story.ts';
import { storySites, type StoryEnvironment } from '../../shared/storySite.ts';
import { StoryView, type StoryReadTarget } from './storyView.ts';
export { storySite, storySites, type StoryEnvironment } from '../../shared/storySite.ts';

const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
interface OwnPose { p: [number, number, number]; yaw: number }
type FragmentMesh = THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

/** Environmental writing and a personal notebook. It has no network writer or puzzle authority. */
export class StoryJournal {
  readonly state = new StoryState();
  onRead?: () => void;
  /** A successful physical read, after authority pose, facing and current LOS checks. */
  onDiscovered?: (entryId: string) => void;
  onOpenChange?: (open: boolean) => void;
  private readonly view: StoryView;
  private readonly scene: THREE.Scene;
  private readonly myId: number;
  private readonly visible: (from: THREE.Vector3, to: THREE.Vector3) => boolean;
  private readonly camera?: THREE.Camera;
  private sites: StoryNoteSite[] = [];
  private environment?: StoryEnvironment;
  private meshes: FragmentMesh[] = [];
  private own?: OwnPose;
  private candidate?: StoryNoteSite;
  private revision = -1;
  private ready = false;
  private available = true;
  private shown = false;
  private destroyed = false;
  private displayedTarget = '';
  private readonly projected = new THREE.Vector3();

  constructor(scene: THREE.Scene, myId: number, visible: (from: THREE.Vector3, to: THREE.Vector3) => boolean, camera?: THREE.Camera) {
    this.scene = scene; this.myId = myId; this.visible = visible; this.camera = camera;
    this.view = new StoryView(document.body);
    this.view.setVisible(false);
    this.view.onOpenChange = (open) => this.onOpenChange?.(open);
    this.view.onRead = () => { if (this.onRead) this.onRead(); else this.readCandidate(); };
  }

  enter(level: number, seed: number, def: StoryEnvironment): void {
    if (this.destroyed || !this.state.enter(level, def.name, seed)) return;
    this.environment = def;
    this.clearMeshes(); this.own = undefined; this.clearCandidate();
    this.sites = storySites(level, def, this.state.namedMonitorsEnabled);
    this.ready = !!this.state.chapter && this.sites.length > 0;
    for (const site of this.sites) this.buildFragment(site);
    this.view.toggle(false);
    this.setVisible(this.ready);
    this.refresh();
  }

  toggle(force?: boolean): void { if (this.ready && this.shown) this.view.toggle(force); }
  get isOpen(): boolean { return this.view.isOpen; }
  get candidateId(): string | undefined { return this.candidate?.id; }
  get candidateTitle(): string | undefined { return this.candidate?.title; }

  /** Call after each inbound message's collision updates, including room / fade / complete. */
  receive(message: unknown): void {
    if (this.destroyed) return;
    const namedMonitors = this.state.namedMonitorsEnabled;
    this.state.receive(message, this.myId);
    if (namedMonitors !== this.state.namedMonitorsEnabled && this.state.chapter && this.environment) {
      this.clearMeshes(); this.clearCandidate();
      this.sites = storySites(this.state.chapter.level, this.environment, this.state.namedMonitorsEnabled);
      for (const site of this.sites) this.buildFragment(site);
    }
    if (!this.state.chapter) {
      this.ready = false; this.own = undefined; this.clearMeshes(); this.sites = [];
      this.setVisible(false);
    }
    if (obj(message) && (message.t === 'fade' || message.t === 'complete' || message.t === 'completed' || message.t === 'correct'
      || message.t === 'caught' || (message.t === 'warp' && message.id === this.myId))) {
      // A snap from before a handoff or authority move must never grant a read at the old location.
      this.own = undefined;
      if (message.t === 'fade' || message.t === 'complete' || message.t === 'completed') this.setVisible(false);
    }
    if (obj(message) && message.t === 'snap') {
      this.own = undefined;
      if (Array.isArray(message.players)) {
        const player = message.players.find((p) => obj(p) && p.id === this.myId);
        if (obj(player) && (player.st === undefined || player.st === 0) && Array.isArray(player.p) && player.p.length === 3
          && player.p.every((v) => typeof v === 'number' && Number.isFinite(v))
          && typeof player.yaw === 'number' && Number.isFinite(player.yaw)) {
          this.own = { p: [...player.p] as OwnPose['p'], yaw: player.yaw };
        }
      }
    }
    this.chooseCandidate();
    this.refresh(); this.update();
  }

  /** Explicit local reading: the latest server pose and current LOS are checked again on activation. */
  readCandidate(): boolean {
    if (this.destroyed) return false;
    this.chooseCandidate();
    const site = this.candidate;
    if (!site) return false;
    if (this.state.readNote(site.id)) this.onDiscovered?.(`${this.state.chapter!.level}:note:${site.id}`);
    this.refresh();
    this.view.showEntry(`${this.state.chapter!.level}:note:${site.id}`);
    return true;
  }

  setAvailable(available: boolean): void {
    if (this.destroyed || this.available === available) return;
    this.available = available;
    this.chooseCandidate(); this.update();
  }

  /** Overlay visibility is owned by the game (map, handoff, result and disconnection). */
  setVisible(visible: boolean): void {
    if (this.destroyed) return;
    const shown = visible && this.ready;
    if (shown === this.shown) return;
    this.shown = shown;
    this.view.setVisible(this.shown);
    this.chooseCandidate(); this.update();
  }

  /** Called after the real camera matrix update. Projection positions the tap target, never grants reading. */
  update(): void {
    if (this.destroyed) return;
    const site = this.candidate;
    let target: StoryReadTarget | undefined;
    if (site && this.shown && this.available && !this.view.isOpen) {
      if (this.camera) {
        this.projected.set(...site.p).project(this.camera);
        if (this.projected.z > -1 && this.projected.z < 1 && Math.abs(this.projected.x) < 0.9 && Math.abs(this.projected.y) < 0.86) {
          target = { id: site.id, title: site.title, x: (this.projected.x + 1) * 50, y: (1 - this.projected.y) * 50 };
        }
      } else target = { id: site.id, title: site.title };
    }
    const key = target ? `${target.id}:${target.x?.toFixed(1)}:${target.y?.toFixed(1)}` : '';
    if (key === this.displayedTarget) return;
    this.displayedTarget = key;
    this.view.setCandidate(target);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.clearMeshes(); this.view.destroy();
    this.sites = []; this.candidate = undefined; this.own = undefined;
  }

  private chooseCandidate(): void {
    this.candidate = undefined;
    if (!this.ready || !this.shown || !this.available || !this.own) { this.clearCandidate(); return; }
    const { p, yaw } = this.own;
    const eye = new THREE.Vector3(p[0], p[1] + 1.5, p[2]);
    let nearest = Infinity;
    for (const site of this.sites) {
      const distance = Math.hypot(site.p[0] - p[0], site.p[2] - p[2]);
      if (distance > ACT_REACH || distance >= nearest) continue;
      const target = new THREE.Vector3(...site.p);
      if (site.surface === 'desk') target.y += 0.025;
      else target.addScaledVector(new THREE.Vector3(...site.normal), 0.04);
      if (canReadStory(site, p, yaw, this.visible(eye, target))) { this.candidate = site; nearest = distance; }
    }
    if (!this.candidate) this.clearCandidate();
  }

  private clearCandidate(): void { this.candidate = undefined; this.displayedTarget = ''; this.view.setCandidate(); }

  private refresh(): void {
    if (this.revision === this.state.revision) return;
    this.revision = this.state.revision;
    this.view.update(this.state.model());
  }

  private buildFragment(site: StoryNoteSite): void {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
    const context = canvas.getContext('2d');
    if (!context) return;
    paintFragment(context, site);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    // Match the native chalk/sign labels; the campus night palette does not light standard materials.
    const material = new THREE.MeshBasicMaterial({ map: texture, color: 0xc7c8b5 });
    const width = site.tone === 'workbook' ? 0.4 : site.tone === 'chalk' ? 0.66 : 0.58;
    const height = site.tone === 'workbook' ? 0.38 : site.tone === 'sticker' ? 0.48 : 0.66;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
    mesh.position.set(...site.p);
    mesh.rotation.y = Math.atan2(site.normal[0], site.normal[2]);
    if (site.surface === 'desk') { mesh.rotation.x = -Math.PI / 2; mesh.rotation.z = -0.08; }
    mesh.name = `story-fragment:${site.id}`;
    this.meshes.push(mesh); this.scene.add(mesh);
  }

  private clearMeshes(): void {
    for (const mesh of this.meshes) {
      this.scene.remove(mesh); mesh.geometry.dispose(); mesh.material.map?.dispose(); mesh.material.dispose();
    }
    this.meshes = [];
  }
}

/** All source text is authored local material; no remote assets or extra dialogue are generated. */
function paintFragment(context: CanvasRenderingContext2D, site: StoryNoteSite): void {
  const chalk = site.tone === 'chalk', workbook = site.tone === 'workbook', sticker = site.tone === 'sticker';
  context.fillStyle = chalk ? '#243d36' : workbook ? '#d9d3b7' : sticker ? '#c8c89d' : '#dfd2af';
  context.fillRect(0, 0, 512, 512);
  if (chalk) {
    context.strokeStyle = '#647169'; context.lineWidth = 10; context.strokeRect(6, 6, 500, 500);
    context.fillStyle = '#bcc7b0';
    for (let i = 0; i < 70; i++) context.fillRect((i * 113) % 490 + 10, (i * 71) % 490 + 10, 2, 1);
  } else if (workbook) {
    context.fillStyle = '#817f6b'; context.fillRect(0, 0, 23, 512);
    context.strokeStyle = '#929f9c66'; context.lineWidth = 1;
    for (let y = 142; y < 500; y += 43) { context.beginPath(); context.moveTo(40, y); context.lineTo(493, y); context.stroke(); }
    context.strokeStyle = '#a0736877'; context.beginPath(); context.moveTo(73, 0); context.lineTo(73, 512); context.stroke();
  } else if (sticker) {
    context.fillStyle = '#45564b'; context.fillRect(0, 0, 512, 22); context.fillRect(0, 490, 512, 22);
    context.strokeStyle = '#53604d'; context.lineWidth = 3; context.strokeRect(18, 36, 476, 438);
  } else {
    context.fillStyle = '#c4b998'; context.fillRect(35, 13, 103, 24); context.fillRect(375, 13, 103, 24);
    context.strokeStyle = '#a69b7e'; context.lineWidth = 2; context.strokeRect(12, 12, 488, 488);
  }
  const x = workbook ? 84 : 38, width = workbook ? 397 : 436;
  context.textAlign = 'left'; context.fillStyle = chalk ? '#e2e4d3' : '#29392f';
  context.font = `600 ${workbook ? 29 : 31}px ${chalk ? 'cursive' : 'sans-serif'}`;
  context.fillText(site.title, x, 91, width);
  context.font = `${workbook ? 29 : 28}px ${chalk || workbook ? 'cursive' : 'sans-serif'}`;
  let y = 160;
  for (const paragraph of site.text.split('\n')) {
    let line = '';
    for (const character of paragraph) {
      if (context.measureText(line + character).width > width && line) { context.fillText(line, x, y); y += 43; line = ''; }
      line += character;
    }
    if (line) context.fillText(line, x, y);
    y += 43;
  }
  context.font = '21px sans-serif'; context.fillStyle = chalk ? '#b5c2b1' : '#566151';
  context.fillText('靠近查看 · 留下记录', x, 469, width);
}
