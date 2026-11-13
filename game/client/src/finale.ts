import * as THREE from 'three';
import type { CompletionStats, FinalePhase, FinaleState } from '../../shared/protocol.ts';
import type { LevelDef } from '../../shared/levels/def.ts';

export type FinalePoint = { x: number; y: number; z: number };

/** The title and current stage shown in the ordinary objective panel. */
export function finaleObjective(state: FinaleState | null, touch = false) {
  const members = (state?.members ?? []).filter(m => m.status !== 'left');
  const crossed = members.filter((m) => m.crossedOut).length;
  const phase = state?.phase ?? 'rollcall';
  const steps = ['找到点名册，划掉全队名字', '沿绿色路线出办公楼，冲出校门'];
  return {
    steps,
    cur: phase === 'chase' || phase === 'complete' ? 1 : 0,
    got: phase === 'chase' ? `已划名：${crossed}/${members.length}　${state?.rescueMs !== undefined ? '撤离' : '追击'}剩余 ${formatClock(state?.rescueMs ?? state?.remainingMs ?? 0)}` : `已划名：${crossed}/${members.length}`,
    key: `${phase}:${state?.revision ?? 0}:${crossed}:${Math.ceil((state?.remainingMs ?? 0) / 1000)}`,
    hints: phase === 'rollcall' ? [touch ? '教务处桌面有一本点名册，走近后直接点按书本' : '教务处桌面有一本点名册，走近按 E 查看'] : ['先从教务处回到走廊，经办公楼南门离开；沿绿色路标穿过室外校门'],
    note: phase === 'chase' ? '办公楼南门 → 室外绿标 → 校门外安全区' : touch ? '点按点名册，再点按每个队员的名字' : '走近点名册按 E，再点击每个队员的名字',
  };
}

/** Friendly presentation strings, kept pure so the authoritative values can be tested without a browser. */
export function finaleStatusText(state: FinaleState): string {
  if (state.phase === 'chase') {
    const left = Math.max(0, Math.ceil((state.rescueMs ?? state.remainingMs ?? 0) / 1000));
    return `冲向校门！${state.rescueMs !== undefined ? '队伍撤离' : '追击'}剩余 ${formatClock(left * 1000)}`;
  }
  if (state.phase === 'complete') return '已经安全离开学校';
  const members = state.members.filter(m => m.status !== 'left');
  const crossed = members.filter(m => m.crossedOut).length;
  return `划掉全队名字 · ${crossed}/${members.length}`;
}

export function completionText(stats: CompletionStats) {
  return {
    time: formatClock(stats.elapsedMs),
    downs: stats.downs,
    members: stats.members.map((m) => ({ ...m, result: m.escaped ? '已逃出' : '未逃出' })),
  };
}

export function formatClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return hours ? `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/** Book on the registrar's desk: real geometry, an emissive cover, and a legible floating label. */
export function buildRollcallBook(scene: THREE.Scene, at: FinalePoint, touch = false): { root: THREE.Group; ring: THREE.Mesh; label: THREE.Sprite } {
  const root = new THREE.Group();
  root.position.set(at.x, at.y + 0.79, at.z); // tabletop at y=.76; cover bottom sits 3 mm above it
  const leather = new THREE.MeshStandardMaterial({ color: 0x541b22, roughness: 0.68, metalness: 0.08, emissive: 0x26070b, emissiveIntensity: 0.75 });
  const paper = new THREE.MeshStandardMaterial({ color: 0xe9dfc4, roughness: 0.9 });
  const gilt = new THREE.MeshStandardMaterial({ color: 0xc9a454, metalness: 0.55, roughness: 0.38, emissive: 0x4d3109 });
  const cover = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.055, 0.34), leather);
  const pages = new THREE.Mesh(new THREE.BoxGeometry(0.425, 0.038, 0.292), paper);
  pages.position.set(0.012, 0.038, 0);
  const spine = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.068, 0.35), leather);
  spine.position.x = -0.21;
  const badge = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.006, 0.12), gilt);
  badge.position.set(0.05, 0.069, 0);
  const title = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.07), new THREE.MeshBasicMaterial({ map: textTexture('点 名 册', '#f1d99b', '#451318'), transparent: true, side: THREE.DoubleSide }));
  title.rotation.x = -Math.PI / 2;
  title.position.set(0.05, 0.073, 0);
  root.add(cover, pages, spine, badge, title);

  const ring = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.43, 40), new THREE.MeshBasicMaterial({ color: 0x70e7a2, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.095;
  root.add(ring);

  const labelMap = textTexture(touch ? '点按点名册' : '点名册  ·  按 E 查看', '#f5e9bf', '#173328');
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelMap, transparent: true, depthTest: false, depthWrite: false }));
  label.scale.set(0.95, 0.21, 1);
  label.position.set(0, 0.5, 0);
  label.renderOrder = 1000;
  root.add(label);
  scene.add(root);
  return { root, ring, label };
}

/** A floating three-dimensional navigation target for the exterior chase. */
export function buildGoalBeacon(scene: THREE.Scene): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0x63e79a, transparent: true, opacity: 0.88, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.035, 7, 24), mat);
  ring.position.y = 0.35;
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.07, 1.65, 8, 1, true), mat);
  stem.position.y = 1.2;
  const cap = new THREE.Mesh(new THREE.OctahedronGeometry(0.2, 0), mat);
  cap.position.y = 2.15;
  g.add(ring, stem, cap);
  g.visible = false;
  g.traverse((o) => { o.renderOrder = 998; });
  scene.add(g);
  return g;
}

/** Keep players close to each authored corner before switching: a 2.2 m skip cuts across the narrow exterior fences. */
export function advanceFinaleRoute(route: readonly FinalePoint[], from: FinalePoint, index: number): number {
  let i = Math.max(0, Math.min(route.length - 1, index));
  while (i < route.length - 1 && Math.hypot(route[i].x - from.x, 2 * (route[i].y - from.y), route[i].z - from.z) < 1.0) i++;
  return i;
}

export function finaleGoalPoint(phase: FinalePhase, def: NonNullable<LevelDef['finale']>, index = 0): FinalePoint | null {
  if (phase === 'rollcall') return def.rollcall;
  if (phase !== 'chase') return null;
  const route = def.route;
  if (!route.length) return def.gate ?? null;
  const i = Math.max(0, Math.min(route.length - 1, index));
  return route[i] ?? def.gate ?? null;
}

function textTexture(text: string, fg: string, bg: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 112;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = bg; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = fg; ctx.lineWidth = 6; ctx.strokeRect(5, 5, canvas.width - 10, canvas.height - 10);
  ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 60px "Noto Sans CJK SC", sans-serif';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  return map;
}
