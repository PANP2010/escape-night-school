// Repeatable 30 fps skeletal diagnosis, no browser/rendering. Run from game: node tests/probe-remote-motion.mjs
// Reports existing direction/crouch limitations; this is a probe, not a quality-gate assertion.
import * as THREE from 'three';

const ctx = new Proxy(function () {}, { get: (_, k) => k === 'measureText' ? () => ({ width: 1 }) : ctx, apply: () => ctx, set: () => true });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
const { Student } = await import('../client/src/warden/student.ts');
const sole = Array.from({ length: 180 }, (_, i) => {
  const a = i * Math.PI * 2 / 180;
  return new THREE.Vector3(0, -0.045 + 0.048 * Math.sin(a), 0.035 + 0.13 * Math.cos(a));
});
const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const round = (n) => Math.round(n * 1000) / 1000;
const rows = [];
for (const [name, vx, vz, crouch] of [['forward', 0, -3.4, false], ['strafe', 3.4, 0, false], ['backward', 0, 3.4, false], ['crouch forward', 0, -1.8, true]]) {
  const st = new Student(0x3366aa), slips = [], ys = [];
  let prev;
  for (let i = 0; i < 150; i++) {
    st.root.position.x += vx / 30; st.root.position.z += vz / 30;
    st.update(1 / 30, Math.hypot(vx, vz), crouch, false, 0, 3);
    st.root.updateMatrixWorld(true);
    const at = ['footL', 'footR'].map((n) => sole.map((p) => p.clone().applyMatrix4(st.warden.bones[n].matrixWorld)).reduce((a, p) => p.y < a.y ? p : a));
    const planted = [0, 1].map((k) => st.warden.anim.planted(k));
    if (i > 60) for (let k = 0; k < 2; k++) {
      if (planted[k]) ys.push(at[k].y);
      if (planted[k] && prev.planted[k]) slips.push(Math.hypot(at[k].x - prev.at[k].x, at[k].z - prev.at[k].z) * 30);
    }
    prev = { at, planted };
  }
  rows.push({ name, speed: Math.hypot(vx, vz), stanceSlipMedian: round(median(slips)), stanceSlipMax: round(Math.max(...slips)),
    stanceSoleMedianY: round(median(ys)), stanceSoleMinY: round(Math.min(...ys)), stanceSoleMaxY: round(Math.max(...ys)) });
  st.dispose();
}
console.table(rows);

const idle = new Student(0x3366aa), chest = [], head = [];
for (let i = 0; i < 90; i++) {
  idle.update(1 / 30, 0, false, false, 0, 3);
  chest.push(new THREE.Euler().setFromQuaternion(idle.warden.bones.chest.quaternion).x);
  head.push(new THREE.Euler().setFromQuaternion(idle.warden.bones.head.quaternion).x);
}
const transitions = [];
for (const [name, secs, speed, yawRate] of [['start+move', 1, 3.4, 0], ['stop', 2, 0, 0], ['turn', 2, 0, 1.5]]) {
  const states = new Set();
  for (let i = 0; i < secs * 30; i++) {
    idle.root.position.z -= speed / 30; idle.root.rotation.y += yawRate / 30;
    idle.update(1 / 30, speed, false, false, 0, 3);
    states.add(idle.warden.anim.loco);
  }
  transitions.push({ name, states: [...states] });
}
console.log(JSON.stringify({ idleChestRangeRad: round(Math.max(...chest) - Math.min(...chest)), idleHeadRangeRad: round(Math.max(...head) - Math.min(...head)), transitions }, null, 2));
idle.dispose();
