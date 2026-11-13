import { defineConfig } from '@playwright/test';
import { browserArgs } from './tests/browser-args.mjs';

// Independent worktree acceptance: never inherit a default-port webServer or an environment baseURL.
const PORT = 4419;
export default defineConfig({
  testDir: 'tests/e2e-reconnect',
  testMatch: 'reconnect.spec.ts',
  timeout: 180_000,
  workers: 1,
  retries: 0,
  reporter: 'line',
  outputDir: 'test-results/reconnect-playwright',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 960, height: 540 },
    deviceScaleFactor: 1,
    headless: true,
    trace: 'off', // traces can contain the private resume handshake
    launchOptions: { args: browserArgs(['--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'], { softwareGL: '0' }) },
  },
  webServer: {
    command: `PORT=${PORT} HOST=127.0.0.1 NODE_ENV=development node dist-server/index.js`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
