# Teacher presence and motion

This follows the user's 2026-11-05 correction that Warden is too short, moves too
quickly, and needs readable, slower strange gestures. The original bald head,
light glasses, black hooded jacket and adult teacher identity remain. Existing
35-year-old face/posture improvements were taken from the character branch as
individual file changes; unrelated branch work was not merged.

The default teacher is 2.016 m tall in the idle pose (previously 1.754 m), with
0.794 m maximum width. Common door openings are 2.1 m tall and 1 m wide. Only
his mesh grows: students and monitors retain independent builds, poses and
scales; navigation/collision capsules and the 0.8 m catch radius are unchanged.
Eye height for authoritative sight moves from 1.6 m to 1.88 m to follow his head.

Patrol / investigate / chase speeds are now 1.4 / 1.9 / 3.8 m/s (previously
2.0 / 2.9 / 4.6). A 3.4 m/s walking player is still caught; sprinting at 6 m/s
opens distance. The standing gestures have their own rates: idle and investigate
0.65, look and peek 0.6, catch 0.72, joke 0.65. Gait playback remains measured
world speed divided by rig scale and stride, so footfalls match displacement.
Patrol now has 2.10 footfalls/s and chase 4.19 (previous chase approximately 5.8).
Breathing remains active at its established rate. Voice text and synthesis are
untouched.

Slow movement exposed a knee discontinuity during a closing step: its soft IK
reach limit was changing with the mixed animation clip. A fixed soft reach for
the teacher removes that moving limit. Student/monitor reach is preserved. The
existing start/stop/turn state machine and stance foot lock remain in use;
the 21 animation regressions, including rotation continuity, stopping and
turn support, pass with the new speeds and scale.

The bag was overlapping the right hand. It now sits at the back of the right
hip with restrained swing from its short strap. Real skinned bag and complete
right-hand AABBs remain separate across 2,160 frames (four initial posture phases) of walk, chase and catch,
including the transitions. The model showcase cameras were reframed for the
taller body so face and feet can be reviewed without clipping.

`WardenEnv.hearingMultiplier?: () => number` allows room/form logic to set night
hearing without editing the AI. It is evaluated per noise event and leaves the
source event and wall attenuation unchanged.

Validation: `npm run typecheck`, `npm run build`, and the seven Warden unit suites
(78 tests) pass. Chromium desktop and mobile landscape created and started real
rooms, received 141 / 107 snapshots, displayed the 1.14 teacher scale and chase
state, and had no page errors. The browser captured near/mid/far chase frames,
front/side/back/face/lineup views, seven half-second catch frames, and real-time
WebM recordings. The half-second samples advance the catch clip by 0.36 seconds,
showing its independent 0.72 rate. Evidence:
`/private/tmp/escape-warden-presence-evidence/` (`browser-presence.json`,
`foot-metrics.json`, screenshots and desktop/mobile videos). Screenshots were
visually inspected locally. No external video score was claimed.

Remaining measured limitation from todo #569: the first/last 10% of stance has
peak instantaneous sole slip 0.28–0.35 times body speed. Interior stance maxima
are 0.005–0.029 times body speed, and median full-stance slip is at most 0.0064.
This release does not mark that edge-of-stance issue fixed. Bag-to-clothing
clearance is visually checked, while the regression specifically guards the
hand. Jasmine restoration, forms, capture staging, and difficulty changes are
separate work and are not included in this commit.
