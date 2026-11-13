import base from './playwright.config.ts';
import { browserArgs } from './tests/browser-args.mjs';

// This worktree's HUD acceptance server is isolated from the normal Playwright port.
const PORT = 4420;

export default {
  ...base,
  testMatch: 'x-guide.spec.ts',
  outputDir: 'test-results/guide-artifacts',
  retries: 0,
  use: {
    ...base.use,
    baseURL: `http://127.0.0.1:${PORT}`,
    launchOptions: { ...base.use?.launchOptions, args: browserArgs(['--mute-audio']) },
  },
  webServer: {
    ...base.webServer,
    command: `PORT=${PORT} node dist-server/index.js`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
  },
};
