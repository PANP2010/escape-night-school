import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CLIPS, GAIT, POSTURE, STRIDE, UPRIGHT, bagSwing, buildClips, clipFor, gaitRate, RUN_CLIP, footPitch, jokeSmile, strideOf } from '../../client/src/warden/anim.ts';
import { MATS, Warden } from '../../client/src/warden/model.ts';
import { SPEED } from '../../shared/constants.ts';
import { WARDEN_CHASE_SPEED, WARDEN_INVESTIGATE_SPEED, WARDEN_PATROL_SPEED } from '../../server/ai/warden.ts';
import { MONITOR_SPEED } from '../../server/ai/monitor.ts';

describe('角色074 animation', () => {
  it('maps server actions + speed to clips', () => {
    expect(clipFor('patrol', 1.2)).toBe('walk');
    expect(clipFor('patrol', 0)).toBe('look'); // stops and looks left/right
    expect(clipFor('investigate', 0)).toBe('investigate');
    expect(clipFor('investigate', 1)).toBe('walk');
    for (const a of ['chase', 'catch', 'joke', 'peek']) expect(clipFor(a, 3)).toBe(a);
    expect(clipFor('???', 0)).toBe('idle');
    expect(clipFor('idle', 1)).toBe('walk');
  });
  it('remote students pick walk / sprint from ground speed: walking 3.4 m/s walks, running 6 m/s sprints', () => {
    expect(clipFor('run', 0)).toBe('idle');
    expect(clipFor('run', SPEED.crouch)).toBe('walk');
    expect(clipFor('run', SPEED.walk)).toBe('walk');
    expect(clipFor('run', SPEED.run)).toBe('sprint');
    expect(RUN_CLIP).toBeGreaterThan(SPEED.walk * 1.15); // a walker's jitter (StepSmoother tolerance) never flickers into the sprint
    expect(RUN_CLIP).toBeLessThan(SPEED.run * 0.85);
  });
  it('every gait at its game speed steps at a human cadence (no skating, no scurrying)', () => {
    const cases: [Parameters<typeof gaitRate>[0], number][] = [['walk', WARDEN_PATROL_SPEED], ['walk', WARDEN_INVESTIGATE_SPEED], ['chase', WARDEN_CHASE_SPEED],
      ['walk', SPEED.crouch], ['walk', SPEED.walk], ['sprint', SPEED.run], ['sprint', MONITOR_SPEED]];
    for (const [clip, v] of cases) {
      const steps = 2 * gaitRate(clip, v); // two footfalls per cycle
      expect(steps, `${clip} @ ${v}`).toBeGreaterThan(2); // patrol is now a deliberate 1.4 m/s walk, before the teacher's 1.14 scale
      expect(steps, `${clip} @ ${v}`).toBeLessThan(6.2);
    }
  });
  it('gait rate = speed / stride, so ground speed matches the planted foot', () => {
    expect(STRIDE.walk).toBeCloseTo(strideOf(0.36));
    expect(STRIDE.walk).toBeGreaterThan(0.8); expect(STRIDE.walk).toBeLessThan(1.3);
    expect(STRIDE.chase).toBeGreaterThan(STRIDE.walk);
    expect(gaitRate('walk', 1.2) * STRIDE.walk).toBeCloseTo(1.2);
    expect(gaitRate('chase', 3) * STRIDE.chase).toBeCloseTo(3);
    expect(clipFor('sprint', 6)).toBe('sprint');
    expect(STRIDE.sprint).toBeGreaterThan(STRIDE.chase);
    expect(gaitRate("sprint", 6)).toBeLessThan(2.5); // ≤ 5 steps/s at 6 m/s
    expect(gaitRate('sprint', 6) * STRIDE.sprint).toBeCloseTo(6);
    expect(gaitRate('walk', 0)).toBe(0);
    expect(gaitRate('idle', 2)).toBe(1);
  });
  it('the smile only grows during the joke', () => {
    expect(jokeSmile(0)).toBeCloseTo(0.3);
    expect(jokeSmile(1.8)).toBeGreaterThan(0.3);
    expect(jokeSmile(4)).toBeCloseTo(1);
  });
  it('every clip carries the stoop; walk sways the pelvis sideways and up/down', () => {
    const clips = buildClips(new THREE.Vector3(0, 0.95, 0));
    const lean = (e: [number, number, number] | undefined) => e![0];
    expect(lean(POSTURE.spine) + lean(POSTURE.chest)).toBeGreaterThan(0.14); // 8–12° hunch
    expect(lean(POSTURE.spine) + lean(POSTURE.chest)).toBeLessThan(0.21);
    for (const n of CLIPS) {
      const tr = clips[n].tracks.find((t) => t.name === 'chest.quaternion')!;
      const x = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().fromArray(tr.values, 0)).x;
      expect(x, n).toBeGreaterThan(0.05);
    }
    const pos = clips.walk.tracks.find((t) => t.name === 'hips.position')!.values;
    const xs = pos.filter((_, i) => i % 3 === 0), ys = pos.filter((_, i) => i % 3 === 1);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.08); // ±4–5 cm: readable against a floor line in a still
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.025);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(0.055); // 6–7 cm read as "suddenly a head shorter" mid-stride
  });
  it('walk twists the torso: pelvis and chest yaw against each other; 背手 pinches the shoulder blades back', () => {
    const clips = buildClips(new THREE.Vector3(0, 0.95, 0));
    const yaws = (clip: THREE.AnimationClip, bone: string) => {
      const v = clip.tracks.find((t) => t.name === `${bone}.quaternion`)!.values, out: number[] = [];
      for (let i = 0; i < v.length; i += 4) out.push(new THREE.Euler().setFromQuaternion(new THREE.Quaternion().fromArray(v, i)).y);
      return out;
    };
    const hips = yaws(clips.walk, 'hips'), chest = yaws(clips.walk, 'chest');
    expect(Math.max(...hips) - Math.min(...hips)).toBeGreaterThan(0.25); // ±8°+: readable in a single frame
    const k = hips.indexOf(Math.max(...hips));
    expect(chest[k]).toBeLessThan(0);
    const head = yaws(clips.walk, 'head'); // head/neck follow the shoulders (was lost inside a trailing comment)
    expect(Math.max(...head) - Math.min(...head)).toBeGreaterThan(0.08);
    expect(yaws(clips.look, "shoulderL")[0]).toBeCloseTo(-yaws(clips.look, "shoulderR")[0], 1); // shoulders stay symmetric, arms hang in front
  });
  it('sling bag hangs plumb against the pelvis roll and swings behind the stride', () => {
    const hips: [number, number, number] = [0, 0.15, 0.085];
    const at = (a: number) => bagSwing(a, [0, hips[1] * Math.sin(a), hips[2] * Math.sin(a)], 0.14)[2] + hips[2] * Math.sin(a); // world roll
    const rolls = Array.from({ length: 64 }, (_, i) => at((i / 64) * Math.PI * 2));
    const peak = rolls.indexOf(Math.min(...rolls)) / 64; // most outward swing
    expect(peak).toBeGreaterThan(0.25 + 0.1); // lags the pelvis (whose outward-most is at a = π/2 → 0.25) by > 36°
    expect(peak).toBeLessThan(0.25 + 0.25);
    expect(Math.max(...rolls)).toBeLessThan(0.1); // never swings far into the thigh
    const clips = buildClips(new THREE.Vector3(0, 0.95, 0));
    expect(clips.walk.tracks.some((t) => t.name === 'bag.quaternion')).toBe(true);
  });
  it('bakes looping clips that start and end on the same pose', () => {
    const clips = buildClips(new THREE.Vector3(0, 0.95, 0));
    for (const n of CLIPS) {
      expect(clips[n].tracks.length).toBeGreaterThan(15);
      if (n === 'catch' || n === 'joke') continue;
      for (const tr of clips[n].tracks) {
        const v = tr.values, w = tr.getValueSize(), end = v.length - w;
        for (let k = 0; k < w; k++) expect(Math.abs(v[k] - v[end + k])).toBeLessThan(1e-3);
      }
    }
  });
  it('mixer drives the bones, crossfades and turns the head toward a target', () => {
    const warden = new Warden(MATS.map(() => new THREE.MeshBasicMaterial()));
    for (let i = 0; i < 10; i++) warden.update(0.05, 1.4, 'patrol');
    expect(warden.anim.clip).toBe('walk');
    expect(warden.bones.thighL.quaternion.x).not.toBe(0);
    for (let i = 0; i < 40; i++) warden.update(0.05, 0, 'chase', new THREE.Vector3(3, 1.6, -3)); // world -Z = his front; +X world = his right
    expect(warden.anim.clip).toBe('chase');
    expect(warden.anim.actions.walk.getEffectiveWeight()).toBe(0);
    const e = new THREE.Euler().setFromQuaternion(warden.bones.head.quaternion);
    expect(e.y).toBeLessThan(-0.2); // turned to his right
  });
  it('rolls the foot: toe up at heel strike, toe down at toe-off, flat in mid-stance', () => {
    // leg phase a: thigh = -amp·sin(a), so a = π/2 is the leg furthest forward (heel strike), a = -π/2 furthest back
    expect(footPitch(Math.PI / 2)).toBeLessThan(-0.2);
    expect(footPitch(-1.75)).toBeGreaterThan(0.4);
    expect(Math.abs(footPitch(Math.PI * 0.95))).toBeLessThan(0.08);
    const walk = buildClips(new THREE.Vector3(0, 0.95, 0)).walk;
    const knee = walk.tracks.find((t) => t.name === 'shinL.quaternion')!.values;
    let max = 0;
    for (let i = 0; i < knee.length; i += 4) max = Math.max(max, 2 * Math.asin(Math.abs(knee[i])));
    expect(max).toBeGreaterThan(0.9); // clear knee bend in the swing, not a compass leg
  });
});

describe('值日生 posture', () => {
  it('stands straight: no stoop, chin level, and every clip is built on it', () => {
    const lean = (e: [number, number, number] | undefined) => e?.[0] ?? 0;
    expect(Math.abs(lean(UPRIGHT.spine) + lean(UPRIGHT.chest))).toBeLessThan(0.07);
    expect(Math.abs(lean(UPRIGHT.neck) + lean(UPRIGHT.head))).toBeLessThan(0.07);
    const hip = new THREE.Vector3(0, 0.95, 0);
    const chestX = (r: Record<string, THREE.AnimationClip>) => r.idle.tracks.find((t) => t.name === 'chest.quaternion')!.values[0];
    expect(chestX(buildClips(hip)) - chestX(buildClips(hip, UPRIGHT))).toBeGreaterThan(0.05); // ~0.2 rad less forward roll
  });
});

describe('角色074 posture layer', () => {
  const mk = () => new Warden(MATS.map(() => new THREE.MeshBasicMaterial()));
  const ex = (q: THREE.Quaternion) => new THREE.Euler().setFromQuaternion(q);
  const ang = (a: THREE.Quaternion, b: THREE.Quaternion) => 2 * Math.acos(Math.min(1, Math.abs(a.dot(b))));
  const variance = (xs: number[]) => { const m = xs.reduce((s, x) => s + x, 0) / xs.length; return xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length; };

  it('breathes and keeps the head alive while standing (idle is never frozen)', () => {
    const warden = mk(), chest: number[] = [], head: number[] = [], yaw: number[] = [];
    for (let i = 0; i < 60; i++) { // 3 s
      warden.update(0.05, 0, 'idle');
      chest.push(ex(warden.bones.chest.quaternion).x); head.push(ex(warden.bones.head.quaternion).x); yaw.push(ex(warden.bones.head.quaternion).y);
    }
    expect(Math.max(...chest) - Math.min(...chest)).toBeGreaterThan(2 * 0.06 * 0.95); // ≥ 0.06 rad each way (3 s ≈ 1.2 breaths)
    expect(variance(chest)).toBeGreaterThan(1e-3);
    expect(variance(head) + variance(yaw)).toBeGreaterThan(2e-4);
  });
  it('shifts its weight foot to foot without the feet sliding', () => {
    const warden = mk(), w = new THREE.Vector3(), feet: THREE.Vector3[][] = [[], []], hips: number[] = [];
    for (let i = 0; i < 240; i++) { // 12 s: two 5.9 s shift cycles
      warden.update(0.05, 0, 'idle');
      warden.root.updateMatrixWorld(true);
      feet[0].push(warden.bones.footL.getWorldPosition(w).clone()); feet[1].push(warden.bones.footR.getWorldPosition(w).clone());
      hips.push(warden.bones.hips.getWorldPosition(w).x);
    }
    expect(Math.max(...hips) - Math.min(...hips)).toBeGreaterThan(0.03);
    for (const f of feet) for (const p of f) expect(p.distanceTo(f[0])).toBeLessThan(0.01);
  });
  it('no bone jumps between frames through idle → walk → look → chase → walk → catch', () => {
    const names = Object.keys(mk().bones), legs = /^(thigh|shin|foot)/;
    type Seg = [number, string, number];
    /** Per frame and bone: d1 = rotation since last frame, d2 = deviation from carrying on at last frame's angular velocity (a pop). */
    /** Per frame and bone: d1 = rotation since last frame, d2 = deviation from carrying on at last frame's angular velocity
     *  (a pop). The hip position reports as '#hip': d2 = change of its per-frame step (m). */
    const run = (script: Seg[], cb: (seg: number, n: string, d1: number, d2: number) => void, phase = 0) => {
      const warden = mk(), hist: THREE.Quaternion[][] = [], hp: THREE.Vector3[] = [];
      (warden.anim as unknown as { t: number }).t = phase;
      for (const [si, [dur, anim, speed]] of script.entries()) for (let i = 0; i < dur * 60; i++) {
        warden.root.position.z -= speed / 60; // world -Z is his front
        warden.update(1 / 60, speed, anim, new THREE.Vector3(1, 1.6, warden.root.position.z - 4));
        hist.push(names.map((n) => warden.bones[n as 'hips'].quaternion.clone()));
        hp.push(warden.bones.hips.position.clone());
        const [a, b, c] = hist.slice(-3), [p0, p1, p2] = hp.slice(-3);
        if (!c) continue;
        names.forEach((n, k) => cb(si, n, ang(c[k], b[k]), ang(c[k], b[k].clone().multiply(a[k].clone().invert().multiply(b[k])))));
        cb(si, '#hip', p2.distanceTo(p1), p2.clone().sub(p1).sub(p1).add(p0).length());
      }
    };
    // the strides themselves swing the legs hard (toe-off): measure each gait's own steady d2 per bone as the reference
    const steady: Record<string, Record<string, number>> = {};
    for (const [anim, speed] of [['patrol', WARDEN_PATROL_SPEED], ['chase', WARDEN_CHASE_SPEED]] as const) {
      const m: Record<string, number> = steady[`${anim} ${speed}`] = {};
      run([[2, anim, speed], [3, anim, speed]], (seg, n, _d1, d2) => { if (seg === 1) m[n] = Math.max(m[n] ?? 0, d2); });
    }
    const script: Seg[] = [[1, 'idle', 0], [3, 'patrol', WARDEN_PATROL_SPEED], [1.2, 'patrol', 0], [0.3, 'patrol', WARDEN_PATROL_SPEED], [3, 'chase', WARDEN_CHASE_SPEED],
      [0.2, 'patrol', WARDEN_PATROL_SPEED], [2, 'patrol', WARDEN_PATROL_SPEED], [1.5, 'catch', 0], [0.4, 'chase', WARDEN_CHASE_SPEED], [2, 'investigate', 0], [2, 'joke', 0], [1, 'patrol', WARDEN_PATROL_SPEED]];
    const ref = (si: number, n: string) => Math.max(...[script[si], script[si - 1]].map((s) => (s && steady[`${s[1]} ${s[2]}`]?.[n]) ?? 0));
    for (const phase of [0, 2.5, 5, 7.5]) {
      let worst = 0, pop = 0, popAt = '';
      run(script, (si, n, d1, d2) => {
        if (n === '#hip') { // the hips don't jump either: no step change past 6 mm / frame beyond the gaits' own bob
          const over = d2 - Math.max(0.006, ref(si, n) + 0.002);
          if (over > pop) { pop = over; popAt = `seg ${si} hip position d2 ${d2.toFixed(4)}`; }
          return;
        }
        if (!legs.test(n) && !/arm|hand|finger/i.test(n)) worst = Math.max(worst, d1); // body / head: < 0.08 rad a frame outright
        // every bone: switching clips adds no pop beyond 0.08 rad, or beyond what the gaits on either side already do
        const over = d2 - Math.max(0.08, ref(si, n) + 0.02);
        if (over > pop) { pop = over; popAt = `seg ${si} ${n} d2 ${d2.toFixed(3)}`; }
      }, phase);
      expect(worst, `initial breathing phase ${phase}s`).toBeLessThan(0.08);
      expect(pop, `initial breathing phase ${phase}s: ${popAt}`).toBe(0);
    }
  });
  it('starts walking after a held gesture without folding down to reach a stale support foot', () => {
    for (const phase of [0, 2.5, 5, 7.5]) {
      const warden = mk();
      (warden.anim as unknown as { t: number }).t = phase;
      for (let i = 0; i < 180; i++) warden.update(1 / 60, 0, 'joke');
      const standing = warden.bones.hips.position.y;
      let lowest = standing;
      for (let i = 0; i < 60; i++) {
        warden.root.position.z -= WARDEN_PATROL_SPEED / 60;
        warden.update(1 / 60, WARDEN_PATROL_SPEED, 'patrol');
        lowest = Math.min(lowest, warden.bones.hips.position.y);
      }
      // Previously a missed first lift left the foot 0.7 m behind him and pulled his pelvis down by 0.35 m.
      expect(standing - lowest, `initial breathing phase ${phase}s`).toBeLessThan(0.12);
    }
  });
  it('carries pelvis motion through the trailing swing after a short restart into chase', () => {
    // A stop, brief restart and chase can put the trailing ankle farther behind the hip than a steady gait.
    // Measure the rendered hip, with fixed breathing phases, rather than using that same gait as its own reference.
    for (const phase of [0, 5]) {
      const warden = mk(), hp: THREE.Vector3[] = [];
      (warden.anim as unknown as { t: number }).t = phase;
      let worst = 0;
      for (const [duration, anim, speed] of [[1, 'idle', 0], [3, 'patrol', WARDEN_PATROL_SPEED], [1.2, 'patrol', 0],
        [0.3, 'patrol', WARDEN_PATROL_SPEED], [1, 'chase', WARDEN_CHASE_SPEED]] as const) for (let i = 0; i < duration * 60; i++) {
        warden.root.position.z -= speed / 60;
        warden.update(1 / 60, speed, anim);
        hp.push(warden.bones.hips.position.clone());
        if (hp.length < 3) continue;
        const [a, b, c] = hp.slice(-3);
        worst = Math.max(worst, c.clone().sub(b).sub(b).add(a).length());
      }
      expect(worst, `initial breathing phase ${phase}s`).toBeLessThan(0.03); // previously 0.0451 m in one frame
    }
  });
  it('leans into the chase from ground speed over ~0.4 s instead of switching clips', () => {
    const warden = mk(), lean: number[] = [];
    for (let i = 0; i < 120; i++) warden.update(1 / 60, 2.0, 'patrol'); // WARDEN_PATROL_SPEED
    expect(warden.anim.lean).toBeCloseTo(0, 3); // patrol walk upright
    const spine0 = ex(warden.bones.spine.quaternion).x;
    for (let i = 0; i < 90; i++) { warden.update(1 / 60, 4.6, 'chase'); lean.push(warden.anim.lean); } // WARDEN_CHASE_SPEED
    const t90 = lean.findIndex((l) => l > 0.9 * lean[89]) / 60;
    expect(t90).toBeGreaterThan(0.3); expect(t90).toBeLessThan(0.5);
    for (let i = 1; i < lean.length; i++) expect(lean[i] - lean[i - 1]).toBeLessThan(0.05);
    expect(lean[89]).toBeGreaterThan(0.95);
    expect(ex(warden.bones.spine.quaternion).x - spine0).toBeGreaterThan(0.2); // hunched over
    for (let i = 0; i < 90; i++) warden.update(1 / 60, 2.0, 'patrol');
    expect(warden.anim.lean).toBeLessThan(0.05); // and back up when he slows
    warden.anim.pose('chase', 0.25); // docs shots keep the hunch
    expect(warden.anim.lean).toBe(1);
  });
  it('a held one-shot (catch) keeps breathing through the arms instead of freezing', () => {
    for (const phase of [0, 2.5, 5, 7.5]) {
      const warden = mk();
      (warden.anim as unknown as { t: number }).t = phase;
      for (let i = 0; i < 60; i++) warden.update(0.05, 0, 'catch'); // clip has clamped at its last frame
      const q0 = ['upperArmL', 'upperArmR', 'foreArmL', 'foreArmR', 'chest'].map((n) => warden.bones[n as 'chest'].quaternion.clone()), d = q0.map(() => 0);
      // The slow forearm drift takes 2π / 1.1 ≈ 5.7 s per cycle. A 3 s window can
      // straddle its quiet half at a random initial phase even though the pose stays alive.
      for (let i = 0; i < 120; i++) { warden.update(0.05, 0, 'catch'); q0.forEach((q, k) => { d[k] = Math.max(d[k], ang(q, warden.bones[(['upperArmL', 'upperArmR', 'foreArmL', 'foreArmR', 'chest'] as const)[k]].quaternion)); }); }
      for (const x of d) expect(x, `initial phase ${phase}s`).toBeGreaterThan(0.03);
    }
  });
  it('sling bag lags when he sets off, swings forward when he stops, then settles', () => {
    const warden = mk(), run = (s: number, v0: number, v1: number) => { const p: number[] = []; for (let i = 0; i < s * 60; i++) {
      const v = v0 + (v1 - v0) * Math.min(1, i / 18); warden.root.position.z -= v / 60; warden.update(1 / 60, 0, 'idle'); p.push(warden.anim.bagPitch);
    } return p; };
    run(1, 0, 0);
    expect(Math.max(...run(0.6, 0, 3))).toBeGreaterThan(0.05); // bottom swings back
    expect(Math.abs(run(3, 3, 3).at(-1)!)).toBeLessThan(0.01);
    expect(Math.min(...run(0.6, 3, 0))).toBeLessThan(-0.05); // and forward
    expect(Math.abs(run(3, 0, 0).at(-1)!)).toBeLessThan(0.01);
  });
  /** Per-frame world ankles + planted flags + locomotion state through `script` ([seconds, anim, speed, yaw rate rad/s]). */
  const drive = (script: [number, string, number, number][], dt = 1 / 60) => {
    const warden = mk(), out: { t: number; seg: number; loco: string; at: THREE.Vector3[]; local: THREE.Vector3[]; planted: boolean[] }[] = [];
    let t = 0;
    for (const [seg, [dur, anim, speed, turn]] of script.entries()) for (let i = 0; i < Math.round(dur / dt); i++) {
      t += dt;
      warden.root.rotation.y += turn * dt;
      warden.root.position.addScaledVector(new THREE.Vector3(-Math.sin(warden.root.rotation.y), 0, -Math.cos(warden.root.rotation.y)), speed * dt); // world -Z is his front at yaw 0
      warden.update(dt, speed, anim, null);
      warden.root.updateMatrixWorld(true);
      const at = [warden.bones.footL, warden.bones.footR].map((b) => b.getWorldPosition(new THREE.Vector3()));
      out.push({ t, seg, loco: warden.anim.loco, at, local: at.map((p) => warden.bones.hips.parent!.worldToLocal(p.clone())), planted: [0, 1].map((k) => warden.anim.planted(k)) });
    }
    return out;
  };
  it('turns on the spot in steps: the support foot holds its spot on the floor, the feet take turns', () => {
    const fr = drive([[1, 'idle', 0, 0], [1.6, 'idle', 0, 2.5], [1.5, 'idle', 0, 0]]); // 4 rad (~230°) at 2.5 rad/s
    const held: (THREE.Vector3 | null)[] = [null, null], steps: number[] = [];
    let worst = 0, turning = 0;
    for (const f of fr.filter((f) => f.seg === 1)) {
      if (f.loco === 'turn') turning++;
      for (const k of [0, 1]) {
        if (!f.planted[k]) { if (held[k]) steps.push(k); held[k] = null; continue; }
        const h = (held[k] ??= f.at[k].clone());
        worst = Math.max(worst, Math.hypot(f.at[k].x - h.x, f.at[k].z - h.z));
      }
    }
    expect(turning).toBeGreaterThan(0.8 * fr.filter((f) => f.seg === 1).length);
    expect(worst).toBeLessThan(0.01); // support foot: < 1 cm on the floor while the other one steps
    expect(steps.length).toBeGreaterThanOrEqual(4); // ~45° a step
    expect(steps.filter((k) => k === 0).length).toBeGreaterThanOrEqual(2); expect(steps.filter((k) => k === 1).length).toBeGreaterThanOrEqual(2);
    expect(fr.every((f) => f.planted[0] || f.planted[1])).toBe(true); // never both feet off the floor
    const end = fr.at(-1)!; // settled: both down under the hips, side by side, facing ahead
    expect(end.loco).toBe('idle');
    for (const [k, x] of [[0, 0.1], [1, -0.1]] as const) { expect(Math.abs(end.local[k].x - x)).toBeLessThan(0.03); expect(Math.abs(end.local[k].z)).toBeLessThan(0.03); }
  });
  it('pulls up from a walk / chase: the foot in the air lands first, then the feet close under him, nothing jumps', () => {
    for (const [anim, speed, stop] of [['patrol', WARDEN_PATROL_SPEED, 'patrol'], ['chase', WARDEN_CHASE_SPEED, 'catch']] as const) {
      const fr = drive([[2, anim, speed, 0], [1.8, stop, 0, 0]]), after = fr.filter((f) => f.seg === 1);
      const states = after.map((f) => f.loco).filter((s, i, a) => s !== a[i - 1]);
      expect(states[0], anim).toBe('move'); // the stride runs out …
      expect(states, anim).toContain('stop'); // … through a stop (catch too) …
      expect(states.at(-1), anim).toBe('idle'); // … to standing
      let jump = 0;
      for (let i = 1; i < after.length; i++) if (after[i].loco !== 'move') for (const k of [0, 1]) jump = Math.max(jump, Math.hypot(after[i].at[k].x - after[i - 1].at[k].x, after[i].at[k].z - after[i - 1].at[k].z));
      expect(jump, anim).toBeLessThan(0.05); // once the stride has run out no foot moves > 5 cm a frame (3 m/s)
      expect(after.every((f) => f.planted[0] || f.planted[1]), anim).toBe(true); // one foot at a time
      const end = after.at(-1)!;
      for (const [k, x] of [[0, 0.1], [1, -0.1]] as const) { expect(Math.abs(end.local[k].x - x), anim).toBeLessThan(0.03); expect(Math.abs(end.local[k].z), anim).toBeLessThan(0.03); }
    }
  });
  it.each([
    ['patrol', 'walk', WARDEN_PATROL_SPEED, 'warden'], ['investigate', 'walk', WARDEN_INVESTIGATE_SPEED, 'warden'],
    ['chase', 'chase', WARDEN_CHASE_SPEED, 'warden'], ['run', 'sprint', SPEED.run, 'warden'], ['run', 'sprint', SPEED.run, 'student'], ['run', 'sprint', MONITOR_SPEED, 'monitor'],
  ] as const)('planted sole holds still through the entire stance: %s / %s @ %s (%s)', (anim, clip, speed, build) => {
    // the lowest point of the sole ellipse (foot frame) is the contact; FK its world velocity while the root moves at speed
    const SOLE = Array.from({ length: 180 }, (_, i) => { const t = (i / 180) * Math.PI * 2; return new THREE.Vector3(0, -0.045 + 0.048 * Math.sin(t), 0.035 + 0.13 * Math.cos(t)); });
    for (const fps of [60, 240]) {
      const w = new Warden(MATS.map(() => new THREE.MeshBasicMaterial()), build === 'warden', build), dt = 1 / fps, M: THREE.Matrix4[][] = [[], []], PH: number[] = [];
      for (let i = 0; i < 6 * fps; i++) {
        w.root.position.z -= speed * dt; w.update(dt, speed, anim, null); w.root.updateMatrixWorld(true);
        PH.push((w.anim as unknown as { phase: number }).phase); M[0].push(w.bones.footL.matrixWorld.clone()); M[1].push(w.bones.footR.matrixWorld.clone());
      }
      const d = GAIT[clip].duty, v = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
      let worst = 0, n = 0; const bins = [0, 0, 0];
      M.forEach((L, k) => { for (let i = 3 * fps; i < L.length - 1; i++) { // steady state (3 s in)
        const u = ((PH[i] + (k ? 0.25 : 0.75)) % 1) / d; if (u < 0 || u > 1) continue;
        bins[u < 0.1 ? 0 : u > 0.9 ? 2 : 1]++;
        const m = L[i].elements;
        const bottom = m[13] - 0.045 * m[5] + 0.035 * m[9] - Math.hypot(0.048 * m[5], 0.13 * m[9]);
        expect(Math.abs(bottom - (0.09 - 0.045 - 0.048) * w.mesh.scale.y)).toBeLessThan(0.001); // no floating / sinking to hide slip
        let lo = 9, lp = SOLE[0]; for (const p of SOLE) { const y = v.copy(p).applyMatrix4(L[i]).y; if (y < lo) { lo = y; lp = p; } }
        a.copy(lp).applyMatrix4(L[i - 1]); b.copy(lp).applyMatrix4(L[i + 1]);
        worst = Math.max(worst, Math.hypot(b.x - a.x, b.z - a.z) / (2 * dt) / speed); n++;
      } });
      expect(n).toBeGreaterThan(20);
      if (fps === 240) for (const count of bins) expect(count).toBeGreaterThan(5); // heel, interior and toe all sampled
      expect(worst, `${anim} ${build} @ ${speed}, ${fps} fps`).toBeLessThan(0.1);
    }
  });
});
