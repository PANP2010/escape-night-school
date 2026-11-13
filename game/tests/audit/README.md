# Metal lifecycle audit

Run from `game/`, after a build through the heavy gate:

```sh
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npm run build
python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- node node_modules/@playwright/test/cli.js test -c tests/audit/playwright.metal.config.ts
```

The config owns the development server on 4423 and a single muted Chromium Metal session. The stability phase renders two isolated client contexts for two minutes; the later four-player phase uses one rendered page plus three Node WS peers. Desktop 1280×720 and touch 844×390 fixture captures use sequential contexts.

`test-results/metal-audit/results.json` contains the GPU identity, real server wipe events, forced-GC CDP heap, renderer geometry/texture/program counts and AudioContext/master-gain state after a trusted gesture. Both stability phases sample every 20 seconds for two minutes. The two-page phase records the sum of RSS for browser-owned PIDs reported by CDP; this sum includes shared pages and is not unique system memory. The low-fps phase calibrates 100×/200×/400× CPU throttling until the measured rate is at most 9 fps, then keeps a peer moving back and forth for 12 seconds. `lowfps-raw.json` preserves every rendered remote frame, including long gaps, plus authoritative bot positions. Capture assertions require actual fps ≤10 and more than eight moving frames; synchronization quality is reported from the recorded steps separately. Screenshots are captured after actual rendering.

Audio limitation: the camera fixture sets `Game.view`, which makes the sound frame inactive. The recorded context/gain/transition flags therefore do not validate audible fade or same-seed restart recovery, even after the trusted gesture. A dedicated audio check must clear the view override, wait for `sound.frame.active`, and remain process-muted. This capture does not establish an actual audio fade-to-zero failure.

The server wipe uses the real `debug down → spectator → fade → restart` flow with the same room seed. The later client-only pressure test suspends WS delivery/upload and invokes the existing `Game.loadLevel` implementation. Its different-seed same-level rebuilds and L1→L2→L3→L4 cycles must not be described as server transitions. Every level renders its barriers, landmarks, blackout objects and broadcast props before GC measurement. First appearances of level resources are labeled `first-warmup` separately.

This audit reports findings; it does not replace or loosen existing gameplay regression tests. Generated evidence is not committed.

The baseline run used 20× CPU throttling and achieved about 27 fps on Apple M4; it is not evidence for ≤10 fps behavior. Baseline evidence is preserved in `test-results/metal-audit/baseline/`. The later run expands coverage with two real pages and trusted audio unlock, so compare resource growth slopes and matched phases rather than absolute heap across different scenarios. The audit's exit 0 means capture completed with no recorded page errors and its fps/movement coverage checks passed; assess leak and synchronization findings from the recorded numbers separately.

The standalone deterministic clock probe is independent of Playwright:

```sh
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- node tests/audit/repro-snapclock.mjs
```

Its exit 1 is the expected reproduction of the current SnapClock timestamp-monotonicity defect, not a passing check. It writes `test-results/metal-audit/snapclock-repro.json` and does not alter the product or default unit gates.

The additional deterministic synchronization probe runs without a browser:

```sh
node tests/audit/repro-sync.mjs
```

It writes `test-results/metal-audit/sync-repro.json`. Its expected exit 1 records failing product invariants for source-method revive replay, CPU-only Student crouch/down geometry, and a two-second Mobs snapshot gap. These fixtures import the current product classes or execute their recorded source methods; they do not establish real keyboard, WebSocket, audible, or rendered behavior and are separate from the Metal capture.

The same synchronization probe also includes the SnapClock backlog case. Before interpreting exit 1 as a reproduced invariant failure, require a fresh `startedAt`, `executionCompleted: true` and `errors: []` in the written JSON; an import/read failure can also exit 1 and leave an older evidence file behind.

`summary.json` and the desktop/touch contact sheets are optional postprocessing artifacts. They were generated after capture for review and are not written automatically by this Playwright spec; the authoritative measurements remain `results.json`, `lowfps-raw.json` and the command's actual exit status.

# Snapshot clock backlog audit

The earlier probe failure descriptions record the pre-fix baseline. Evaluate the current implementation with the following unchanged movement bounds.

The clock audit uses two rendered WebSocket clients in one muted headless Metal
browser. Build the game, then run from `game/`:

```sh
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npm run build
python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- npx playwright test -c playwright.clock.config.ts
```

Its independent server uses port 4461. Evidence goes to
`test-results/clock-monotonic/`. Every rendered frame is checked against the
actual accumulated StepSmoother slice budget and the existing low-fps test's
0.84 m excess threshold; stalled frames remain included. The audit also checks
strictly increasing stamped snapshot times, a real backlog of at least 22
snapshots, and no smoother snaps after warmup.

The config also runs a preserved copy of `e2e/x-lowfps-remote.spec.ts`, with
`--mute-audio` as its only launch change and all assertions intact. On Metal
its fixed 10x throttle can still produce 60 fps. The two-client audit therefore
calibrates its own throttle and requires the measured run to stay at or below
10 fps; it does not infer low frame rate from the throttle setting.

To extract a compact replay from the latest two-client capture, run:

```sh
node tests/audit/capture-fixture.mjs
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npx vitest run tests/unit/snapclock_replay.test.ts --maxWorkers=1
```

The unit replay fixtures distinguish their evidence:

- `metal-lowfps-authority.json` preserves measured positions and frame cadence;
  delivery at each frame is synthetic because the original audit did not record
  receive times.
- `metal-backlog-arrivals.json` preserves exact receive times and positions from
  the first browser run. A fresh SnapClock on that recorded backlog models
  initial join/load delivery; the actual captured clock was already warm and
  stayed monotone. Its initial debt clears, then the final three arrivals form a
  new batch with no subsequent recovery tail. All recorded rows remain checked.
- `metal-backlog-playback.json` preserves exact receive times, positions, frame
  cadence and the number of arrivals each frame had actually consumed. Its
  fresh-clock replay checks the entire interpolation/playback/smoothing chain,
  forbids position snaps after initialization and retains the original 0.84 m
  threshold on every recorded frame. The trace begins at the largest post-stall
  50 ms burst and keeps its entire subsequent tail. Arrival counts matter because
  a delayed rAF callback's timestamp can predate messages already handled before
  that callback; sorting receives by that timestamp would invent a delivery order.

The first browser run found a 7 mm violation of an added `1.5 * walk * dt`
assumption. The product instead limits each slice to `1.3 * paceSpeed`, with a
further factor of 1.5 while catching up. The final audit measures that actual
budget and retains the original 0.84 m threshold unchanged. Raw first-run
evidence remains available alongside the later instrumented capture.
