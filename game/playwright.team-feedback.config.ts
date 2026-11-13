import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

const PORT = Number(process.env.ESC_TEST_PORT ?? 4463);
const baseURL = `http://127.0.0.1:${PORT}`;

// An isolated built server and one reusable Chromium process. No defaults from the main webServer survive this override.
export default defineConfig({
  ...base,
  testMatch: ['**/team-feedback.spec.ts', '**/x-hint.spec.ts'],
  outputDir: 'test-results/team-feedback-playwright',
  retries: 0,
  workers: 1,
  use: {
    ...base.use,
    baseURL,
    viewport: { width: 640, height: 360 },
    deviceScaleFactor: 1,
    screenshot: 'only-on-failure',
    video: { mode: 'on', size: { width: 640, height: 360 } },
    launchOptions: { args: ['--use-angle=metal', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] },
  },
  webServer: {
    command: `PORT=${PORT} HOST=127.0.0.1 NODE_ENV=development node dist-server/index.js`,
    url: `${baseURL}/healthz`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
