# Environmental audio and chapter handoff

This slice adds non-dialogue sound and optional mobile haptics around the existing three playable floors. The current wordless baritone babble and canonical subtitles remain in `voice.ts` unchanged. No media API, model or TTS is introduced.

`Sound` owns one gesture-unlocked effects context and a bounded graph. Its five ambient sources blend sheltered wind, electrical hum and nearby danger. Real movement drives footfalls; server-confirmed changes drive door creaks, impacts and pickups. Remote steps use the source's floor/surface and distance, stereo bearing and collision occlusion. A compressor, local effect volume/mute and a 24-source cap bound the mix. Hidden/pagehide state stops sources and suspends; a fresh real gesture resumes. Disconnect/disposal removes feedback listeners, settings and audio resources. Mobile haptics are short, discrete, rate-limited, optional and suppressed by reduced motion. No continuous movement vibration is used.

`LevelTransitions` uses independent CSS and the existing server handoff. It presents the current chapter over 180 ms, updates to the new chapter after its room message, then reveals over 280 ms after its authoritative spawn. It adds no server wait or input lock; reduced motion skips those visual fades. A bounded fallback prevents a stalled snapshot from leaving a permanent presentation overlay. The completion copy still says only three floors are available.

The settings panel uses labelled native inputs, touch targets of at least 44 px, safe-area insets, small-screen scrolling and keyboard Escape/Tab support. Opening it clears held movement and queued action edges. Settings gestures do not reach world controls.

Validated on 2026-11-05 in `/private/tmp/escape-polish-audio`, based on `fb7e154`:

- Typecheck, client build and server build passed.
- 103 tests passed across sound, haptics, preferences, transitions, input, existing client loop/view and voice gating suites (`--maxWorkers=2`).
- Six real Chromium tests passed with one worker on port 4382: two-client L1 → L2 → L3, trusted desktop and touch audio unlock, real footsteps/down heartbeat, authoritative shared door audio, mute/zero volume, persisted preferences, native settings keyboard/touch use, reduced-motion haptic suppression and closed-context cleanup after WebSocket disconnect. Wire assertions retain two 3-second server fades. The headless visibility boundary is explicitly simulated; it exercises the real AudioContext suspension and gesture recovery. Haptic requests are recorded through a navigator stub; physical device vibration is not claimed.
- Five fresh screenshots were inspected, including desktop, iPhone landscape, a 640 × 240 touch viewport and both chapter handoffs. The handoff hides the gameplay HUD so prior objectives cannot show through chapter text.
- `tests/probe-audio-polish.mjs` captures the actual Chromium master effects bus into stereo 48 kHz s16le PCM/WAV. It includes indoor ambience, walking, door open/close, flashlight click and down heartbeat, with no page errors or clipping. Its preserved 10.0267-second capture measured peak 0.06058 and RMS 0.006732. This is signal verification and an export for listening; no physical-speaker or Safari-device audition is claimed.

Evidence is preserved outside Playwright's disposable output folder at `/private/tmp/escape-audio-polish-evidence`: `listening-sample.wav`, `listening-sample.pcm`, `signal.json`, `feedback-desktop.png`, `feedback-touch.png`, `feedback-short-touch.png`, `audio-handoff-l1-l2.png`, `audio-handoff-l2-l3.png`.

Reproduce after the normal build/nav cache:

```sh
npm run typecheck
npm test -- --maxWorkers=2 tests/unit/sound.test.ts tests/unit/haptics.test.ts tests/unit/feedback-settings.test.ts tests/unit/transitions.test.ts tests/unit/input.test.ts tests/unit/client_loop.test.ts tests/unit/loop_view.test.ts tests/unit/voice-gate.test.ts
npx playwright test --config playwright.audio.config.ts x-feedback.spec.ts x-audio-transition.spec.ts
PORT=4382 node dist-server/index.js
# In another terminal, while that server runs:
AUDIO_EVIDENCE=/tmp/escape-audio-evidence node tests/probe-audio-polish.mjs
```

Integration boundaries: `game.ts` changes feedback hooks only. `input.ts` gains `clear()` and allows uncaptured Tab navigation. `main.ts` preserves `installUpdateNotice` and all existing session updates. `client_loop.test.ts` supplies feedback seams to its constructor-free fixture. The mobile direct-touch lane may refactor the `KeyE` dispatch: retain the new `pendingFeedback` record at the common accepted-dispatch point so a direct tap gets the same server-confirmed pickup/door haptic. No changes are made to scene materials, shared level mechanisms, room logic or protocol.
