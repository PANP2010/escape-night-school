// `/?warden=1`: 角色074 alone on a turntable for model screenshots (tests/e2e/x-warden.spec.ts → docs/shots/warden/).
import * as THREE from 'three';
import { Warden } from './model.ts';
import { Student } from './student.ts';
import { makeMonitorMaterials } from './textures.ts';
import type { ClipName } from './anim.ts';

type View = 'lineup' | 'duo' | 'duoside' | 'front' | 'side' | 'back' | 'face' | 'far' | 'act' | 'peek' | 'hands' | 'profile' | 'face34' | 'hand' | 'review';
// camera [position, look-at]; the model faces -Z
const VIEWS: Record<View, [THREE.Vector3Tuple, THREE.Vector3Tuple]> = {
  lineup: [[0.2, 1.6, -6.5], [0, 1.02, 0]], // 角色074 between two teammates
  duo: [[0, 1.35, -4.4], [0, 1.02, 0]], // 角色074 (his right) next to the 值日生: build comparison
  duoside: [[4.4, 1.35, 0], [0, 1.02, 0]],
  front: [[0.3, 1.35, -3.7], [0, 1.02, 0]],
  side: [[3.7, 1.35, -0.2], [0, 1.02, 0]],
  review: [[4.7, 1.25, -0.3], [0, 1.02, 0]], // review videos: whole body with margin (chase hunch, catch reach), lighter backdrop
  back: [[-0.4, 1.4, 3.7], [0, 1.02, 0]],
  face: [[0.15, 1.95, -0.95], [0, 1.88, 0]],
  profile: [[1.0, 1.9, -0.13], [0, 1.86, -0.13]], // close side view: nose bridge, cheekbone, jaw line, neck
  face34: [[0.5, 1.95, -0.85], [0, 1.87, -0.05]],
  far: [[0.5, 1.6, -10], [0, 1.02, 0]],
  act: [[2.1, 1.4, -3.2], [0, 1.02, 0]], // front three-quarter, his left side
  peek: [[0.1, 1.9, -1.9], [0, 1.85, 0]], // through the back-door window
  hand: [[0.75, 0.95, -0.7], [0.3, 0.9, -0.3]], // close-up of his left hand + cuff (chase half fist, or hanging)
  hands: [[-0.25, 1.15, 0.85], [0, 0.95, -0.05]], // close-up of the hands clasped behind his back

};

export function showcase() {
  document.getElementById('lobby')!.hidden = true;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.05, 50);
  const hemi = new THREE.HemisphereLight(0xc8d0e0, 0x302820, 1.2);
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(-2, 4, -3);
  const rim = new THREE.DirectionalLight(0x9fb8ff, 1.5);
  rim.position.set(2, 3, 3);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), new THREE.MeshStandardMaterial({ color: 0x5a5650 }));
  floor.rotation.x = -Math.PI / 2;
  // back door with a small window (only in the peek view): his half face fills the pane
  const door = new THREE.Group(), doorMat = new THREE.MeshStandardMaterial({ color: 0x6b4a32, roughness: 0.8 });
  for (const [w, h, x, y] of [[1, 1.48, 0, 0.74], [1, 0.5, 0, 2.05], [0.44, 0.32, -0.28, 1.64], [0.4, 0.32, 0.3, 1.64]])
  {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.05), doorMat);
    m.position.set(x, y, -0.3);
    door.add(m);
  }
  const warden = new Warden();
  warden.update(0, 0);
  const monitor = new Warden(makeMonitorMaterials(), false, 'monitor');
  monitor.root.visible = false;
  // teammates for the lineup view: one standing with the flashlight on, one crouching
  const students = [[0x3a6ab0, -1.05, false], [0xb09a3a, 1.05, true]].map(([c, x, crouch]) => {
    const s = new Student(c as number);
    s.root.position.x = x as number; s.root.position.z = 0.4;
    s.setName(crouch ? '小黄' : '小蓝');
    s.root.visible = false;
    return { s, crouch: crouch as boolean };
  });
  scene.add(hemi, key, rim, floor, door, warden.root, monitor.root, ...students.map((o) => o.s.root));
  /** Freeze one action clip at clip time t (s). */
  const pose = (clip: ClipName, t: number) => warden.anim.pose(clip, t);
  // night + flashlight (the in-game look): a warm spot from the camera, near-black ambient
  const torchLight = new THREE.SpotLight(0xffe2b0, 0, 16, 0.38, 0.5, 1.2);
  scene.add(torchLight, torchLight.target);
  const torch = (on: boolean) => {
    torchLight.intensity = on ? 9 : 0;
    torchLight.position.copy(camera.position).add(new THREE.Vector3(0.25, -0.2, 0));
    torchLight.target.position.set(0, 1.1, 0);
    hemi.intensity = on ? 0.06 : 1.2; key.intensity = on ? 0 : 2.2; rim.intensity = on ? 0.12 : 1.5;
    scene.background = new THREE.Color(on ? 0x050608 : 0x3a3d44);
  };
  let silhouette = false;
  const view = (v: View) => {
    const [p, t] = VIEWS[v];
    camera.position.set(...p); camera.lookAt(...t);
    // far view = backlit silhouette in a dark corridor: only the outline (bald head, glasses glint) reads
    silhouette = v === 'far';
    scene.background = new THREE.Color(silhouette ? 0x8a8f99 : v === 'review' ? 0x7d8490 : 0x3a3d44);
    hemi.intensity = silhouette ? 0.08 : 1.2; key.intensity = silhouette ? 0.15 : 2.2; rim.intensity = silhouette ? 3 : 1.5;
    floor.visible = !silhouette;
    door.visible = v === 'peek';
    for (const o of students) o.s.root.visible = v === 'lineup';
    warden.root.position.z = v === 'lineup' ? 0.2 : 0;
    const duo = v === 'duo' || v === 'duoside';
    monitor.root.visible = duo;
    warden.root.position.x = v === 'duo' ? -0.45 : 0; monitor.root.position.x = v === 'duo' ? 0.45 : 0;
    monitor.root.position.z = v === 'duoside' ? 0.7 : 0; warden.root.position.z = v === 'duoside' ? -0.7 : warden.root.position.z;
  };
  view('front');
  const clock = new THREE.Clock();
  let held = false; // a video script steps the animation itself and grabs every frame
  const loop = () => {
    if (held) { requestAnimationFrame(loop); return; }
    const dt = Math.min(0.1, clock.getDelta());
    if (monitor.root.visible) monitor.update(dt, 0);
    for (const o of students) if (o.s.root.visible) o.s.update(dt, 0, o.crouch, true, 0, 3);
    renderer.render(scene, camera); requestAnimationFrame(loop);
  };
  loop();
  /** Render now and return the frame as a JPEG data URL; stops the free-running loop. */
  const frame = () => { held = true; renderer.render(scene, camera); return renderer.domElement.toDataURL('image/jpeg', 0.9); };
  (window as unknown as { __warden: object }).__warden = { view, pose, torch, warden, frame, triangles: () => renderer.info.render.triangles };
}
