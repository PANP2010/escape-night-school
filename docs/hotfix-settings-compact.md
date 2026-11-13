# Compact feedback settings hotfix

Base: `f5986aa98219c0ba95fc4d3370954d6fd352ad4c` (released v0.4.0).

The sound/haptics entry is a 22px sliders icon in a 44×44 native summary target. It always starts closed. An explicit click, tap or keyboard activation opens a 228px panel; volume, mute, haptics and local persistence retain their existing API. Escape closes and restores summary focus. An outside pointer closes and releases control focus without cancelling the game gesture.

On coarse landscape screens the open panel scrolls above the lower-left joystick. The closed rectangle does not overlap the room code, map button, L4 broadcast status or stick at 844×390 and 667×375. Existing map/keypad visibility rules still apply.

Final browser result: **3 passed in 22.0s, zero retries, zero page errors**, ANGLE Metal Apple M4.

Validation: typecheck; 22 feedback unit cases; complete client/server/nav build. The final compact-settings browser run uses Metal, muted audio, one worker and zero retries at port 4391 with the real L4 preview. It exercises desktop native Tab/Enter/range/checkbox/Escape, outside close and subsequent F input, preferences across reload, both phone sizes, all controls after scrolling, same-tap outside close plus an authoritative battery pickup, map hide/restore and look drag. No product input or interaction API was changed.

Evidence (local, not tracked): `game/test-results/feedback-compact/desktop.json`, `desktop-{closed,open}.png` and `phone-{844,667}-{closed,open,controls}.png`, plus `phone-{844,667}.json`. All desktop and phone closed/open/control screenshots were directly inspected. The parent also inspected phone 667 closed and phone 844 open.

The first browser runs exposed test synchronization errors: a role locator omitted the now-hidden range after close; then nodraw projected through the pre-teleport camera position. The final test waits for camera position and rotation, refreshes its world matrix, and asserts the pickup point lies inside the viewport. The real pickup assertion was retained. Failed diagnostic runs are not reported as passes.
