import { defineConfig } from '@playwright/test';

/** Focused narrative verification: one worker reuses one muted Metal browser on the reserved port. */
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: 'x-story.spec.ts',
  outputDir: 'test-results/narrative-playwright',
  metadata: { narrativeMetal: true },
  timeout: 240_000,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4415',
    headless: true,
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 720 },
    launchOptions: { args: ['--use-angle=metal', '--mute-audio'] },
  },
  webServer: {
    command: 'PORT=4415 NODE_ENV=development node dist-server/index.js',
    url: 'http://127.0.0.1:4415/healthz',
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
