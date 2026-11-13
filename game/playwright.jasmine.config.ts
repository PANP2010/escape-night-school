import { defineConfig } from '@playwright/test';
import { browserArgs } from './tests/browser-args.mjs';

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results/jasmine-playwright',
  testMatch: /x-jasmine(-(range|lifecycle))?\.spec\.(ts|mjs)$/,
  timeout: 180_000, workers: 1, retries: 0, reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4416',
    launchOptions: { args: browserArgs(['--mute-audio']) },
  },
  webServer: {
    command: 'PORT=4416 NODE_ENV=development node dist-server/index.js',
    url: 'http://127.0.0.1:4416/healthz', reuseExistingServer: false, timeout: 20_000,
  },
});
