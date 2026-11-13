import { defineConfig } from '@playwright/test';

const PORT = 4414;

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results/l8-artifacts',
  testMatch: 'l8-finale.spec.ts',
  timeout: 120_000,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 960, height: 640 },
    headless: true,
    launchOptions: { args: ['--use-angle=metal', '--mute-audio'] },
  },
  webServer: {
    command: `PORT=${PORT} NODE_ENV=development node dist-server/index.js`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
