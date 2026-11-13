import { defineConfig } from '@playwright/test';
import { browserArgs } from './tests/browser-args.mjs';

const PORT = 4433;

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results/settings-playwright',
  testMatch: /x-(settings|feedback)\.spec\.ts/,
  grep: /desktop settings|safe-area controls|settings support native keyboard/,
  timeout: 150_000,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    // Use a real macOS window to verify native pointer capture.
    headless: process.platform !== 'darwin',
    launchOptions: { args: browserArgs(['--mute-audio', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']) },
  },
  webServer: {
    command: `PORT=${PORT} NODE_ENV=development node dist-server/index.js`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
