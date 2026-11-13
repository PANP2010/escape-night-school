// Extract a compact, reproducible arrival/playback fixture without inferring
// delivery from rAF timestamps (a callback may run much later than its timestamp).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const source = process.argv[2] ?? 'test-results/clock-monotonic/two-ws-raw.json';
const destination = process.argv[3] ?? 'tests/fixtures/metal-backlog-playback.json';
const bytes = readFileSync(source), raw = JSON.parse(bytes);
const capture = raw.observer;
let start = -1, burstCount = 0;
for (let i = 0; i < capture.arrivals.length; i++) {
  const a = capture.arrivals[i];
  if (a.now < capture.stallEnd) continue;
  let end = i + 1;
  while (end < capture.arrivals.length && capture.arrivals[end].now <= a.now + 50) end++;
  if (end - i > burstCount) { start = i; burstCount = end - i; }
}
assert(start >= 0);
assert.match(raw.summary.renderer, /Metal/);
const first = capture.arrivals[start], arrivals = capture.arrivals.slice(start).map(a => {
  const player = a.players.find(p => p.id === raw.senderId);
  assert(player);
  return [a.now - first.now, a.tick - first.tick, ...player.p];
});
// Counts record callback execution order, including arrivals handled before a
// frame whose rAF timestamp predates those arrivals' performance.now() values.
const frames = capture.frames.filter(f => f.arrivalCount > start).map(f => {
  assert(Number.isInteger(f.arrivalCount));
  return [f.t - first.now, f.arrivalCount - start];
});
assert(frames.length > 12);
assert(burstCount >= 22);
const metadata = {
  description: 'Exact receive times, authoritative positions, rAF cadence and consumed arrival counts from two rendered WebSocket clients in a muted headless Metal browser, starting at its largest post-stall 50 ms backlog. Replayed with a fresh SnapClock to model initial join/load. Counts preserve actual callback order; all arrivals and frames after that starting point are retained.',
  source, sourceCommit: raw.sourceCommit,
  sourceSha256: createHash('sha256').update(bytes).digest('hex'),
  renderer: raw.summary.renderer, sourceTickOrigin: first.tick,
  burstCount,
};
const rows = values => values.map(row => `    ${JSON.stringify(row)}`).join(',\n');
writeFileSync(destination, JSON.stringify(metadata, null, 2).slice(0, -2)
  + `,\n  "arrivals": [\n${rows(arrivals)}\n  ],\n  "frames": [\n${rows(frames)}\n  ]\n}\n`);
console.log(JSON.stringify({ destination, burstCount, arrivals: arrivals.length, frames: frames.length }));
