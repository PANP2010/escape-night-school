import { defineConfig } from '@playwright/test';
import { browserArgs } from './tests/browser-args.mjs';

// Independent evidence run: never inherit the ordinary gate's 4199 server.
export default defineConfig({
  testDir: 'tests/audit',
  testMatch: ['clock-monotonic.spec.ts', 'clock-lowfps-original.spec.ts'],
  outputDir: 'test-results/clock-monotonic/playwright',
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4461',
    headless: true,
    launchOptions: { args: browserArgs(['--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']) },
  },
  webServer: {
    command: 'NODE_ENV=development PORT=4461 node dist-server/index.js',
    url: 'http://127.0.0.1:4461/healthz',
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
