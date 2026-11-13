import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.ESC_TEST_PORT ?? 4386);

export default defineConfig({
  testDir: 'tests/e2e-l5',
  outputDir: 'test-results/l5-browser',
  timeout: 120_000,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    headless: true,
    viewport: { width: 844, height: 390 },
    launchOptions: { args: ['--use-angle=metal', '--mute-audio'] },
  },
  // Tests exercise the real built server and enter L5 through its host debug action.
  webServer: {
    command: `PORT=${PORT} NODE_ENV=development node dist-server/index.js`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
