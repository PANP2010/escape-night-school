import { defineConfig } from '@playwright/test';
import { browserArgs } from './tests/browser-args.mjs';
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: { baseURL: 'http://127.0.0.1:4382', viewport: { width: 844, height: 390 }, launchOptions: { args: browserArgs() } },
  webServer: {
    command: 'PORT=4382 node dist-server/index.js',
    url: 'http://127.0.0.1:4382/healthz', reuseExistingServer: false, timeout: 20_000,
  },
});
