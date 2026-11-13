import { defineConfig } from '@playwright/test';
import { browserArgs } from './tests/browser-args.mjs';

export default defineConfig({
  testDir: 'tests/e2e', testMatch: 'x-level-difficulty.spec.ts', timeout: 150_000,
  workers: 1, retries: 0, reporter: 'line', outputDir: 'test-results/level-difficulty-run',
  use: { baseURL: 'http://127.0.0.1:4454', viewport: { width: 1280, height: 720 },
    headless: true, launchOptions: { args: browserArgs(['--mute-audio'], { softwareGL: '0' }) } },
  webServer: { command: 'PORT=4454 NODE_ENV=development node dist-server/index.js',
    url: 'http://127.0.0.1:4454/healthz', reuseExistingServer: false, timeout: 20_000 },
});
