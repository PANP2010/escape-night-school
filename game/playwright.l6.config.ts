import { defineConfig } from '@playwright/test';

// A single browser process, real Metal rendering, and an explicitly isolated L6 development server.
export default defineConfig({
  testDir: 'tests/e2e-l6',
  outputDir: 'test-results/l6-playwright',
  timeout: 240_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4412',
    viewport: { width: 1280, height: 720 },
    headless: true,
    video: { mode: 'on', size: { width: 1280, height: 720 } },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: { args: ['--use-angle=metal', '--mute-audio'] },
  },
  webServer: {
    command: 'node tests/l6-real-server.mjs',
    url: 'http://127.0.0.1:4412/healthz',
    reuseExistingServer: false,
    timeout: 30_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  },
});
