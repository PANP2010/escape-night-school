import { defineConfig } from '@playwright/test';
import { browserArgs } from './tests/browser-args.mjs';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: 'x-revive-network.spec.ts',
  outputDir: 'test-results/revive-network',
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4442',
    headless: true,
    launchOptions: { args: browserArgs(['--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], { softwareGL: '0' }) },
  },
  webServer: {
    command: 'PORT=4442 NODE_ENV=development node dist-server/index.js',
    url: 'http://127.0.0.1:4442/healthz',
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
