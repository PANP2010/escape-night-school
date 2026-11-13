// No imports: this factory can also be injected with page.evaluate(createGaitSampler.toString()).
// `sole` must come from the measured source's anim.ts, alongside its exported GAIT.
export function createGaitSampler(gait, sole) {
  const names = ['walk', 'chase', 'sprint'];
  for (const name of names) {
    if (!(gait[name]?.duty > 0 && gait[name].duty < 1) || !(gait[name]?.stride > 0)) throw new Error(`Invalid GAIT.${name}`);
  }
  if (!['y', 'z', 'a', 'b'].every((key) => Number.isFinite(sole[key])) || sole.a <= 0 || sole.b <= 0) throw new Error('Invalid source SOLE');
  const frames = [];
  const wrap = (v) => ((v % 1) + 1) % 1;
  const point = (m, y, z, ground) => [m[4] * y + m[8] * z + m[12] - ground[0], m[6] * y + m[10] * z + m[14] - ground[1]];
  const summary = (values) => {
    const xs = [...values].sort((a, b) => a - b);
    const pick = (fraction) => xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * fraction))] : null;
    return { samples: xs.length, medianMps: pick(0.5), p90Mps: pick(0.9), maxMps: xs.at(-1) ?? null };
  };
  return {
    add(warden, { time, segment, ground = [0, 0] }) {
      if (!Number.isFinite(time) || (frames.length && time <= frames.at(-1).time)) throw new Error('Sample time must increase');
      if (!segment || !ground.every(Number.isFinite)) throw new Error('Invalid segment / ground displacement');
      if (typeof warden.anim.planted !== 'function') throw new Error('Source animator lacks actual planted(i) state');
      warden.root.updateWorldMatrix(true, true);
      // Unscheduled THREE actions retain their default effective weight (1); only mixer-scheduled actions contribute.
      const weights = names.map((name) => warden.anim.actions[name].isScheduled() ? warden.anim.actions[name].getEffectiveWeight() : 0);
      const share = weights.reduce((sum, weight) => sum + weight, 0);
      const duty = share > 0 ? weights.reduce((sum, weight, i) => sum + weight * gait[names[i]].duty, 0) / share : null;
      const dominant = weights.indexOf(Math.max(...weights));
      const phase = wrap(warden.anim.actions[names[dominant]].time);
      const wm = warden.mesh.matrixWorld.elements;
      frames.push({ time, segment, ground: [...ground], phase, duty, gaitShare: share,
        worldScale: [Math.hypot(...wm.slice(0, 3)), Math.hypot(...wm.slice(4, 7)), Math.hypot(...wm.slice(8, 11))],
        feet: ['footL', 'footR'].map((name, i) => {
          const q = wrap(phase + (i ? 0.25 : 0.75)); // same shared cycle offsets as source gait() / feet()
          return { matrix: Array.from(warden.bones[name].matrixWorld.elements), planted: warden.anim.planted(i),
            stance: share <= 0.2 || q < duty, u: share > 0.2 && q < duty ? q / duty : null };
        }) });
    },
    report() {
      const segments = {};
      for (let i = 1; i + 1 < frames.length; i++) {
        const prev = frames[i - 1], f = frames[i], next = frames[i + 1];
        const s = segments[f.segment] ??= { frames: 0, airborneFrames: 0, unplantedFootSamples: 0, phaseFlightFootSamples: 0,
          supportBoundaryExcluded: 0, segmentBoundaryExcluded: 0, oneSidedSamples: 0, full: [], interior: [], edges: [], maxFootStepM: 0,
          gaitDutyMin: null, gaitDutyMax: null, worldScale: f.worldScale };
        s.frames++;
        if (!f.feet.some((foot) => foot.planted)) s.airborneFrames++;
        if (f.duty !== null && f.gaitShare > 0.2) {
          s.gaitDutyMin = Math.min(s.gaitDutyMin ?? f.duty, f.duty); s.gaitDutyMax = Math.max(s.gaitDutyMax ?? f.duty, f.duty);
        }
        for (let k = 0; k < 2; k++) {
          const foot = f.feet[k], a = prev.feet[k], b = next.feet[k];
          const p0 = point(a.matrix, 0, 0, prev.ground), p1 = point(foot.matrix, 0, 0, f.ground);
          if (prev.segment === f.segment) s.maxFootStepM = Math.max(s.maxFootStepM, Math.hypot(p1[0] - p0[0], p1[1] - p0[1]));
          if (!foot.planted) { s.unplantedFootSamples++; continue; }
          if (!foot.stance) { s.phaseFlightFootSamples++; continue; }
          const hasPrev = a.planted && prev.segment === f.segment, hasNext = b.planted && next.segment === f.segment;
          if (!hasPrev && !hasNext) {
            if (!a.planted && !b.planted) s.supportBoundaryExcluded++;
            else s.segmentBoundaryExcluded++;
            continue;
          }
          // Exact lowest point of the production sole ellipse at the centre frame. Transform that SAME material
          // point at t-dt and t+dt; differencing two independently chosen low points would count shoe rolling as slip.
          const theta = Math.atan2(-sole.b * foot.matrix[5], -sole.a * foot.matrix[9]);
          const y = sole.y + sole.b * Math.sin(theta), z = sole.z + sole.a * Math.cos(theta);
          // At support boundaries use an inward one-sided difference; neither endpoint may be airborne. Without
          // this, a 60 fps chase can lose every first/last 10% sample. Report their count so its precision is visible.
          const from = hasPrev ? prev : f, to = hasNext ? next : f;
          if (!hasPrev || !hasNext) s.oneSidedSamples++;
          const left = point(from.feet[k].matrix, y, z, from.ground), right = point(to.feet[k].matrix, y, z, to.ground);
          const slip = Math.hypot(right[0] - left[0], right[1] - left[1]) / (to.time - from.time);
          s.full.push(slip);
          if (foot.u !== null) (foot.u >= 0.1 && foot.u <= 0.9 ? s.interior : s.edges).push(slip);
        }
      }
      return Object.fromEntries(Object.entries(segments).map(([name, s]) => [name, { ...s,
        full: summary(s.full), interior: summary(s.interior), edges: summary(s.edges) }]));
    },
  };
}
