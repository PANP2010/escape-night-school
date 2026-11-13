import * as THREE from 'three';
import { Student } from './warden/student.ts';
import { Warden } from './warden/model.ts';
import { MonitorAnimator } from './warden/monitorAnim.ts';
import { makeMonitorMaterials } from './warden/textures.ts';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { l7Colliders, MIRRORS, MIRROR_DOORS, L7_EXIT } from '../../shared/levels/l7.ts';
import type { AABB } from '../../shared/campus/collision.ts';
import type { Vec3 } from '../../shared/protocol.ts';
import type { MirrorActorSnap } from '../../shared/l7-campaign.ts';
export interface L7PlayerPose { id: number; p: Vec3; yaw: number; pitch: number; st: number }
import { mirrorKeyPoint, type MirrorKeySnap } from '../../shared/l7-key.ts';

export interface L7Pose { p: Vec3; yaw: number; pitch: number; st?: number }
interface Figure { id: number; p: Vec3; yaw: number; pitch?: number; st: number; ghost?: boolean; phase?: string }
const PLANE_NORMAL = new THREE.Vector3(0, 0, 1);
// Match the ordinary campaign teammates, including the local player's delayed reflection.
const CLOTHES = [0xb04a3a, 0x3a6ab0, 0xb09a3a, 0x5aa05a];

function coloredBox(b: AABB, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ).toNonIndexed();
  g.translate((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
  const c = new THREE.Color(color), a = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < a.length; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

/** The exact server solids feed the visible walls, furniture, slabs and stair treads. */
function worldGeometry(open: number[]): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const b of l7Colliders(open)) {
    const w = b.maxX - b.minX, d = b.maxZ - b.minZ, h = b.maxY - b.minY;
    if (w <= 0 || d <= 0 || h <= 0) continue;
    const slab = h < .33 && (w > 1.2 || d > 1.2), wall = h > 2.1 && (w < .35 || d < .35);
    const stair = h > .12 && h < 3.7 && Math.min(w, d) < .45 && Math.max(w, d) > 1.0;
    if (wall) {
      const band = Math.floor((b.minY + .05) / 3.6) * 3.6 + 1.1;
      if (band > b.minY && band < b.maxY) {
        parts.push(coloredBox({ ...b, maxY: band }, '#4d6964'), coloredBox({ ...b, minY: band }, '#a9b1a0'));
      } else parts.push(coloredBox(b, '#a9b1a0'));
    } else parts.push(coloredBox(b, slab ? '#63706a' : stair ? '#87958c' : h > 1.4 ? '#536458' : '#657264'));
  }
  // Campus has an implicit y=0 ground plane. Draw that same surface inside LAB.
  parts.push(coloredBox({ minX: -93, maxX: -67, minY: -.09, maxY: -.005, minZ: 133, maxZ: 147 }, '#5b6862'));
  const merged = mergeGeometries(parts, false)!;
  for (const g of parts) g.dispose();
  return merged;
}

function textTexture(text: string, fg = '#d7e3c2', bg = '#243c34'): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const g = c.getContext('2d')!; g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = '#a1b395'; g.lineWidth = 5; g.strokeRect(8, 8, 496, 240);
  g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
  const lines = text.split('\n'); g.font = `${lines.length > 2 ? 37 : 54}px "PingFang SC","Microsoft YaHei",sans-serif`;
  lines.forEach((l, i) => g.fillText(l, 256, (i + .5) * 240 / lines.length + 8, 474));
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.userData.l7Owned = true; return tex;
}

function label(text: string, p: Vec3, normal: Vec3, w: number, h: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: textTexture(text), side: THREE.DoubleSide }));
  mesh.position.fromArray(p); mesh.quaternion.setFromUnitVectors(PLANE_NORMAL, new THREE.Vector3(...normal));
  return mesh;
}

/** Keep each reflected figure on the same Student rig as the ordinary campaign. */
class Figures {
  readonly group = new THREE.Group();
  private readonly students = new Map<number, { student: Student; p: Vec3; phase?: string; materials: THREE.Material[] }>();
  private lastTime?: number;
  private readonly clip?: THREE.Plane;
  constructor(clip?: THREE.Plane) { this.clip = clip; }
  update(figures: Figure[], seconds: number) {
    const dt = this.lastTime === undefined ? 0 : Math.min(.1, Math.max(0, seconds - this.lastTime));
    this.lastTime = seconds;
    const seen = new Set<number>();
    for (const f of figures.slice(0, 12)) {
      if (f.st === 2) continue;
      seen.add(f.id);
      let entry = this.students.get(f.id);
      if (!entry) {
        const owner = f.id >= 1000 ? f.id - 1000 : f.id;
        const student = new Student(CLOTHES[owner % CLOTHES.length]);
        const materials: THREE.Material[] = [];
        student.root.traverse(o => {
          if (!(o instanceof THREE.Mesh)) return;
          const source = Array.isArray(o.material) ? o.material : [o.material];
          const copies = source.map(material => {
            const copy = material.clone();
            copy.onBeforeCompile = material.onBeforeCompile;
            copy.customProgramCacheKey = material.customProgramCacheKey;
            if (this.clip) reflectMaterial(copy, this.clip);
            if (f.ghost && copy instanceof THREE.MeshStandardMaterial) {
              copy.color.lerp(new THREE.Color('#91a598'), .18);
              copy.emissive.multiplyScalar(.7);
            }
            materials.push(copy); return copy;
          });
          o.material = Array.isArray(o.material) ? copies : copies[0];
        });
        entry = { student, p: [...f.p], phase: f.phase, materials };
        this.students.set(f.id, entry); this.group.add(student.root);
      }
      const speed = dt > 0 ? Math.min(6, Math.hypot(f.p[0] - entry.p[0], f.p[2] - entry.p[2]) / dt) : 0;
      entry.student.root.position.fromArray(f.p); entry.student.root.rotation.y = f.yaw;
      entry.student.update(f.phase === 'still' ? 0 : dt, f.phase === 'still' ? 0 : speed, false, false, f.pitch ?? 0, Infinity, f.st === 1);
      if (f.st !== 1) entry.student.warden.bones.head.rotateX(-Math.max(-1.2, Math.min(1.2, f.pitch ?? 0)));
      entry.p = [...f.p]; entry.phase = f.phase;
    }
    for (const [id, entry] of this.students) if (!seen.has(id)) {
      entry.student.root.removeFromParent(); entry.student.dispose(); entry.materials.forEach(m => m.dispose()); this.students.delete(id);
    }
  }
  dispose() {
    for (const entry of this.students.values()) {
      entry.student.root.removeFromParent(); entry.student.dispose(); entry.materials.forEach(m => m.dispose());
    }
    this.students.clear();
  }
}

/** Dynamic figures need the same glass stencil and wall clip as the static reflected campus. */
function reflectMaterial(material: THREE.Material, clip: THREE.Plane) {
  material.stencilWrite = true; material.stencilRef = 1; material.stencilFunc = THREE.EqualStencilFunc;
  material.stencilFail = material.stencilZFail = material.stencilZPass = THREE.KeepStencilOp;
  material.clippingPlanes = [clip];
}

interface MirrorPass { id: number; mask: THREE.Scene; scene: THREE.Scene; root: THREE.Group; avatars: Figures; material: THREE.MeshLambertMaterial; mirror: typeof MIRRORS[number]; surface: THREE.Mesh }

function dutyStudent(): THREE.Group {
  const group = new THREE.Group(); group.name = 'mirror-key-duty-student';
  const add = (name: string, size: Vec3, p: Vec3, color: string) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshLambertMaterial({ color }));
    mesh.name = name; mesh.position.fromArray(p); group.add(mesh); return mesh;
  };
  const warden = new Warden(makeMonitorMaterials().map(material => material.clone()), false, 'monitor');
  new MonitorAnimator(warden).update(0, 0, 'idle');
  const band = new THREE.Mesh(new THREE.CylinderGeometry(.082, .082, .085, 14, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xb01818, roughness: .7, side: THREE.DoubleSide }));
  band.name = 'red-duty-armband'; band.position.set(0, -.14, -.012); warden.bones.upperArmL.add(band);
  group.add(warden.root);
  add('back-key-pouch', [.3,.28,.055], [0,1.03,.18], '#172d29');
  add('back-pocket-left-flap', [.17,.32,.025], [-.08,1.03,.345], '#657e75');
  add('back-pocket-right-flap', [.17,.32,.025], [.08,1.03,.345], '#657e75');
  const key = new THREE.Group(); key.name = 'mirror-back-key'; key.position.set(0,1.03,.3);
  const gold = new THREE.MeshBasicMaterial({ color: '#ffe19a' });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(.085,.019,6,14), gold); ring.position.y = .08; key.add(ring);
  const stem = new THREE.Mesh(new THREE.BoxGeometry(.032,.23,.032),gold); stem.position.y = -.065; key.add(stem);
  for (const y of [-.11,-.16]) { const tooth = new THREE.Mesh(new THREE.BoxGeometry(.09,.029,.032),gold); tooth.position.set(.035,y,0); key.add(tooth); }
  key.userData.l7Target = { kind: 'take-key' }; group.add(key);
  return group;
}

/** Geometry mirrors rendered by the campaign's existing camera, renderer and scene. */
export class L7MirrorView {
  readonly root = new THREE.Group();
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private world: THREE.Mesh;
  private decorations = new THREE.Group();
  private avatars = new Figures();
  private mirrors: MirrorPass[] = [];
  private readonly resetScene = new THREE.Scene();
  private readonly resetCamera = new THREE.Camera();
  private openKey = '';
  private reflected = 0;
  private frames = 0;
  private duty = dutyStudent();
  private keyState?: MirrorKeySnap;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer) {
    this.scene = scene; this.camera = camera; this.renderer = renderer;
    this.root.name = 'L7.campaign-mirror-hall';
    this.world = new THREE.Mesh(worldGeometry([]), new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.world.name = 'LAB.exact-server-solids';
    this.root.add(new THREE.AmbientLight('#c1d7b8', .92), this.world, this.decorations, this.avatars.group, this.duty);
    scene.add(this.root);
    this.makeDecorations();
    for (const m of MIRRORS) this.makeMirror(m);
    const reset = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      vertexShader: 'void main(){gl_Position=vec4(position.xy,1.0,1.0);}', fragmentShader: 'void main(){gl_FragColor=vec4(0.0);}',
      colorWrite: false, depthWrite: true, depthTest: true, depthFunc: THREE.AlwaysDepth, stencilWrite: true, stencilRef: 1, stencilFunc: THREE.EqualStencilFunc, stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp,
    })); reset.frustumCulled = false; this.resetScene.add(reset);
  }

  private makeDecorations() {
    const boxes: THREE.BufferGeometry[] = [];
    for (const m of MIRRORS) {
      const [x, y, z] = m.center, w = m.width, h = m.height;
      for (const side of [-1, 1]) {
        boxes.push(coloredBox({ minX: x -.035, maxX: x + .045, minY: y - h/2 -.06, maxY: y + h/2 + .06, minZ: z + side*w/2 -.045, maxZ: z + side*w/2 + .045 }, '#a8b7a8'));
        boxes.push(coloredBox({ minX: x -.035, maxX: x + .045, minY: y + side*h/2 -.045, maxY: y + side*h/2 + .045, minZ: z - w/2, maxZ: z + w/2 }, '#a8b7a8'));
      }
      this.decorations.add(label(m.id === 1 ? '暗室 · 01' : '标本室 · 02', [x+.06, y + h/2 + .25, z], m.normal, 1.25, .28));
      this.decorations.add(label(m.id === 1 ? '镜中看他背后\n转身时取下钥匙\n倒影停住？快走' : '镜中找到门\n钥匙开启二楼出口\n倒影停住？快走', [x+.06, y, z+1.73], m.normal, .92, .8));
    }
    for (const y of [0, 3.6]) {
      this.decorations.add(label(y === 0 ? '暗 室  /  1F' : '标 本 室  /  2F', [-81.25, y+2.53, 141.18], [0,0,-1], 1.3, .3));
      this.decorations.add(label('楼梯 →\n标本室在二楼', [-74.6,y+1.7,141.18], [0,0,-1], 1.35,.65));
      this.decorations.add(label('旧实验楼\n1F 暗室   /   2F 标本室', [-80,y+2.4,138.58], [0,0,1], 2.1,.65));
      // Geometry strips mark the corridor and lit stairwell without adding dynamic lights.
      for (const x of [-88,-80,-72]) boxes.push(coloredBox({ minX:x-.65,maxX:x+.65,minY:y+3.08,maxY:y+3.13,minZ:139.83,maxZ:140.17 }, '#d2d7b4'));
    }
    this.decorations.add(label('出 口\n全员集合', [L7_EXIT.x+.65,L7_EXIT.y+1.5,L7_EXIT.z], [-1,0,0], .8,.7));
    const g = mergeGeometries(boxes)!; boxes.forEach(b => b.dispose());
    this.decorations.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true })));
  }

  private makeMirror(m: typeof MIRRORS[number]) {
    const plane = new THREE.PlaneGeometry(m.width, m.height);
    const surface = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ color: '#273f3d' })); surface.position.fromArray(m.center);
    surface.userData.l7Target = { kind: 'mirror', id: m.id };
    surface.quaternion.setFromUnitVectors(PLANE_NORMAL, new THREE.Vector3(...m.normal)); this.root.add(surface);
    const mask = new THREE.Scene(); const maskMesh = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({
      colorWrite: false, depthWrite: false, depthTest: true, stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp,
    })); maskMesh.position.copy(surface.position).addScaledVector(new THREE.Vector3(...m.normal), .003); maskMesh.quaternion.copy(surface.quaternion); mask.add(maskMesh);
    const scene = new THREE.Scene(), root = new THREE.Group();
    root.position.x = m.center[0]*2; root.scale.x = -1;
    scene.fog = this.scene.fog; scene.add(new THREE.AmbientLight('#bed1c3', 1.2), root);
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    // The reflection exposes the hidden doorway behind the real cabinet/wall strip.
    // Using the same subtraction as the authoritative opening keeps its position exact.
    root.add(new THREE.Mesh(worldGeometry([m.id]), material), this.decorations.clone(true), dutyStudent());
    // The doorway exists as real 3D geometry solely in the reflected scene.
    const doorParts: THREE.BufferGeometry[] = [], doorGroup = new THREE.Group();
    doorGroup.name = 'mirror-only-secret-door'; root.add(doorGroup);
    for (const d of MIRROR_DOORS.filter(d => d.mirrorId === m.id)) {
      const [x,y,z] = d.wall, front = x-.13;
      doorParts.push(coloredBox({minX:front-.015,maxX:front+.015,minY:y+.025,maxY:y+d.height,minZ:z-d.width/2,maxZ:z+d.width/2}, '#193d35'));
      for (const side of [-1,1]) doorParts.push(coloredBox({minX:front-.025,maxX:front+.015,minY:y,maxY:y+d.height+.05,minZ:z+side*d.width/2-.035,maxZ:z+side*d.width/2+.035}, '#c3d7a8'));
      doorParts.push(coloredBox({minX:front-.025,maxX:front+.015,minY:y+d.height-.025,maxY:y+d.height+.045,minZ:z-d.width/2,maxZ:z+d.width/2}, '#c3d7a8'));
      doorParts.push(coloredBox({minX:front-.08,maxX:front-.02,minY:y+.95,maxY:y+1.05,minZ:z+d.width*.3-.06,maxZ:z+d.width*.3+.06}, '#d7d0a3'));
      doorGroup.add(label('推\n墙的另一边', [front-.035,y+1.63,z], [-1,0,0], .66,.45));
    }
    const doorGeo = mergeGeometries(doorParts)!; doorParts.forEach(b=>b.dispose());
    const doorMesh = new THREE.Mesh(doorGeo, new THREE.MeshBasicMaterial({vertexColors:true})); doorGroup.add(doorMesh);
    // Clip away the reflected back of the mirror's supporting wall; stencil confines the reflection to its glass.
    const clip = new THREE.Plane(new THREE.Vector3(-1,0,0), m.center[0]-.006);
    const avatars = new Figures(clip); root.add(avatars.group);
    root.traverse(o => { if (!(o instanceof THREE.Mesh)) return; const mats = Array.isArray(o.material) ? o.material : [o.material]; o.material = mats.map(mat => { const c = mat.clone(); c.stencilWrite = true; c.stencilRef = 1; c.stencilFunc = THREE.EqualStencilFunc; c.stencilFail = c.stencilZFail = c.stencilZPass = THREE.KeepStencilOp; c.clippingPlanes = [clip]; return c; }); if (!Array.isArray(o.material) || o.material.length===1) o.material = Array.isArray(o.material) ? o.material[0] : o.material; });
    this.mirrors.push({id:m.id,mask,scene,root,avatars,material,mirror:m,surface});
  }

  setDoors(open: number[]) {
    const key = [...open].sort().join(','); if (key === this.openKey) return; this.openKey = key;
    const old = this.world.geometry; this.world.geometry = worldGeometry(open);
    for (const m of this.mirrors) { const mesh = m.root.children[0] as THREE.Mesh; mesh.geometry.dispose(); mesh.geometry = worldGeometry([...new Set([...open,m.id])]); const door = m.root.getObjectByName('mirror-only-secret-door'); if (door) door.visible = !MIRROR_DOORS.some(d=>d.mirrorId===m.id && open.includes(d.id)); }
    old.dispose();
  }

  setKey(state: MirrorKeySnap) {
    this.keyState = state;
    for (const root of [this.duty, ...this.mirrors.map(m => m.root.getObjectByName('mirror-key-duty-student')!)]) {
      root.position.fromArray(state.guard.p); root.rotation.y = state.guard.yaw;
      const key = root.getObjectByName('mirror-back-key')!; key.visible = !state.taken;
      root.getObjectByName('back-pocket-left-flap')!.position.x = state.open ? -.22 : -.08;
      root.getObjectByName('back-pocket-right-flap')!.position.x = state.open ? .22 : .08;
      key.userData.l7Target = { kind: 'take-key', p: mirrorKeyPoint(state) };
    }
  }

  /** Explicit screen target for touch picking; a reflected key maps to the same authoritative action. */
  interactionAt(clientX: number, clientY: number): { kind: 'take-key' } | null {
    if (!this.keyState?.open || this.keyState.taken) return null;
    const rect=this.renderer.domElement.getBoundingClientRect?.()??{left:0,top:0,width:innerWidth,height:innerHeight};
    if(!rect.width||!rect.height||clientX<rect.left||clientY<rect.top||clientX>rect.left+rect.width||clientY>rect.top+rect.height)return null;
    this.camera.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2((clientX-rect.left) / rect.width * 2 - 1, 1 - (clientY-rect.top) / rect.height * 2), this.camera);
    const m = this.mirrors[0], key = m.root.getObjectByName('mirror-back-key')!;
    m.root.updateWorldMatrix(true,true);m.surface.updateWorldMatrix(true,false);this.world.updateWorldMatrix(true,false);
    // The tap must cross the actual glass before reaching the reflected 3D key.
    const glass = ray.intersectObject(m.surface), hit = ray.intersectObject(key, true);
    if(!glass.length)return null;
    const obstacle=ray.intersectObject(this.world)[0];
    if(obstacle&&obstacle.distance<glass[0].distance-.01)return null;
    if(hit.length&&glass[0].distance<hit[0].distance)return {kind:'take-key'};
    // A 44 px selection disc keeps the small key usable on phones; glass and authority still gate it.
    const centre=key.localToWorld(new THREE.Vector3(0,-.065,0)),point=centre.clone().project(this.camera);
    const x=rect.left+(point.x+1)*rect.width/2,y=rect.top+(1-point.y)*rect.height/2;
    return point.z>=-1&&point.z<=1&&glass[0].distance<centre.distanceTo(this.camera.position)&&Math.hypot(clientX-x,clientY-y)<=22?{kind:'take-key'}:null;
  }

  keyHitTarget(): { kind: 'take-key'; x: number; y: number } | null {
    if (!this.keyState?.open || this.keyState.taken) return null;
    const key = this.mirrors[0].root.getObjectByName('mirror-back-key')!;
    this.camera.updateMatrixWorld(true);
    this.mirrors[0].root.updateMatrixWorld(true);
    const point = key.localToWorld(new THREE.Vector3(0,-.065,0)).project(this.camera);
    if (Math.abs(point.x)>1 || Math.abs(point.y)>1 || point.z< -1 || point.z>1) return null;
    const rect=this.renderer.domElement.getBoundingClientRect?.()??{left:0,top:0,width:innerWidth,height:innerHeight};
    const x=rect.left+(point.x+1)*rect.width/2,y=rect.top+(1-point.y)*rect.height/2;
    return this.interactionAt(x,y)?{kind:'take-key',x,y}:null;
  }

  update(players: L7PlayerPose[], actors: MirrorActorSnap[], myId: number, seconds: number) {
    // Real teammates retain the campaign's Student rigs and network interpolation.
    this.avatars.update(actors.filter(a=>a.phase==='chase').map(a=>({id:1000+a.id,p:a.p,yaw:a.yaw,pitch:a.pitch,st:0,ghost:true,phase:a.phase})), seconds);
    for (const m of this.mirrors) {
      const local = actors.filter(a=>a.mirrorId===m.id&&a.phase!=='chase').map(a=>({id:a.id,p:a.p,yaw:a.yaw,pitch:a.pitch,st:0,ghost:true,phase:a.phase}));
      m.avatars.update([...players.filter(p=>p.id!==myId&&!local.some(a=>a.id===p.id)),...local],seconds);
    }
  }

  /** Called after the normal campaign draw, including the existing nodraw screenshot path. */
  renderMirrors() {
    const r = this.renderer, autoClear = r.autoClear, autoReset = r.info.autoReset, clipping = r.localClippingEnabled;
    r.autoClear = false; r.info.autoReset = false; r.localClippingEnabled = true;
    this.camera.updateMatrixWorld(true); this.reflected = 0;
    const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(this.camera.projectionMatrix,this.camera.matrixWorldInverse));
    try {
      for (const m of this.mirrors) {
        if (this.reflected>=2 || this.camera.position.x<m.mirror.center[0] || Math.abs(this.camera.position.y-m.mirror.center[1])>3.1 || !frustum.intersectsObject(m.surface)) continue;
        r.clearStencil(); r.render(m.mask,this.camera); r.render(this.resetScene,this.resetCamera); r.render(m.scene,this.camera); this.reflected++;
      }
      this.frames++;
    } finally { r.autoClear = autoClear; r.info.autoReset = autoReset; r.localClippingEnabled = clipping; }
  }
  stats() { return { mirrors:this.reflected,frames:this.frames,geometryMirror:true,renderTargets:0 }; }
  dispose() {
    this.avatars.dispose(); for (const mirror of this.mirrors) mirror.avatars.dispose();
    this.scene.remove(this.root);
    const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>();
    for (const root of [this.root, this.resetScene, ...this.mirrors.flatMap(m=>[m.scene,m.mask])]) root.traverse(o=>{
      if (!(o instanceof THREE.Mesh)) return;
      if (o instanceof THREE.SkinnedMesh) o.skeleton.dispose();
      geometries.add(o.geometry);
      for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
        materials.add(mat);
        const map = (mat as THREE.MeshBasicMaterial).map; if (map?.userData.l7Owned) textures.add(map);
      }
    });
    geometries.forEach(g=>g.dispose()); materials.forEach(m=>m.dispose()); textures.forEach(t=>t.dispose());
  }
}
