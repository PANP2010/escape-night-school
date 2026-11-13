import { defineConfig } from '@playwright/test';
import { browserArgs } from './tests/browser-args.mjs';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: ['x-teaching-clarity.spec.ts', 'x-team-activity.spec.ts'],
  outputDir: 'test-results/teaching-artifacts',
  timeout: 120_000,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4464',
    viewport: { width: 1280, height: 720 },
    launchOptions: { args: browserArgs(['--mute-audio']) },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'PORT=4464 node dist-server/index.js',
    url: 'http://127.0.0.1:4464/healthz',
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
