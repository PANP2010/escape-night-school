// Keep one browser resource reservation across sequential CLI runs. Each CLI closes its own session/server.
// Invoke only through: parallel_sprint.py gate browser -- node tests/visual-atmosphere/run-comparison.mjs
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const dir = 'test-results/baseline-server';
const snapshot = JSON.parse(readFileSync(`${dir}/baseline.json`, 'utf8'));
for (const [file, expected] of Object.entries(snapshot.files)) {
  const actual = createHash('sha256').update(readFileSync(`${dir}/${file}`)).digest('hex');
  if (actual !== expected) throw new Error(`Baseline snapshot changed: ${file}`);
}
const checks = JSON.parse(readFileSync('test-results/visual-atmosphere-checks/results.json', 'utf8'));
if (!checks.steps.some((s) => s.name === 'build' && s.rc === 0)) throw new Error('After build must finish before the browser reservation.');
if (readFileSync('dist/index.html', 'utf8') === snapshot.indexHtml) throw new Error('After client must differ from the frozen baseline client.');
const runs = [];
for (const [phase, spec] of [
  ['baseline', 'x-visual-atmosphere.spec.ts'], ['after', 'x-visual-atmosphere.spec.ts'],
  ['after', 'x-bounds-single-session.spec.ts'],
]) {
  const started = Date.now();
  const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '-c', 'playwright.visual-atmosphere.config.ts', spec],
    { env: { ...process.env, ESC_VISUAL_PHASE: phase }, stdio: 'inherit' });
  runs.push({ phase, spec, rc: result.status, elapsedMs: Date.now() - started });
  writeFileSync('test-results/visual-atmosphere-comparison-runs.json', JSON.stringify(runs, null, 2));
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}
