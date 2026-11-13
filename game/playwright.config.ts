import { defineConfig } from '@playwright/test';
import { browserArgs } from './tests/browser-args.mjs';

const PORT = Number(process.env.ESC_TEST_PORT ?? 4199); // isolated release worktrees can use their own port

export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results/playwright-artifacts',
  timeout: 90_000,
  workers: 1, // tried 2-3 (iter-110): swiftshader is CPU-bound on 4 cores, timing tests flake and gain is <1 min
  retries: 1, // swiftshader headless occasionally crashes the page (zygote reset); a real failure still fails twice
  reporter: 'line',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 640, height: 400 },
    launchOptions: { args: browserArgs(['--mute-audio']) },
  },
  webServer: {
    command: `PORT=${PORT} node dist-server/index.js`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
