import { defineConfig } from '@playwright/test';

/** Independent campaign acceptance: one phone page and ordinary /ws teammates. */
export default defineConfig({
  testDir: 'tests/e2e-l7-campaign',
  outputDir: 'test-results/l7-campaign-browser',
  timeout: 180_000,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4441',
    headless: true,
    viewport: { width: 844, height: 390 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
    launchOptions: { args: ['--use-angle=metal', '--mute-audio'] },
  },
  webServer: {
    command: 'PORT=4441 NODE_ENV=development node dist-server/index.js',
    url: 'http://127.0.0.1:4441/healthz',
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
