Run from `game/` after building the client, server and nav data:

```sh
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npm run typecheck
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npx vitest run --maxWorkers=1
python3 /Users/local-user/escape/loop/parallel_sprint.py gate heavy -- npm run build
python3 /Users/local-user/escape/loop/parallel_sprint.py gate browser -- ./node_modules/.bin/playwright test --config=playwright.cinematic.config.ts
```

The independent config starts its own built server on port 4435 and closes it when the suite finishes. An existing server on that port causes a failure. The six cases use one Chromium worker with Metal and muted audio. Desktop peers use two isolated contexts in that browser; the mobile cases run afterward with one context at a time.

The three protocol cases use actual Node WebSockets against `/ws`. They cover player and monster freezing across fresh snapshots, one skip, all original voters skipping with a late observer, stale skip rejection, an actual eight-second deadline, and a late join retaining the original deadline. The clear case waits through the real intro, then checks that elapsed time counts about 1.25 seconds of active play and that the handoff remains three seconds. No freeze assertion uses debug safe. Clear world-state freezing is covered by the server unit suite because the existing black handoff does not stream snapshots.

The desktop case checks both title cards, frozen player input, actual L1 and L2 silhouette visibility, synchronized deadline and all-skip events, and clear title/time. Mobile checks a static camera position and orientation under reduced motion, readable bounds, a non-overlapping touch target of at least 44 pixels, and the actual skip message.

The additional mobile case uses trusted Chromium CDP multi-touch events across a real clear into L2 and a same-level restart. Old control fingers remain isolated after both the eight-second deadline and a teammate's all-skip reply, while fresh stick, look and run gestures work immediately. It checks mixed old/new `changedTouches` movement, old/new releases, and the native ended/active identifiers after every release. A fresh 20-pixel look consumes the shared 10-pixel drag dead zone once, then turns exactly 0.04 radians to six decimal places. Noncancelable events must still release their controls, and browser errors remain an unfiltered empty-array assertion.

Screenshots and JSON timing/protocol evidence are written to `test-results/cinematic-*`. Inspect the screenshots after a run; a passing DOM assertion does not replace visual review. This suite does not claim an external cinematic/horror rating.

`test-results/cinematic-mobile-touch-quarantine.json` contains both authoritative intro lifecycles, trusted touch targets and coordinates, active identifiers, actual look calls, and browser errors. `test-results/cinematic-mobile-touch-diagnostic.json` records the deadline transition and mixed-touch look in detail. The seven screenshot frames include `test-results/cinematic-desktop-l2-silhouette.png` for the actual L2 reveal.

Only the desktop host context records video, at 960×540. After both contexts close, the recording is saved as `test-results/cinematic-intro-clear.webm`; a complete passing run contains the real eight-second opening, clear handoff and independent skip/wait sequence. The peer and mobile contexts do not record. No Gemini tool is available in this task, so the video has not received an external cinematic/horror score.
