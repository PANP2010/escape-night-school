import { defineConfig } from '@playwright/test';
import { browserArgs } from './tests/browser-args.mjs';

// This suite imports the audio module through Vite without starting the game or WebGL.
export default defineConfig({
  testDir: 'tests/spatial-audio',
  timeout: 60_000,
  workers: 1,
  retries: 0,
  outputDir: 'test-results/spatial-audio-artifacts',
  reporter: [
    ['line'],
    ['json', { outputFile: 'test-results/spatial-audio/playwright.json' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:4453',
    headless: true,
    launchOptions: { args: browserArgs(['--mute-audio']) },
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --config vite.spatial.config.ts --configLoader runner',
    url: 'http://127.0.0.1:4453/@vite/client',
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
