import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';
import { browserArgs } from './tests/browser-args.mjs';

// Isolated verification only. Keep the existing low-fps spec and its assertions intact.
export default defineConfig({
  ...base,
  testDir: 'tests/e2e-motion',
  retries: 0,
  workers: 1,
  outputDir: 'test-results/motion-lowfps',
  use: {
    ...base.use,
    baseURL: 'http://127.0.0.1:4452',
    launchOptions: { args: browserArgs(['--mute-audio']) },
  },
  webServer: {
    command: 'PORT=4452 HOST=127.0.0.1 NODE_ENV=development node dist-server/index.js',
    url: 'http://127.0.0.1:4452/healthz',
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
