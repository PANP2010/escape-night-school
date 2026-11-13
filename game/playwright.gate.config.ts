import base from './playwright.config.ts';
import { gateStorageState } from './tests/gate-settings.ts';

// The e2e subset run by `npm run check`. The full suite (66 specs / 127 tests) was written on an Apple M4 GPU; on the
// 4-core swiftshader box it takes 2 h+, longer than loop.sh's `timeout 2700`. `npm run e2e` still runs everything.
// Every spec below passed alone on this box; `vitest run` alone is ~13 min here, so the whole check has to stay under
// ~35 min. Left out: x-bounds (passes, 5 min), x-multi (passes alone, failed 3/3 inside a gate run), x-lobby, x-battery,
// x-revive-network (fail here), x-ui-shots (skips without UI_TAG). Per-spec timings: loop/state/NEXT.md「闸门基线」. Add a spec back only
// once it passes here; never loosen an assertion to get it in.
const GATE_SPECS = [
  'smoke',
  'x-campus-walk',
  'x-debug',
  'x-down',
  'lobby-reconnect',
  'x-interact',
  'x-hide',
  'x-mob-sync',
  'x-touch',
  'x-progression',
  'a2c-royale-elim',
];

export default {
  ...base,
  use: {
    ...base.use,
    storageState: gateStorageState(base.use!.baseURL!),
  },
  testMatch: GATE_SPECS.map((s) => `**/${s}.spec.ts`),
  // The royale zone spec observes real phase changes on its isolated debug server.
  webServer: {
    ...base.webServer,
    command: `ESCAPE_ZONE_GRACE_S=75 ESCAPE_ZONE_PHASE_S=20 PORT=${new URL(base.use!.baseURL!).port} node dist-server/index.js`,
  },
};
