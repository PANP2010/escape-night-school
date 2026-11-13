// Standalone source-level reproduction, intentionally outside the default test gates.
// Run from game/: python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- node tests/audit/repro-snapclock.mjs
// Exit 1 means the timestamp-monotonicity defect reproduced; this is not a passing test.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { SnapClock } from '../../client/src/interp.ts';

const tickMs = 50;
const receivedAtMs = 2000;
const clock = new SnapClock(tickMs);
const trace = [];
const failures = [];
let previousStampMs = null;

for (let tick = 0; tick <= 21; tick++) {
  const stampMs = clock.stamp(tick, receivedAtMs);
  const deltaMs = previousStampMs === null ? null : stampMs - previousStampMs;
  const row = { tick, receivedAtMs, stampMs, previousStampMs, deltaMs };
  trace.push(row);
  if (previousStampMs !== null) {
    try {
      assert.ok(stampMs > previousStampMs,
        `tick ${tick}: timestamp must increase, got ${stampMs} after ${previousStampMs} (${deltaMs} ms)`);
    } catch (error) {
      failures.push({ tick, message: error.message });
    }
  }
  previousStampMs = stampMs;
}

const result = {
  description: 'SnapClock initial arrival batch: 22 consecutive 50 ms ticks received at the same local time',
  productSource: 'client/src/interp.ts',
  tickMs,
  receivedAtMs,
  snapshotCount: trace.length,
  minimumTimestampStepMs: Math.min(...trace.slice(1).map((row) => row.deltaMs)),
  reproduced: failures.length > 0,
  failures,
  trace,
};
const output = new URL('../../test-results/metal-audit/snapclock-repro.json', import.meta.url);
mkdirSync(new URL('.', output), { recursive: true });
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (failures.length > 0) {
  console.error('REPRODUCED: SnapClock timestamps went backwards; exit 1 is expected until the product defect is fixed.');
  process.exitCode = 1;
} else {
  console.log('NOT REPRODUCED: all timestamps strictly increased.');
}
