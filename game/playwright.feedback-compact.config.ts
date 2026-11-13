import { defineConfig } from '@playwright/test';
import { browserArgs } from './tests/browser-args.mjs';

const port = Number(process.env.ESC_TEST_PORT ?? 4391);
export default defineConfig({
  testDir: 'tests/e2e', testMatch: 'x-feedback-compact.spec.ts',
  outputDir: 'test-results/feedback-compact/artifacts',
  timeout: 120_000, workers: 1, retries: 0, reporter: 'line',
  use: {
    baseURL: `http://127.0.0.1:${port}`, deviceScaleFactor: 1,
    launchOptions: { args: browserArgs(['--mute-audio', '--renderer-process-limit=1']) },
  },
  webServer: {
    command: `PORT=${port} node dist-server/index.js --l4-preview`,
    url: `http://127.0.0.1:${port}/healthz`, reuseExistingServer: false, timeout: 20_000,
  },
});
