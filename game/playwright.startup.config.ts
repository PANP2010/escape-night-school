import { defineConfig } from '@playwright/test';
import config from './playwright.config.ts';
import { browserArgs } from './tests/browser-args.mjs';

export default defineConfig({
  ...config,
  testMatch: /x-startup\.spec\.ts$/,
  retries: 0,
  outputDir: 'test-results/startup',
  use: {
    ...config.use,
    baseURL: 'http://127.0.0.1:4449',
    viewport: { width: 960, height: 540 },
    launchOptions: { args: browserArgs(['--mute-audio']) },
  },
  webServer: {
    command: 'NODE_ENV=development PORT=4449 node dist-server/index.js',
    url: 'http://127.0.0.1:4449/healthz',
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
