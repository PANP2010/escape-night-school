import base from './playwright.config.ts';

// acceptance specs not yet passing (kept out of `npm run check`): npx playwright test -c playwright.pending.config.ts
export default { ...base, testDir: 'tests/e2e-pending', retries: 0 };
