import { defineConfig } from '@playwright/test';

// Keep this focused run independent of the release gate and its server/port.
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: 'x-teamlight-direction.spec.ts',
  timeout: 240_000,
  workers: 1,
  retries: 0,
  reporter: 'line',
  outputDir: 'test-results/teamlight-playwright',
  use: {
    browserName: 'chromium',
    headless: true,
    baseURL: 'http://127.0.0.1:4432',
    launchOptions: { args: [
      '--use-angle=metal', '--mute-audio', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    ] },
  },
  webServer: {
    command: 'NODE_ENV=development PORT=4432 node dist-server/index.js',
    url: 'http://127.0.0.1:4432/healthz',
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
