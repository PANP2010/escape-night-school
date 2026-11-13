# Contributing and derivative projects

[中文](CONTRIBUTING.md) · [Project overview](README.en.md) · [MIT license](LICENSE)

Help improve Escape Night School through bug fixes, touch and multiplayer improvements, documentation, translations, or level design. Forks, fan projects, modified editions, and commercial projects are welcome. You can release your own derivative without first sending a PR or requesting permission from this repository.

## Forks, fan projects, and commercial use

Original content that this project has the right to license is available under [MIT](LICENSE), unless otherwise marked. When using, modifying, commercially using, or redistributing it, retain the copyright and permission notices required by MIT. Third-party content keeps its own licenses and applicable notices; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). We recommend including [DISCLAIMER.md](DISCLAIMER.md) with distributions to explain the fictional setting, horror content, and limits of the service.

We suggest giving derivatives a clear project name, version, and repository link, and identifying their origin in Escape Night School so players can distinguish the original project from derivatives. These suggestions about naming, attribution format, and including the disclaimer add no conditions to MIT. The software license does not replace third-party asset licenses or rights concerning real people's names and likenesses. Record the source and license when adding external content.

## Reporting problems or proposing changes

Use the repository's bug template and include the version or commit, device/OS/browser, chapter, difficulty, player count, guidance setting, and reproducible steps. For performance or multiplayer problems, describe when they happen and how you connect. Logs, screenshots, or a short video can help; remove personal information and credentials before sharing them.

Small fixes can go straight to a PR. For a new chapter, protocol change, or broad art change, consider opening a feature Issue first to describe the player experience and why it should change. Derivative projects do not need to wait for upstream agreement on their direction.

## Local development and PRs

Use Node.js **22.18 or newer** and npm. Fork and clone your own repository, then work on a separate branch, such as `git switch -c fix/ball-pursuit`. Run web client and multiplayer server commands from `game/`:

```sh
cd game
npm ci
npm run dev
```

The default address is `http://localhost:4100/`. `npm run dev` builds the client and starts a server that watches server changes. After client edits, rebuild the client or run `npm run dev:client` in another terminal to use Vite.

Choose validation that fits the change. Logic fixes should include a regression that reproduces the problem; UI changes should describe desktop and touch checks. For documentation-only edits, review the text, links, and commands; a full game test run is not required. Common commands are:

```sh
npm run typecheck
npm test -- --maxWorkers=1 tests/unit/room.test.ts
```

Run the full checks for substantial gameplay changes or release preparation. Install Chromium before the first browser test run:

```sh
npx playwright install chromium
ESC_TEST_PORT=4299 npm run check
```

`check` runs type checking, unit tests, a production build, and browser regressions, then stages the verified build. The default test port is `4199`; `ESC_TEST_PORT` sets an unused port for the main test configuration to avoid conflicts with other instances. In PowerShell, set `$env:ESC_TEST_PORT = '4299'` before running `npm run check`. Specialized Playwright suites use their own configuration files.

Push your commits to your Fork and open a PR against this repository. Describe the concrete problem, resulting behavior, validation performed, and platforms you have not checked; include before/after screenshots for visual changes. Keep each PR focused on one problem. No CLA is required. Ensure you have the right to submit your contribution under this project's MIT license, and identify licenses for new third-party content.

## Where to make changes

| Path | Contents |
| --- | --- |
| `game/shared/levels/`, `game/shared/level.ts` | Level definitions, ordered chapter registry, generation, and exit rules |
| `game/shared/protocol.ts`, other `game/shared/` modules | Message validation, shared state, collision, and gameplay rules |
| `game/server/room.ts`, `game/server/ai/` | Authoritative room state, chapter transitions, enemy sensing, and pursuit |
| `game/client/src/` | Rendering, chalk art, interactions, touch controls, audio, and UI |
| `game/tests/unit/`, `game/tests/e2e/` | Unit regressions and real browser flows |
| `apps/`, `docs/` | Desktop/Android shells and packaging, gameplay, and build documentation |

A playable new chapter needs coordinated shared definitions and registration, server state and completion checks, any necessary protocol fields and parsing, and client scenes and interactions. Verify entering and completing the chapter; a cover-menu entry or static scene alone does not make it playable. New state should also handle multiplayer, late joining, reconnecting, and retries. See the [native build guide](docs/build-native.md) for packaging entry points.

## Keeping the game consistent

- Upstream retains the original code-drawn, nonrealistic chalkboard style. Improve silhouettes, contrast, animation, and readability without replacing scenes with realistic blackboard photos or textures. Derivatives may choose their own art direction.
- The server owns movement reachability, collisions, enemy captures, puzzle completion, and run timing. Clients provide inputs and presentation; self-reported results, local clock changes, or forged messages must not earn rewards.
- Guidance is selected before room creation, and guided runs are excluded from speedrun rankings. Developer rooms and runs using test features are also excluded. Changes to debug entry points, room permissions, or leaderboards should include server checks for unauthorized actions and ranking isolation, while preserving the normal player flow.
- Do not commit server passwords, tokens, `.env` credentials, signing keys/certificates, or keystores. Exclude generated dependencies, builds, reports, and installers such as `node_modules`, `game/dist*`, `apps/stage/`, and `apps/output/`. Update the corresponding lockfile when changing dependencies; distribute installers as Release assets.
