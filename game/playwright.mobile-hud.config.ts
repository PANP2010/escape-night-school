import base from './playwright.config.ts';

export default {
  ...base,
  testMatch: 'x-map-layout.spec.ts',
  retries: 0,
  timeout: 180_000,
  outputDir: 'test-results/mobile-hud-run',
  use: {
    ...base.use,
    baseURL: 'http://127.0.0.1:4418',
    launchOptions: { args: ['--use-angle=metal', '--mute-audio'] },
  },
  webServer: {
    command: 'PORT=4418 NODE_ENV=development node dist-server/index.js',
    url: 'http://127.0.0.1:4418/healthz',
    reuseExistingServer: false,
    timeout: 20_000,
  },
};
