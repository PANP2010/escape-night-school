import { defineConfig } from '@playwright/test';
import config from './playwright.config.ts';
import { browserArgs } from './tests/browser-args.mjs';

const serverEnvironment = process.env.ESC_SCREEN_SERVER_ENV === 'production' ? 'production' : 'development';

export default defineConfig(config, {
  workers: 1,
  retries: 0,
  outputDir: `test-results/screen-harness-${serverEnvironment}`,
  use: { baseURL: 'http://127.0.0.1:4445', headless: true, launchOptions: { args: browserArgs(['--mute-audio']) } },
  webServer: {
    command: `PORT=4445 NODE_ENV=${serverEnvironment} node dist-server/index.js`,
    url: 'http://127.0.0.1:4445/healthz',
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
