import base from './playwright.config.ts';

// Royale zone e2e lane: a throwaway server whose grace/phase timings are shortened (debug builds only, see royaleZoneTiming),
// so a spec can watch the circle shrink without waiting 60 s per phase. The 75 s grace outlasts the clients' load + intro (~35 s
// on swiftshader), so phase 0 is still running when the spec starts steering players. The shipped defaults stay 60 s / 60 s.
const PORT = Number(process.env.ESC_ROYALE_PORT ?? 4198);

export default {
  ...base,
  testMatch: ['**/a2c-royale-elim.spec.ts'],
  outputDir: 'test-results/playwright-royale',
  timeout: 240_000,
  retries: 0,
  use: { ...base.use, baseURL: `http://127.0.0.1:${PORT}` },
  webServer: {
    command: `ESCAPE_ZONE_GRACE_S=75 ESCAPE_ZONE_PHASE_S=20 PORT=${PORT} HOST=127.0.0.1 node dist-server/index.js`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
};
