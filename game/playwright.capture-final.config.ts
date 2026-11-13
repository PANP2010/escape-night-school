import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';
import { browserArgs } from './tests/browser-args.mjs';

const PORT = Number(process.env.ESC_TEST_PORT ?? 4473);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  ...base,
  testMatch: ['**/team-feedback.spec.ts', '**/x-capture-presentation.spec.ts', '**/x-down.spec.ts',
    '**/x-hint.spec.ts', '**/x-revive-network.spec.ts', '**/x-feedback.spec.ts', '**/x-tutorial-ping.spec.ts', '**/chat-modal.spec.ts'],
  outputDir: 'test-results/capture-final',
  retries: 0,
  workers: 1,
  use: {
    ...base.use,
    baseURL,
    screenshot: 'only-on-failure',
    launchOptions: { args: browserArgs(['--mute-audio', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']) },
  },
  webServer: {
    command: `PORT=${PORT} HOST=127.0.0.1 NODE_ENV=development node dist-server/index.js`,
    url: `${baseURL}/healthz`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
