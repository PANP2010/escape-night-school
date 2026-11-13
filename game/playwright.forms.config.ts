import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';

const PORT = 4447;
const rollcall = process.env.WARDEN_FORMS_PREVIEW === 'rollcall';

export default defineConfig({
  ...base,
  testDir: rollcall ? 'tests/e2e-forms' : base.testDir,
  testMatch: rollcall ? '**/rollcall.spec.ts' : '**/x-warden-forms.spec.ts',
  outputDir: 'test-results/warden-forms',
  workers: 1,
  retries: 0,
  timeout: rollcall ? 150_000 : 120_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 960, height: 540 },
    headless: true,
    launchOptions: { args: ['--use-angle=metal', '--mute-audio'] },
    trace: 'retain-on-failure',
    video: { mode: 'on', size: { width: 960, height: 540 } },
  },
  webServer: {
    command: `PORT=${PORT} NODE_ENV=development node dist-server/index.js${rollcall ? ' --l4-preview' : ''}`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
