import { defineConfig } from '@playwright/test';

// This sprint owns one browser and one build server, separate from the normal gate.
const baseURL = 'http://127.0.0.1:4446';
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: 'x-tutorial-ping.spec.ts',
  outputDir: 'test-results/tutorial-ping/runner',
  timeout: 180_000,
  workers: 1,
  retries: 0,
  reporter: 'line',
  metadata: { tutorialEvidence: true },
  use: {
    baseURL,
    headless: true,
    launchOptions: { args: ['--use-angle=metal', '--mute-audio'] },
  },
  webServer: {
    command: 'PORT=4446 NODE_ENV=development node dist-server/index.js',
    url: `${baseURL}/healthz`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
