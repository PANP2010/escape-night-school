// Invoke through: parallel_sprint.py gate heavy -- node tests/visual-atmosphere/verify-build.mjs
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const dir = 'test-results/visual-atmosphere-checks';
mkdirSync(dir, { recursive: true });
const steps = [
  // Implementation agents run typecheck and the 21 relevant tests separately through the heavy gate.
  ['build', 'npm', ['run', 'build']],
];
const evidence = { at: new Date().toISOString(), steps: [] };
for (const [name, executable, args] of steps) {
  const from = Date.now(), result = spawnSync(executable, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ?? ''}`;
  writeFileSync(`${dir}/${name}.log`, output);
  const step = { name, command: [executable, ...args], rc: result.status, elapsedMs: Date.now() - from };
  evidence.steps.push(step); console.log(JSON.stringify(step));
  writeFileSync(`${dir}/results.json`, JSON.stringify(evidence, null, 2));
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
}
