# Timing, cinematic, feedback and teaching integration review

Integrated against `e5f3ac7`, preserving the eight chapter campaign, authoritative capture contact data, player capture sequence, room capture episode, reconnect state and render-independent revive hold.

## Reviewed source chains

- Clock: `6acb922`, `647f3de`, `0ee3a4c`.
- Team feedback: `ef6f75a`, `4a8295f`, `da77b41`, `cb7d286`, `f47b78e`.
- Cinematic: `07559d4`, `bb3ea0d`.
- Tutorial / ping: `8325182`, `4b793e2`, `c177b1f`.
- Teaching clarity: `1037486`, `2184814`, `8d4c317`.

## Integration corrections

- Cinematic intro freezes the simulation tick while the network snapshot tick advances. Capture event ticks and wire `downUntil` now use the snapshot clock; internal hold and grace deadlines retain simulation time. Full reconnect snapshots retain that clock and translated deadline. Three integration regressions exercise the real lobby lifecycle, Game's stale-event gate, reserved disconnect voting and reconnect after the intro deadline.
- Full reconnect mob snapshots explicitly forward the full-field flag to each mob, including the finale mob.
- Objective timing owns all banner duration. Clearing a replaced banner cancels its presentation without rearming the opening. Intro, capture, background, network pause, transition, completion and spectator presentation do not consume reading time. Intro closes story UI and cancels held interactions. Input remains disabled on a network pause.
- An ordinary repeated same-seed room message retains gameplay and tutorial state. An authoritative spawn correction or a forced retry reloads the incarnation, waits for the local spawn and readable banner, then starts L1 teaching. The obsolete two-frame tutorial reset was removed.
- Native document pointer-lock events, HUD touch blocking, touch drag dead zone, new teaching collaborators, Net connection handshake and watchdog ownership are represented in the test fixtures. The physical E-key hold and ephemeral revive transport assertions remain intact.
- Team feedback uses independent room episode identity and preserves private capture recipient, exact source / contact / hold / sequence fields. Mirror source and optional monitor display names are accepted. The final names lane must supply the actual server monitor name to the teammate notice and retain the requested monitor wording.
- The bursty patrol replay now asserts the exact distance from the actual `WARDEN_PATROL_SPEED`, preserving every existing snap, maximum step and lag limit.

## Validation

- Gated `npm run typecheck`: passed (`/private/tmp/escape-review-timing-typecheck-4.log`).
- Gated Vitest: 30 files, 282 tests passed (`/private/tmp/escape-review-timing-tests-4.log`), one worker, runner config loader, caches disabled. Covers clock/interpolation, feedback/down poses, intro authority/touch, input, tutorial/objective timing, teammate activity, highlighting, capture, reconnect, revive hold, spawn readiness/grace and disposal.
- Gated full `npm run build`: passed, including client precompression, server and 4069-node navigation build with zero failures (`/private/tmp/escape-review-timing-build.log`).
- Real three-peer WS acceptance on the isolated development server at port 4472: passed both Warden and monitor capture / spectator notification cases (`game/test-results/team-feedback-ws.json`, `/private/tmp/escape-review-timing-ws.log`). Each of three peers observed 550 active post-rescue snapshots through the original down expiry; the actual hold took 3045 ms. Room episodes advanced from 1 to 2 across a real L1 → L2 transition.
- The WS/browser fixtures now use real intro-skip and spawn-ready handshakes, validate the full exact private capture wire object against the real catcher's position in the same authoritative snapshot, and retain recipient / sequence / hold / contact checks. Optional monitor `mob` and `name` are accepted with identity checks for the final names integration.
- Cinematic native touch expectations consume the shared 10-pixel drag dead zone on each fresh gesture and retain exact six-decimal yaw assertions. Dedicated cinematic and feedback configs accept `ESC_TEST_PORT` so review can use the reserved port without editing product configuration.
- Real browser acceptance remains for the final integration tree. No browser pass is claimed by the WS result.

## Main entry point adaptation

The final tree has a newer asynchronous `enterRoom` / `receive` / `prepareGame` entry point. Integrate the session Sound owner, team feedback notices, intro event forwarding, chat gate and touch blocker semantically into that entry point. Do not replace it with this branch's earlier `main.ts`, construct Game synchronously during the room message, or remove `worldReady` / `presentWorld`. Keep the four-argument, boolean-returning `loadLevel(index, seed, force, resumed)` contract and pass monitor names through capture feedback.

Root owns final integration, builds, package production and `todo.md` checkboxes. This branch does not claim deployment, native package validation, video scoring or a full project check.
