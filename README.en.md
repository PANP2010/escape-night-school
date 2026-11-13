> Privacy update: old branches, tags and release assets have been removed at the owner’s request. Historical version descriptions below do not imply old installers remain downloadable.

# Escape Night School

[中文 README](README.md) · [Contributing and derivative works](CONTRIBUTING.en.md) · [MIT License](LICENSE) · [Disclaimer](DISCLAIMER.md) · [Play online](http://154.217.245.217:4100/) · [Download clients](http://154.217.245.217:4100/downloads/)

Escape Night School is a 1–4 player first-person co-op horror game set in a school after midnight. Search for clues, avoid the night-school monitors, rescue teammates, and clear eight chapters before reaching the gate. The project keeps its original code-drawn, non-realistic chalkboard style. The web game, desktop builds, and Android client share the same levels and networking protocol.

## Cloud maintenance ends / migration (2026-11-13)

Due to financial and coercive pressure, the cloud service is no longer maintained and is being shut down. Its old online and download URLs may stop working. **Old installers have been removed from GitHub for name privacy; anonymized installers have not been rebuilt. Build locally from the anonymous source instead.** The original host still offered non-anonymized v0.6.2 packages at migration time; do not mistake them for a new anonymous build or redistribute them publicly. Windows/macOS support offline solo and LAN hosting. Android still requires a self-hosted or LAN server.

`main` now preserves the latest curated development source (version field 0.6.3). No installers were rebuilt and the full gameplay gate was not rerun as part of migration. Installers and development source may differ; battle royale remains unfinished. Player data, feedback, logs, credentials and internal automation records are privately archived, not included in this source snapshot. Unverified art-worktree changes have not been merged.

## Current release

Historical installers were version 0.6.2 and have been removed from GitHub. The anonymous source snapshot has a 0.6.3 version field, with no rebuilt installers yet. Historical features include:

- Eight complete chapters: evening study, blackout, endless corridor, broadcast station, gym, exam hall, mirror hall, and the registrar finale.
- The Warden and duty monitors, pursuit, catches/downed states, rescue, and a finale chase. Monitors use their original anonymous, faceless models by default. A complete nightmare clear unlocks optional named easter eggs for future rooms; The Boss then becomes a boss only when that name is randomly drawn.
- Four sequentially unlocked difficulties: First Sight, Night Patrol, Closed School, and No Survivors.
- Achievements, campus easter eggs, server-timed speedrun leaderboards, and separate solo/party boards.
- Unified controls, audio, and display settings. The interactive-item highlight can be turned off and is persisted.
- Offline solo play and LAN hosting on desktop; Android connects to a cloud or LAN server.
- Guidance is chosen before room creation. Guided runs never rank; an unguided room cannot enable navigation mid-run. Fixes cover basketball noise, accidental chapter-three loops, and Warden losing a continuously visible target.
- The nickname `DEV-LOCAL#` creates a private developer room with chapter selection, protection, teleportation, and enemy summons. Developer rooms never rank.
- Reconnection clears obsolete lobby disconnect warnings. Membership changes during a restart preserve the audio fade, and fuse-box guidance and targeting align with the visible cabinet.
- Drifting pale-yellow perfume particles remain visible on desktop, mobile, and low graphics. Desktop mouse look is restored, with a close-contact capture scare and improved lighting on the original Warden model. Chapter-seven reflections use the original student and monitor rigs.

## Play now

The old [public web build](http://154.217.245.217:4100/) and original-host [download page](http://154.217.245.217:4100/downloads/) may stop working. Those historical installers were not anonymized; build from this anonymous source instead and do not redistribute old packages publicly.

On desktop, “Local Play” starts an offline solo server. “LAN Host” starts a server on the local network and shows an address to share with friends on the same Wi-Fi. Friends can use a browser, another desktop build, or the Android client, enter that address, and join with the same room code. Android does not host an offline server.

## Local development

Use Node.js 22.18 or newer. The web client and server live in `game/`:

```sh
cd game
npm ci
npm run dev       # build the client and start the local server
npm run check     # typecheck, unit tests, production build, browser regression
```

Build a production server with `npm run build`, then start it with `PORT=4100 npm start`. The server serves the static client over HTTP and exposes multiplayer WebSocket connections at `/ws`.

## Desktop and Android packaging

Native shells are in `apps/`. See [`apps/README.zh-CN.md`](apps/README.zh-CN.md) and [`docs/build-native.md`](docs/build-native.md) for the full release procedure. The core flow is:

```sh
cd apps
npm ci
npm run icons
GAME_ROOT=/path/to/escape/game npm run prepare:game
npm test
npm run desktop:mac   # macOS DMG
npm run desktop:win   # Windows NSIS installers
```

Android packaging requires Android SDK 35, JDK 17, and Gradle 8.11.1; run `gradle assembleRelease` from `apps/android`. Signing values are read only from environment variables and must never be committed.

## Repository layout

```text
game/       TypeScript client, server, shared levels, and tests
apps/       Electron desktop shell, Android WebView shell, and packaging scripts
docs/       Design notes, player guide, deployment, and validation records
```

Gameplay and controls are documented in [`docs/README.md`](docs/README.md). Desktop installation, LAN play, and release validation are recorded in [`docs/native-lan-0.6.2.md`](docs/native-lan-0.6.2.md).

## Contributing and derivative works

Contributions to gameplay, levels, fixes, translation, and documentation are welcome, as are forks, fan projects, and commercial derivatives. The [contribution guide](CONTRIBUTING.en.md) covers setup, PRs, level extensions, testing, and licensing. Independent derivatives need no upstream approval. Retain MIT copyright and permission notices and follow the applicable licenses of third-party resources.

## License and disclaimer

Original code, documentation, and included assets that the project has the right to license are available under the [MIT License](LICENSE), unless otherwise marked. Use, modification, commercial use, and redistribution are permitted with the copyright and permission notices retained. The [Chinese translation](LICENSE.zh-CN.md) is for reference; the English license text governs. Third-party dependencies retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md) and the [disclaimer](DISCLAIMER.md).
