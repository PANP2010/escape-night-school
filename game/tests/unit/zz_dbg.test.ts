import { it } from 'vitest';
import * as THREE from 'three';
import { MATS, Warden } from '../../client/src/warden/model.ts';
const mk = () => new Warden(MATS.map(() => new THREE.MeshBasicMaterial()));
const drive = (script: [number, string, number, number][], dt = 1 / 60) => {
  const warden = mk(), out: any[] = []; let t = 0;
  for (const [seg, [dur, anim, speed, turn]] of script.entries()) for (let i = 0; i < Math.round(dur / dt); i++) {
    t += dt; warden.root.rotation.y += turn * dt;
    warden.root.position.addScaledVector(new THREE.Vector3(-Math.sin(warden.root.rotation.y), 0, -Math.cos(warden.root.rotation.y)), speed * dt);
    warden.update(dt, speed, anim, null); warden.root.updateMatrixWorld(true);
    const at = [warden.bones.footL, warden.bones.footR].map((b) => b.getWorldPosition(new THREE.Vector3()));
    const F = (warden.anim as any).foot;
    out.push({ t, seg, loco: warden.anim.loco, at, local: at.map((p) => warden.bones.hips.parent!.worldToLocal(p.clone())), planted: [0, 1].map((k) => warden.anim.planted(k)),
      yawErr: [0, 1].map((k) => +(F[k].yaw - (warden.anim as any).cy[k]).toFixed(3)), pitch: F.map((f: any) => +f.pitch.toFixed(3)), sp: +(warden.anim as any).speed.toFixed(2) });
  }
  return out;
};
it('dbg', () => {
  const fr = drive([[1, 'idle', 0, 0], [1.6, 'idle', 0, 2.5], [1.5, 'idle', 0, 0]]);
  const held: any[] = [null, null]; const lines: string[] = [];
  for (const [n, f] of fr.entries()) { if (f.seg !== 1) continue; for (const k of [0, 1]) {
    if (!f.planted[k]) { held[k] = null; continue; }
    const h = (held[k] ??= f.at[k].clone()); const d = Math.hypot(f.at[k].x - h.x, f.at[k].z - h.z);
    if (d > 0.004) lines.push(`turn n=${n} k=${k} d=${d.toFixed(4)} yawErr=${f.yawErr[k]} pitch=${f.pitch[k]} y=${f.at[k].y.toFixed(3)}`);
  } }
  console.log(lines.slice(0, 25).join('\n'));
  for (const [anim, speed, stop] of [['patrol', 2.0, 'patrol'], ['chase', 4.6, 'catch']] as const) {
    const g = drive([[2, anim, speed, 0], [1.8, stop, 0, 0]]); const e = g.at(-1);
    console.log(anim, 'end local', e.local.map((p: THREE.Vector3) => [p.x.toFixed(3), p.z.toFixed(3)]), 'loco', g.filter((f: any) => f.seg === 1).map((f: any) => f.loco).filter((s: string, i: number, a: string[]) => s !== a[i - 1]));
  }
  for (const [sp, dt] of [[4.6, 1 / 60], [3.6, 1 / 60], [4.6, 1 / 24]]) { const q = drive([[2, 'chase', sp, 0], [1.8, 'catch', 0, 0]], dt);
    console.log('air', sp, dt.toFixed(3), q.filter((f: any) => f.seg === 1 && !f.planted[0] && !f.planted[1]).map((f: any) => `${f.t.toFixed(3)}:${f.loco}:${f.sp}`).join(' ')); }
  const c = drive([[3, 'chase', 3.6, 0], [2, 'catch', 0, 0]], 1 / 24); const L: string[] = [];
  for (let i = 1; i < c.length; i++) if (c[i].seg === 1) { const j = [0, 1].map((k) => Math.hypot(c[i].at[k].x - c[i - 1].at[k].x, c[i].at[k].z - c[i - 1].at[k].z)); if (Math.max(...j) > 0.06) L.push(`stop24 i=${i} t=${c[i].t.toFixed(2)} loco=${c[i].loco} sp=${c[i].sp} jump=${j.map((x) => x.toFixed(3))} planted=${c[i].planted}`); }
  console.log(L.join('\n'));
});
