import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { browserArgs } from '../browser-args.mjs';

const baseURL = 'http://127.0.0.1:4423';
export default defineConfig({
  testDir: '.',
  testMatch: 'metal-memory.spec.ts',
  outputDir: '../../test-results/metal-audit/playwright',
  timeout: 900_000,
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL,
    headless: true,
    launchOptions: { args: browserArgs(['--mute-audio', '--enable-precise-memory-info', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--js-flags=--expose-gc']) },
  },
  webServer: {
    command: 'PORT=4423 HOST=127.0.0.1 NODE_ENV=development node dist-server/index.js',
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    url: `${baseURL}/healthz`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
