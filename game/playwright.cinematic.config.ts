import { defineConfig } from '@playwright/test';

// Keep this lane independent of the release suite and its server/browser settings.
const PORT = Number(process.env.ESC_TEST_PORT ?? 4435);

export default defineConfig({
  testDir: 'tests/cinematic',
  outputDir: 'test-results/cinematic-run',
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: 'line',
  use: {
    browserName: 'chromium',
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 720 },
    headless: true,
    launchOptions: {
      args: ['--use-angle=metal', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
    },
  },
  webServer: {
    command: `PORT=${PORT} HOST=127.0.0.1 NODE_ENV=development node dist-server/index.js`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
