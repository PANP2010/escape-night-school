import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';
import { browserArgs } from './tests/browser-args.mjs';

export default defineConfig(base, {
  testMatch: '**/x-voice.spec.ts',
  workers: 1,
  retries: 0,
  outputDir: 'test-results/voice-existing',
  use: {
    baseURL: 'http://127.0.0.1:4443',
    launchOptions: { args: browserArgs(['--mute-audio']) },
  },
  webServer: {
    command: 'PORT=4443 node dist-server/index.js',
    url: 'http://127.0.0.1:4443/healthz',
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
