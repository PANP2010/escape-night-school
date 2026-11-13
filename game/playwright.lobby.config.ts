import { defineConfig } from '@playwright/test';

// A separate lane keeps the existing release config and its port unchanged.
const PORT = 4431;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: 'public-lobby.spec.ts',
  outputDir: 'test-results/playwright-lobby',
  timeout: 240_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    browserName: 'chromium',
    headless: true,
    baseURL: `http://127.0.0.1:${PORT}`,
    launchOptions: { args: ['--use-angle=metal', '--mute-audio'] },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `PORT=${PORT} HOST=127.0.0.1 node dist-server/index.js`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
