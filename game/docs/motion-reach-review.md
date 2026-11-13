# Reach-constrained pelvis continuity

When a brief restart leads into chase, the trailing swing foot can require the
pelvis to descend quickly. The reach solver previously projected its position
down while leaving the recovery spring's velocity at zero. When that reach
constraint eased, the pelvis stopped descending in a single frame. The solver
now carries the projection's measured velocity into the existing recovery
spring. Foot targets, rolling contact, IK reach limits, adult teacher scale
1.14, gestures and server speeds are unchanged.

The original continuity regression fails on the parent revision at hip position
second difference 0.0451 m; it passes after this fix. An added regression
fixes the initial breathing phases and checks the rendered hip through the
stop/restart/chase sequence against an independent 0.03 m bound. The
deterministic diagnostic's worst second difference is 0.02535 m. Momentum
recovery gives a transient maximum reach drop of 0.2011 model metres in that
sequence; this is a continuity fix, not a reduction in chase crouch depth.

Validation in `/private/tmp/escape-review-motion/game`, through the shared gates:

- Five unit suites (`warden_anim`, `warden_presence`, `warden_student`, `student_down`,
  `warden_model`): 61/61 passed. Existing assertions were not relaxed. This includes
  all six full-stance sole checks at 60 and 240 Hz, slip below 10% of body speed
  and sole height within 1 mm, plus stop/turn and teacher presence coverage.
- `npm run typecheck` and `npm run build:client` passed. The existing large
  client chunk warning remains.
- Chromium with Metal and muted audio, private port 4472: six rendered chase
  frames captured and visually inspected, teacher scale `[1.14,1.14,1.14]`,
  zero page errors. Evidence remains outside Git under
  `game/test-results/motion-review-browser/`. The probe server/browser stopped.

No real-time video or external animation score was produced by this review.
TODO 569 can be checked after integration reruns the original suites. This fixes
the encountered continuity failure related to TODO 566, but its requested
speed-driven walk/chase/sprint amplitude interpolation was not implemented.
The video/external-score requirements in TODO 354 and 488 remain outstanding.
