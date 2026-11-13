// Browser-free FK evidence. Node >=22; dependency tree is read only.
// node tests/probe-warden-gait.mjs --source-root /path/to/tree --expected-commit COMMIT [--fps 60] [--out report.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createGaitSampler } from './warden-gait-sampler.mjs';

export async function loadGaitSource(sourceRoot, expectedCommit) {
  const root = resolve(sourceRoot);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  const commit = git('rev-parse', 'HEAD');
  if (expectedCommit && git('rev-parse', `${expectedCommit}^{commit}`) !== commit) throw new Error(`Source HEAD mismatch: expected ${expectedCommit}, got ${commit}`);
  const files = ['game/client/src/warden/anim.ts', 'game/client/src/warden/model.ts', 'game/client/src/warden/textures.ts',
    'game/shared/constants.ts', 'game/server/ai/warden.ts', 'game/server/ai/monitor.ts'];
  const hashes = () => Object.fromEntries(files.map((file) => [file, createHash('sha256').update(readFileSync(join(root, file))).digest('hex')]));
  const before = hashes(), dirty = git('status', '--porcelain', '--untracked-files=no').split('\n').filter(Boolean);
  const text = readFileSync(join(root, files[0]), 'utf8');
  const soleLiteral = text.match(/const SOLE\s*=\s*\{([^}]+)\}/)?.[1];
  if (!soleLiteral) throw new Error('Source SOLE definition not recognized');
  const sole = Object.fromEntries(soleLiteral.split(',').filter((part) => part.trim()).map((part) => {
    const match = part.trim().match(/^(y|z|a|b)\s*:\s*(-?\d+(?:\.\d+)?)$/);
    if (!match) throw new Error(`Source SOLE field not recognized: ${part}`);
    return [match[1], Number(match[2])];
  }));
  // Fail loudly if gait foot offsets change: the sampler must keep the production phase mapping.
  if (!text.includes("['L', 1, (p + 0.75) % 1]") || !text.includes("['R', -1, (p + 0.25) % 1]")) throw new Error('Source leg phase mapping changed');
  const [model, animation, constants, wardenAI, monitorAI, THREE] = await Promise.all([
    ...[files[1], files[0], files[3], files[4], files[5], 'game/node_modules/three/build/three.module.js'].map((file) => import(pathToFileURL(join(root, file)).href)),
  ]);
  const verify = () => {
    if (git('rev-parse', 'HEAD') !== commit || JSON.stringify(hashes()) !== JSON.stringify(before)) throw new Error('Measured source changed during sampling');
  };
  verify();
  return { root, model, animation, constants, wardenAI, monitorAI, THREE, sole, verify,
    provenance: { root, commit, expectedCommit: expectedCommit ?? null, dirty, sha256: before } };
}

export async function probeWardenGait({ sourceRoot, expectedCommit, fps = 60 }) {
  if (!(fps >= 24 && fps <= 240)) throw new Error('fps must be between 24 and 240');
  const source = await loadGaitSource(sourceRoot, expectedCommit);
  const { model, animation, constants, wardenAI, THREE, sole } = source;
  const dt = 1 / fps;
  const makeRig = (build) => {
    const oldRandom = Math.random;
    // A stream keeps THREE UUIDs distinct. A constant random value aliases every AnimationClip in its mixer.
    let seed = 188;
    try {
      Math.random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
      return new model.Warden(model.MATS.map(() => new THREE.MeshBasicMaterial()), build === 'warden', build);
    }
    finally { Math.random = oldRandom; }
  };
  const dispose = (w) => { w.mesh.geometry.dispose(); w.mesh.material.forEach((m) => m.dispose()); w.anim.mixer.stopAllAction(); w.anim.mixer.uncacheRoot(w.root); };
  const cases = [
    ['walk', 'patrol', wardenAI.WARDEN_PATROL_SPEED, 'warden'], ['investigate', 'investigate', wardenAI.WARDEN_INVESTIGATE_SPEED, 'warden'],
    ['chase', 'chase', wardenAI.WARDEN_CHASE_SPEED, 'warden'], ['sprint', 'run', constants.SPEED.run, 'warden'],
  ];
  const steady = {};
  for (const [name, anim, speed, build] of cases) {
    const w = makeRig(build), sampler = createGaitSampler(animation.GAIT, sole);
    try {
      for (let i = 0; i <= 8 * fps; i++) {
        w.root.position.z -= speed * dt; w.update(dt, speed, anim, null);
        if (i >= 3 * fps) sampler.add(w, { time: i * dt, segment: name });
      }
      steady[name] = { anim, speedMps: speed, build, ...sampler.report()[name] };
    } finally { dispose(w); }
  }
  const w = makeRig('warden'), sampler = createGaitSampler(animation.GAIT, sole), states = [];
  const smooth = (a, b, t) => { const k = Math.max(0, Math.min(1, (t - a) / (b - a))); return k * k * (3 - 2 * k); };
  try {
    for (let i = 0; i <= 20 * fps; i++) {
      const t = (i + 1) * dt;
      let speed = 0, anim = 'patrol', segment = 'idle';
      if (t >= 3 && t < 8) { speed = wardenAI.WARDEN_PATROL_SPEED; segment = t < 4 ? 'start' : 'walk'; }
      else if (t >= 8 && t < 10) { speed = wardenAI.WARDEN_PATROL_SPEED; segment = 'turn'; w.root.rotation.y = Math.PI * smooth(8, 10, t); }
      else if (t >= 10 && t < 14.5) { speed = wardenAI.WARDEN_CHASE_SPEED; anim = 'chase'; segment = 'chase'; }
      else if (t >= 14.5 && t < 16.5) { anim = 'catch'; segment = 'stop'; }
      else if (t >= 16.5) { segment = 'spin'; w.root.rotation.y = Math.PI * (1 + smooth(16.6, 17.6, t)); }
      w.root.position.x -= Math.sin(w.root.rotation.y) * speed * dt;
      w.root.position.z -= Math.cos(w.root.rotation.y) * speed * dt;
      w.update(dt, speed, anim, null); sampler.add(w, { time: t, segment });
      if (states.at(-1)?.state !== w.anim.loco) states.push({ time: t, state: w.anim.loco });
    }
  } finally { dispose(w); }
  source.verify();
  return { schema: 1, source: source.provenance, fps, dt, gait: animation.GAIT, sole,
    method: { support: 'actual planted(i) at centre and every derivative endpoint; moving centre frame must also be inside actual weighted GAIT duty',
      contact: 'same material point of source SOLE ellipse across derivative endpoints; lowest point chosen at centre; world matrices include mesh/root scale',
      derivative: 'central difference when both neighbours are planted in the same segment; inward one-sided at support/segment boundaries (oneSidedSamples); isolated support excluded',
      interior: 'stance u in [0.1,0.9]', edges: 'stance u in [0,0.1) or (0.9,1); full includes both; finite frame samples, no subframe inference',
      limit: 'FK diagnostic with basic materials; no renderer, networking, video, audio, or external quality score' },
    steady, transitions: sampler.report(), states };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const allowed = new Set(['source-root', 'expected-commit', 'fps', 'out']);
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i].replace(/^--/, '');
    if (!allowed.has(key) || !process.argv[i + 1]) throw new Error(`Unknown / missing option: ${process.argv[i]}`);
    options[key] = process.argv[i + 1];
  }
  if (!options['source-root'] || !options['expected-commit']) throw new Error('--source-root and --expected-commit are required');
  const report = await probeWardenGait({ sourceRoot: options['source-root'], expectedCommit: options['expected-commit'], fps: Number(options.fps ?? 60) });
  const json = JSON.stringify(report, null, 2) + '\n';
  if (options.out) writeFileSync(resolve(options.out), json);
  else process.stdout.write(json);
}
