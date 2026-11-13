import { defineConfig } from '@playwright/test';
import { browserArgs } from './tests/browser-args.mjs';

// A dedicated real-server lane: one Metal browser and no audible host output.
const PORT = 4417;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: 'x-capture-presentation.spec.ts',
  timeout: 180_000,
  workers: 1,
  retries: 0,
  reporter: 'line',
  outputDir: 'test-results/capture-playwright',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 960, height: 540 },
    reducedMotion: 'no-preference',
    launchOptions: {
      args: browserArgs(['--mute-audio', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']),
    },
  },
  webServer: {
    command: `PORT=${PORT} NODE_ENV=development node dist-server/index.js`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
