# Experience integration

Worktree: `/private/tmp/escape-experience-integration`; branch: `codex/experience-integration`.
This is an isolated review branch. It has not been deployed and does not change master or cloud state.

## Baseline and accepted slices

| Source | Integration | Scope | Evidence/status |
| --- | --- | --- | --- |
| `2174268` | baseline | Direct world interaction on touch screens; includes `57a05ea` static compression | Existing v0.4.0 integration baseline |
| `820df03` | `4a65b01` | Adult Warden proportions, 1.14 scale, measured gait, slower AI, bag clearance, hearing hook | 78 Warden tests, typecheck/build, desktop/mobile real chase evidence in `/private/tmp/escape-warden-presence-evidence/` |
| `bc27636` | `d23cffd` | Warden chase audio recognition and asynchronous background audio state | Source unit checks; native audio probe still pending at intake |
| `60f38e2` | `1751e31` | v0.4.0 broadcast touch/version tail fixes | Source L4 browser 5/5; source full check still running at intake |
| `f96f204` | `897452a` | Isolated 1.5-second capture presentation and state model | Source real browser first pass; final source report pending |
| `cc2f76b` | `b4ef497` | Authoritative local capture event, down deadline, same-seed restart reset | Merged `fade` cleanup semantically: retain both touch pending cleanup and `awaitingLevel` |
| `1481a3a` | `bb2ba39` | Avoid intro/tutorial overlap with capture penalty on small screens | Source screenshot review correction; integration verification pending |
| `cbf49ca` | `408c78e` | Sample the current L2 outage's real dark phase | v0.4.0 check correction |
| `1363835` | `690f1ce` | Keep outdoor scenery culled when nearby portals leave the camera view | Fixes extra tree/sky triangles; source final check pending |
| integration review | `94d5211` | Fade nonessential HUD during the 1.5-second contact beat | Root screenshot review; captions, rescue and focused settings/map retained |
| `7b3b922` / `47c6138` | `577692f` / `bc753af` | Independent monitor sprint, complete freeze, authoritative idle/blink/warp; three-component `Mob.at` compatibility | Source 53 related tests, final 35 tests, muted Metal 18 live run frames / 645 replay frames; final idle/voice fixes still require combined browser check |
| `fed26ee` | `b4cbdeb` | Exact captor title and quantized smooth colour restoration | Source product tail; final source browser/test artifact commit pending |

The first integration typecheck passed at `d23cffd`. Later commits require the checks recorded below before this branch is called green.

## Combined verification

At `75a4b45`, shared-gate TypeScript checking passed. Six relevant suites (`capture_presentation`, `client_loop`, `room_mobs`, `transitions`, `sound`, `sound_threat`) passed all 93 tests with one worker. The complete client/server/navigation build also passed: 4069 navigation nodes and zero failures. The main script is 1,432,529 bytes, with gzip 441,305 bytes and Brotli 396,733 bytes. These results do not yet include the pending final capture, voice or perfume deltas, or combined browser verification.

A real two-WebSocket test against that built server on 4387 passed: the new 3.8 m/s Warden captured at 0.74 m; only the caught player received the event, before the forced position correction; tick 10 to downUntil 610 preserved the exact 30-second deadline; a teammate actually revived them in 3060 ms; state-only debug down emitted no capture event. Evidence: `game/test-results/experience-integration/capture-ws.json`. The first WS-only fixture faced the classroom wall (it had no browser `spawnCampus` camera initialization), so it was corrected to send a legal same-position input facing along the open corridor before the summon. The passing test did not bypass line of sight or change the game. Its own server was shut down.

## Integration rules

- Preserve Warden's 1.14 scale, AI speeds 1.4/1.9/3.8 m/s, adult body and bag clearance.
- Compose Warden form hearing and player-count hearing multipliers through the public `hearingMultiplier` hook.
- Merge capture, perfume and voice lifecycle cleanup together; each owns a different disposable subsystem.
- Merge monitor animation, forms and remote pace updates in `mobs.ts` semantically.
- Keep mobile direct interaction and v0.4.0 broadcast touch fixes.
- Source lanes remain independent. Uncommitted source WIP is not part of this branch.
- Typecheck, unit and builds use the shared heavy gate. Browser verification uses the browser gate, one muted browser at a time.

## Pending intake

Perfume, voice preferences, final capture test evidence, Warden forms, tension director, difficulty/search, spatial audio, remote motion and Warden stance-tail corrections remain pending final source reports and precise commits. Parent owns deployment.

## Known limitations retained explicitly

- Warden stance first/last 10% sole slip still reaches 0.28–0.35 times body speed in source evidence; the separate motion-tail lane is addressing it.
- New Warden art is reviewed through screenshots and real motion, without an external commercial-quality score.
- A successful source lane check is not a successful combined integration check; combined results will be recorded as they run.
