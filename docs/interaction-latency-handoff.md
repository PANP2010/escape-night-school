# v0.4.1 interaction latency hotfix

Base: the deployed v0.4.0 commit `f5986aa`. Isolated tree `/private/tmp/escape-hotfix-latency`, port 4390. No experience features, server protocol changes or deployment are included.

The phone interaction button already presses E on `touchstart`; its path does not use the 350 ms hold threshold for direct object touches. The actual client defect was that E was consumed only inside the game animation frame. When rendering stalls but DOM/WebSocket processing continues, sending an interaction waits for that frame.

`Input.onInteract` now dispatches a fresh E edge immediately. `Game.interactPressed` consumes it once, checks gameplay availability, and uses the existing authoritative interaction path. Holding E retains the key for rescue refreshes; the server still requires the existing three-second rescue. Repeated taps on an outstanding request for the same object do not double-toggle a door. The prompt says `请求已发出，等待确认…` immediately. Door/item changes and success sounds/haptics still require authority. Direct object touches, drag cancellation and HUD shielding remain on their existing paths.

## Measured results

One sequential headless Chromium session per run, Apple M4 / ANGLE Metal, audio output muted. Desktop 960×540, phone 844×390, DPR 1. Normal cases use 12 actual key/touch presses; the 1 Hz rAF and CPU ×6 cases use four. The 1 Hz case deliberately slows only animation scheduling, leaving DOM and WebSockets active; it is a scheduling reproduction, not a claim about this machine's GPU speed.

| Case | Before event→request p50 / p95 | After event→request p50 / p95 |
| --- | --- | --- |
| Local desktop, 60 fps | 10.2 / 62.0 ms | 0.1 / 68.1 ms |
| Local phone, 60 fps | 15.0 / 16.2 ms | 0.1 / 1.5 ms |
| Local desktop, 1 Hz game frames | 560.5 / 567.3 ms | 0.2 / 1.5 ms |
| Local phone, 1 Hz game frames | 573.0 / 980.4 ms | 0.2 / 1.6 ms |

The new pending text appeared within 0.2 / 1.6 ms on the 1 Hz desktop and 0.3 / 1.7 ms on the 1 Hz phone. All fixed trials asserted exactly one request, pending feedback before server confirmation, unchanged door state before confirmation, and no movement corrections. Real 1 Hz door pictures still wait for the next rendered frame (568–1020 ms total in this sample); the fix removes request scheduling delay.

The live public v0.4.0 client/server was also measured in real production rooms, reached by normal legal movement because production rejects debug positioning. Desktop send→confirmation was 414.2 / 1285.6 ms; phone was 739.4 / 1181.7 ms. The client rendered at 60 fps and applied confirmations within 1.1 ms, with zero movement corrections. Snapshots arrived in bursts despite consecutive server ticks. Root's independent loopback/public WebSocket audit is `/private/tmp/escape-network-latency-audit.json`: loopback snapshots were steady at 20 Hz, while this host's public path had substantial delay and jitter. This is a measured path/time window, not a claim about all players.

The hotfix client was then served locally and connected directly to that real production WebSocket, without changing the public deployment. Both 12-trial desktop/phone runs passed pending-state and authority assertions. Phone event→request was 0.1 / 1.3 ms; event→pending was 0.2 / 1.4 ms. Desktop median was 0.1 ms, with a 73.3 ms first-gesture outlier. Network send→confirmation in this later sample was 215.7 / 387.2 ms desktop and 287.8 / 500.5 ms phone; the difference from the earlier public sample is network variability, not an effect of the client patch.

## Validation and evidence

- TypeScript checking passed.
- Four existing relevant suites passed 21 tests; the new dispatch suite passed nine tests covering no-frame dispatch, repeat suppression, unavailable/settings states, no optimistic success, and rescue hold refreshes.
- Complete client/server/navigation build passed; 4069 nav nodes, zero failures. The final client was rebuilt after the small repeat/prompt cleanup.
- Fixed real browser probes passed five local conditions and both production-WebSocket conditions. Browser errors and movement corrections were zero.
- Detailed JSON and PNG evidence is under `game/test-results/interaction-latency/`: `baseline.json`, `baseline-public.json`, `baseline-slow.json`, `fixed-local.json`, and `fixed-public-ws.json`. The first baseline report intentionally remains failed because its initial public positioning fixture used a production-disabled debug command; the passing public report uses normal movement.
- Existing full touch/feedback/campaign browser acceptance was not repeated in this lane; the release integrator owns the combined gate.

The portable probe is `game/tests/interaction-latency.mjs`; use the shared browser or integration resource gate. Defaults exercise local conditions only. Set `EXPECT_FIXED=1` for assertions; public rooms require an explicit `ESC_LATENCY_REMOTE` URL. `REMOTE_WS=1` serves the hotfix assets locally while using the real public server; `PUBLIC_ONLY=1` loads the public client. `SLOW_ONLY=1` runs only scheduling/CPU cases. It owns and cleans up only its 4390 server/browser.

Known remaining limitation: the first desktop gesture can spend roughly 68–73 ms creating the old Voice AudioContext in a capture listener. Direct method timing attributed 67.6 ms to `Voice.unlock`, versus 0.3 ms for `Sound.unlock`. Later/phone Voice unlocks were normally below 1 ms. This hotfix preserves Safari's requirement to resume audio synchronously inside a trusted gesture; no speculative asynchronous audio change was included.
