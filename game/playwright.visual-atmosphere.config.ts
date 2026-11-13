import { defineConfig } from '@playwright/test';
import { browserArgs } from './tests/browser-args.mjs';

const baseline = process.env.ESC_VISUAL_PHASE === 'baseline';

// One Chromium session, real ANGLE Metal. Run only through the sprint browser gate.
export default defineConfig({
  testDir: 'tests/visual-atmosphere', workers: 1, retries: 0, timeout: 360_000,
  reporter: 'line', outputDir: 'test-results/visual-atmosphere-run',
  use: { baseURL: 'http://127.0.0.1:4451', launchOptions: { args: browserArgs([
    '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--disable-gpu-compositing',
  ], { softwareGL: '0' }) } },
  webServer: { command: baseline
    ? 'PORT=4451 NODE_ENV=development DIST=test-results/baseline-server/dist NAV_CACHE=test-results/baseline-server/.cache/campus-nav.json node test-results/baseline-server/dist-server/index.js'
    : 'PORT=4451 NODE_ENV=development node dist-server/index.js',
    url: 'http://127.0.0.1:4451/healthz', reuseExistingServer: false, timeout: 20_000 },
});
