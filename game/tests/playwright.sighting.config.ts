import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// Standalone: defineConfig(base, overrides) concatenates webServer entries instead of replacing the base server.
export default defineConfig({
  testDir: './sighting-e2e',
  outputDir: '../test-results/sighting-browser-artifacts',
  timeout: 90_000,
  retries: 0,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4462',
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    headless: true,
    launchOptions: { args: ['--use-angle=metal', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] },
  },
  webServer: {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    command: 'PORT=4462 NODE_ENV=development node dist-server/index.js',
    url: 'http://127.0.0.1:4462/healthz',
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
