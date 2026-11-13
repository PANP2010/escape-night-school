import { defineConfig } from '@playwright/test';
import { browserArgs } from './tests/browser-args.mjs';
import { dirname, relative, resolve, sep } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';

// Independent of the release gate: one Chromium process, serial contexts, no audible output.
const port = Number(process.env.ESC_TEST_PORT ?? 4436);
const baseURL = `http://127.0.0.1:${port}`;
const mode = process.env.ESC_FULLFLOW_MODE ?? 'both';
if (!['both', 'desktop', 'mobile'].includes(mode)) throw new Error('Invalid fullflow mode');
const gameRoot = import.meta.dirname;
const evidenceRoot = resolve(gameRoot, 'test-results/sprint-fullflow');
const runDir = resolve(process.env.ESC_FULLFLOW_RUN_DIR ?? `${evidenceRoot}/runs/${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
let existingParent = runDir;
while (!existsSync(existingParent)) existingParent = dirname(existingParent);
const actualRunDir = resolve(realpathSync(existingParent), relative(existingParent, runDir));
if (!actualRunDir.startsWith(resolve(realpathSync(gameRoot), 'test-results/sprint-fullflow') + sep))
  throw new Error('Fullflow evidence must stay inside this worktree test-results');
export default defineConfig({
  testDir: 'tests/e2e-pending', testMatch: 'sprint-fullflow.spec.ts',
  outputDir: `${runDir}/artifacts-${mode}`,
  timeout: 1_200_000, workers: 1, retries: 0,
  reporter: process.env.ESC_FULLFLOW_LIST === '1' ? [['line']] : [['line'], ['json', { outputFile: `${runDir}/results-${mode}.json` }]],
  use: { baseURL, deviceScaleFactor: 1, headless: true,
    launchOptions: { args: browserArgs(['--mute-audio', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']) },
    screenshot: 'only-on-failure', trace: 'off',
  },
  webServer: {
    cwd: gameRoot,
    command: `PORT=${port} HOST=127.0.0.1 NODE_ENV=development CORR_LOG=1 node dist-server/index.js`,
    url: `${baseURL}/healthz`, reuseExistingServer: false, timeout: 20_000,
    stdout: 'pipe', stderr: 'pipe',
  },
});
