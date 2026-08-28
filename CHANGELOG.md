# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres (attempts) to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.31.0](https://github.com/thedorekaczynski/gronka/compare/v0.30.0...v0.31.0) (2026-08-28)


### Features

* **download:** add Klipy GIF and sticker support ([0b2d4e3](https://github.com/thedorekaczynski/gronka/commit/0b2d4e35222fe5718c70f257125f7ff7e441d0c9))
* **download:** add Medal and Tenor as yt-dlp sources ([f1c4a0e](https://github.com/thedorekaczynski/gronka/commit/f1c4a0ebfbf269bf6ed30add5a134b81be9b6320))
* **webui:** remove Discord portal install stats ([f6515da](https://github.com/thedorekaczynski/gronka/commit/f6515daa6697f583821177e6c7d6d1f226cf509f))


### Bug Fixes

* **download:** restore youtube downloads via web_embedded client ([159c576](https://github.com/thedorekaczynski/gronka/commit/159c57685b8967c33e4473ee98daa4e64a4f95da))
* **prefix:** stop logging unreplyable channels as unhandled errors ([7f95c25](https://github.com/thedorekaczynski/gronka/commit/7f95c25d2b701782d10106f00d5a8f499d9113ac))
* **webui:** remove unused stats note styles ([157150c](https://github.com/thedorekaczynski/gronka/commit/157150c35e6fa31091a0951c89142e9ea710257c))

## [0.30.0](https://github.com/thedorekaczynski/gronka/compare/v0.29.0...v0.30.0) (2026-08-14)


### Features

* **download:** add niconico support via yt-dlp ([bb9d7f6](https://github.com/thedorekaczynski/gronka/commit/bb9d7f6a8a896275afbb914cc56b5dacd1fd9955))


### Bug Fixes

* **download:** download instagram photo and carousel posts ([f49d553](https://github.com/thedorekaczynski/gronka/commit/f49d5532b9833db8f984911d7b8676a1819dc88f))
* **download:** report instagram photo posts as having no video ([8014be4](https://github.com/thedorekaczynski/gronka/commit/8014be4505a55c854ab4ad6ac888637f13876233))

## [0.29.0](https://github.com/thedorekaczynski/gronka/compare/v0.28.0...v0.29.0) (2026-08-09)


### Features

* **config:** make the support server and CDN host configurable ([259fc14](https://github.com/thedorekaczynski/gronka/commit/259fc1408fb2693ce0fd12523ec79d272b6e316e))
* **download:** add a Pinterest extractor for pins and pin.it links ([a5c2ecd](https://github.com/thedorekaczynski/gronka/commit/a5c2ecdc5dca8bad6bfa9bddb0a595682fdb9db3))


### Bug Fixes

* **download:** route gifs by magic bytes, not a lying content-type ([bb455e0](https://github.com/thedorekaczynski/gronka/commit/bb455e01fa2940bc77029896cb31375bef79ba62))
* **scripts:** stop maintainer scripts assuming the upstream instance ([501d790](https://github.com/thedorekaczynski/gronka/commit/501d790c07b9c57183c6abebf70e2a6a94c796ca))
* update the Discord invite link to the current server ([b241cf8](https://github.com/thedorekaczynski/gronka/commit/b241cf81bc3f5de9c72804c07fb854872d1efb73))

## [0.28.0](https://github.com/thedorekaczynski/gronka/compare/v0.27.0...v0.28.0) (2026-08-03)


### ⚠ BREAKING CHANGES

* the /stats slash command is removed; use /info.

### Features

* merge /stats into /info and drop the /stats command ([ebbeb34](https://github.com/thedorekaczynski/gronka/commit/ebbeb3482a1c8bb8b3c026587f84b04c7801a710))
* **webui:** rebuild the alerts page around failure causes ([0c05c89](https://github.com/thedorekaczynski/gronka/commit/0c05c89d7907528ad8dfc0684234e6ebc8b14f83))


### Bug Fixes

* **compose:** make app depend on cobalt ([484ddc7](https://github.com/thedorekaczynski/gronka/commit/484ddc798a969dbc729eda8ff99c4d163aa5ad91))
* **convert:** record the failure reason on convert alerts ([e49a9e3](https://github.com/thedorekaczynski/gronka/commit/e49a9e3e161be6147fe8bdf7ca51f88f982f592c))
* **convert:** repair reserved colorspace tags ffmpeg 7 rejects ([a219202](https://github.com/thedorekaczynski/gronka/commit/a2192021f167e4fb377838ec677e27e55b88726a))
* **docker:** register application commands on container startup ([e91cd03](https://github.com/thedorekaczynski/gronka/commit/e91cd03f9cfd5ef5bf5632dff492c8ced227bc11))
* **download:** bound the per-carousel download fan-out ([acb902a](https://github.com/thedorekaczynski/gronka/commit/acb902a790f33d95ba83ff5b4e1f442a7e25dd18))
* raise the stuck-operation threshold past Discord's token lifetime ([de7b8c6](https://github.com/thedorekaczynski/gronka/commit/de7b8c6098afe7517a6530bf896b42b8f9d6a069))
* report one user count in /info and the webui ([25acb66](https://github.com/thedorekaczynski/gronka/commit/25acb66dc0f724964d9293413cf689cae79349d9))
* **ytdlp:** stop the 1080p cap rejecting every portrait video ([734f10b](https://github.com/thedorekaczynski/gronka/commit/734f10bffdfa182b9848f23bcff2f3dd20a7f997))

## [0.27.0](https://github.com/thedorekaczynski/gronka/compare/v0.26.0...v0.27.0) (2026-07-26)


### ⚠ BREAKING CHANGES

* development and deployment now require Bun 1.3+ instead of Node 24. Contributors must run "bun install" and commit bun.lock.

### Features

* port gronka from node to bun ([#57](https://github.com/thedorekaczynski/gronka/issues/57)) ([7df18e8](https://github.com/thedorekaczynski/gronka/commit/7df18e82d0ceeaef6e87d13849517a8cd1502849))


### Bug Fixes

* **presence:** restore the saved custom status on restart ([e804e2d](https://github.com/thedorekaczynski/gronka/commit/e804e2d802aac2c7a0248ad33839467174d27bee))

## [0.26.0](https://github.com/thedorekaczynski/gronka/compare/v0.25.0...v0.26.0) (2026-07-25)


### Features

* **download:** support Xiaohongshu / RedNote links ([44c5f21](https://github.com/thedorekaczynski/gronka/commit/44c5f21d16091e83407af48107f346bca94f161a))


### Bug Fixes

* **download:** deliver carousels larger than Discord's attachment limit ([5d49dd5](https://github.com/thedorekaczynski/gronka/commit/5d49dd5e75a0cd9cbe08d541b14b870bd5603a6b))
* **download:** describe image-only posts accurately ([9fe227e](https://github.com/thedorekaczynski/gronka/commit/9fe227e2c798551b9da6bdbc21408a9e42068fc5))
* **download:** report oversized files as too large, not unavailable ([06359b1](https://github.com/thedorekaczynski/gronka/commit/06359b15dc5d2f7abc8346cf7ea45248bac3f000))

## [0.25.0](https://github.com/thedorekaczynski/gronka/compare/v0.24.1...v0.25.0) (2026-07-25)


### Features

* **download:** support yande.re and konachan booru posts ([78d6d6d](https://github.com/thedorekaczynski/gronka/commit/78d6d6d99b8b87145aa860318fc2e329081a49cf))


### Bug Fixes

* **download:** stop rejecting media whose duration yt-dlp can't read ([249a8f0](https://github.com/thedorekaczynski/gronka/commit/249a8f07e17c123c28259c7e59e7e21194abbcd7))
* **security:** close SSRF holes in the user-supplied URL fetch path ([03c2b01](https://github.com/thedorekaczynski/gronka/commit/03c2b01d4e90c2d352c7b2e678fac4385bb2c0ea))

## [0.24.1](https://github.com/thedorekaczynski/gronka/compare/v0.24.0...v0.24.1) (2026-07-21)


### Bug Fixes

* **db:** run additive column migrations before index creation ([f9d041a](https://github.com/thedorekaczynski/gronka/commit/f9d041a75c7eb07fd2f53f3e651856cc1dcd0dbf))
* **scripts:** set FORCE_PRODUCTION_MODE via cross-env, not in-script ([ba9625a](https://github.com/thedorekaczynski/gronka/commit/ba9625a227b19ecf2bda24e0d4a5eed33c4df8b4))
* **storage:** stop showing/serving R2 uploads after they've expired ([1fc9b13](https://github.com/thedorekaczynski/gronka/commit/1fc9b13f311f764cddb71e8bc494b4bcb816242a))

## [0.24.0](https://github.com/thedorekaczynski/gronka/compare/v0.23.0...v0.24.0) (2026-07-21)


### Features

* **webui:** add install, activation, and throughput stats to the dashboard ([cb93970](https://github.com/thedorekaczynski/gronka/commit/cb93970028552c4dd25965da9314809f3063641a))

## [0.23.0](https://github.com/thedorekaczynski/gronka/compare/v0.22.0...v0.23.0) (2026-07-18)


### Features

* **download:** add danbooru and e621 booru support ([#42](https://github.com/thedorekaczynski/gronka/issues/42)) ([4d79b00](https://github.com/thedorekaczynski/gronka/commit/4d79b00a39d1bc2fc14a0d794d7fb6048b8c0dfe))
* **download:** add hentaigifz.com support ([#38](https://github.com/thedorekaczynski/gronka/issues/38)) ([e298359](https://github.com/thedorekaczynski/gronka/commit/e29835956f336fb0556e5560047f523a54868436))
* **download:** add imgur, kick, coub, rumble, and more yt-dlp sites ([1278ba2](https://github.com/thedorekaczynski/gronka/commit/1278ba276c24f81aa659467a83424c53cb4ec51c))
* **download:** retry any failed Cobalt download via yt-dlp ([462c0ce](https://github.com/thedorekaczynski/gronka/commit/462c0cea4d4b4b2bb48c3f18e0708fbcb6b372db))
* **download:** support redgifs via yt-dlp ([#39](https://github.com/thedorekaczynski/gronka/issues/39)) ([edc9817](https://github.com/thedorekaczynski/gronka/commit/edc9817e6fb3531444cfd4e694a33abb351fc2d8))
* **webui:** add a Sources tab to turn download services on/off ([#43](https://github.com/thedorekaczynski/gronka/issues/43)) ([7ac26c5](https://github.com/thedorekaczynski/gronka/commit/7ac26c5b9817cef04e282f7d0861040fe07643a3))
* **webui:** move source toggles to a dedicated Sources page ([#44](https://github.com/thedorekaczynski/gronka/issues/44)) ([08996d3](https://github.com/thedorekaczynski/gronka/commit/08996d3ea0ed512869621e72ae39c1aa1a2efaf4))


### Bug Fixes

* **convert:** cap concurrent encodes and clamp default GIF size ([9e6c8fa](https://github.com/thedorekaczynski/gronka/commit/9e6c8fa43ffa064fcef4f41520adf82f1dec65da))
* **download:** drop Pinterest as a supported source ([2ee7753](https://github.com/thedorekaczynski/gronka/commit/2ee7753ac8c90c8f2e9bb578dd44eb1065faee31))

## [0.22.0](https://github.com/thedorekaczynski/gronka/compare/v0.21.0...v0.22.0) (2026-07-09)


### Features

* add data-deletion request template and script ([6368f96](https://github.com/thedorekaczynski/gronka/commit/6368f96d8fdc411ca0401339597c078c276bf538))
* **convert:** route animated WebP to GIF via ImageMagick ([010a928](https://github.com/thedorekaczynski/gronka/commit/010a92899cde1a71c2aa1c59389d4ca9761b10f2))
* **download:** add pinterest, twitch clips, and more cobalt services ([3997faa](https://github.com/thedorekaczynski/gronka/commit/3997faa96b3f803794ff0fc26ae4a08f5c7618e7))


### Bug Fixes

* **convert:** time out ffprobe and ffmpeg so malformed inputs fail fast ([b9a4225](https://github.com/thedorekaczynski/gronka/commit/b9a4225fa1846eecf389edc5a4536cf7d6352cbd))
* correct slash command descriptions ([3979425](https://github.com/thedorekaczynski/gronka/commit/397942578dd81d47c794cee5f1103361d397d561))
* **webui:** wrap long request values instead of overflowing the row ([f0676b4](https://github.com/thedorekaczynski/gronka/commit/f0676b4b1d603ce897cc8261c159e91d1a591951))

## [0.21.0](https://github.com/thedorekaczynski/gronka/compare/v0.20.0...v0.21.0) (2026-07-08)


### Features

* size-first download limits + live-editable max size ([#35](https://github.com/thedorekaczynski/gronka/issues/35)) ([d4b6fb4](https://github.com/thedorekaczynski/gronka/commit/d4b6fb426f579eb399f9695192638e7ee82c5237))

## [0.20.0](https://github.com/thedorekaczynski/gronka/compare/v0.19.0...v0.20.0) (2026-07-08)


### Features

* size-tiered R2 retention with soft storage guard ([#30](https://github.com/thedorekaczynski/gronka/issues/30)) ([0fc4fb5](https://github.com/thedorekaczynski/gronka/commit/0fc4fb573c9b40f34536ecc5db5eea578e80fdaf))
* **webui:** tabbed settings page with structured R2 tier editor ([4b77908](https://github.com/thedorekaczynski/gronka/commit/4b7790882bfedc0ef4d806140fd6a25d07147971))


### Bug Fixes

* **webui:** align settings page mobile layout with the shell breakpoint ([f7efe25](https://github.com/thedorekaczynski/gronka/commit/f7efe25cc9ca0e2e64c85b88adbab56eafc8e7e9))

## [0.19.0](https://github.com/thedorekaczynski/gronka/compare/v0.18.0...v0.19.0) (2026-07-07)


### Features

* add prefix commands with per-guild prefix, mention support, and help embed ([8efe96b](https://github.com/thedorekaczynski/gronka/commit/8efe96b177b757585d8ade18cb5705eabe739267))
* add prefix commands with per-guild prefix, mention support, and help embed ([518eb94](https://github.com/thedorekaczynski/gronka/commit/518eb94cf450f158f1f1988375698ad15acff7da))
* serve media from cdn.gronka.dev and stop trusting p1x.dev hostnames ([2c84b6c](https://github.com/thedorekaczynski/gronka/commit/2c84b6c4be00c83b1076179bdd3f97649a56d8ae))


### Bug Fixes

* expose client on the message adapter and default the prefix to ^g ([6928715](https://github.com/thedorekaczynski/gronka/commit/6928715cd33b9468c49e6d1064da6bfd6e3c4847))
* resolve codeql alerts for password hashing and test-code taint ([158b9b3](https://github.com/thedorekaczynski/gronka/commit/158b9b3efb9a2cb67103b3a6ace0c89f56111364))

## [0.18.0](https://github.com/thedorekaczynski/gronka/compare/v0.17.0...v0.18.0) (2026-07-07)


### Features

* accept timestamps (mm:ss / hh:mm:ss) in start_time and end_time options ([6b33963](https://github.com/thedorekaczynski/gronka/commit/6b33963f338ba2c9dbcd2b9ce1067d87b8eeec5c))
* add twitter delivery policy, admin upload ttl, and more settings ([193f8ec](https://github.com/thedorekaczynski/gronka/commit/193f8ec4fc46bf3beee9e20ad6bb3846e5422016))

## [0.17.0](https://github.com/thedorekaczynski/gronka/compare/v0.16.0...v0.17.0) (2026-07-06)


### Features

* add duration cap, admin list, and more to webui settings ([7ce1da1](https://github.com/thedorekaczynski/gronka/commit/7ce1da11c935af9877fd70149b3841cd4b0d63d8))
* reply with direct twitter media url when video exceeds download limits ([096c0ca](https://github.com/thedorekaczynski/gronka/commit/096c0ca54e4bd01641346c49890ec3191557c310))

## [0.16.0] - 2026-07-06

### Added

- yt-dlp cookies support + TikTok yt-dlp fallback for age-restricted posts (`9852649`)
- Download support for cunnyx.com, and the embed-fixer whitelist expanded to all known
  FxEmbed/vxtwitter mirror domains (`14505c0`, `c931140`)
- YouTube duration cap raised to 5 minutes; duration errors are now dynamic and point at the
  trim options (`06aa016`)
- User ban/moderation system (`dbfa17c`)
- webui: bot presence control on the Bot Settings page, including display of the bot's
  current presence (`d0c7163`, `b2ef3b1`)
- webui: alert components + per-user R2 stats endpoints (`c33c593`)
- webui: attachment upload links shown on Requests, with tightened Requests filters (`4d876db`)
- webui: SQL-backed request search, monitoring insights, and ntfy settings (`aecb3d7`)

### Changed

- webui real-time updates migrated from WebSocket to SSE (`242de99`); follow-ups: SSE
  heartbeats no longer trip the stale-connection check (`b18e15c`), benign SSE disconnects
  no longer logged as errors (`c71a953`)
- webui: Operations/OperationsDebug merged into a single Requests page (`75a2390`); alerts,
  logs, and moderation pages overhauled (`92e285d`); logs filter bar rebuilt into a unified
  toolbar (`b715fbc`)
- webui: app-shell UX upgrade — live connection status, persisted sidebar state, a11y
  improvements (`6c41466`)
- webui: delete confirmations removed on the moderation page (`f9fdf41`)
- Docker base image bumped to `node:24-slim`; `commit-msg` hook now strips AI attribution
  trailers (`e8a01ac`)
- `prettier-plugin-svelte` added and `.svelte` files reformatted (`ef6c5d4`); all of
  `src/public` gitignored (`faae553`); dotenv's promotional tip banner silenced (`74abc04`)
- Operational deploy-status notes dropped from this changelog (`074667c`)

### Removed

- webui monitoring page and its orphaned metrics endpoints (`b7d3181`), other dead webui
  endpoints and an orphaned route (`033d3a5`), and the unread system-metrics subsystem
  (`445e9ca`, `d8cac59`)

### Fixed

- Raw Postgres NOTICE objects no longer dumped to the console on startup (`b772422`)
- webui shows full log message text instead of a 2-line clamp (`3aa7474`)
- webui: reconstructed operations now flag missing step detail; reconstruction was running
  unawaited (`0458b7f`)
- `/download` operations now persist their source URL (`8aafe01`)
- yt-dlp: generic failures retried once; duration errors point at the trim options (`a5d14ea`)
- webui build: vite `outDir` emptied on build, broken favicon path fixed (`1dd2bb8`)
- webui-server no longer requires `DISCORD_TOKEN` to boot (`2060000`)
- `temporary_uploads` rows now cascade when their `processed_urls` row is deleted (`254ffd8`)
- webui: generic `.error` style no longer inflates error badges (`289bf02`); sidebar state
  persists when collapsed via Escape key (`587f3dd`)

## [0.15.6] - 2026-07-02

### Added

- webui-toggleable URL-only mode for downloads (`45af667`)

### Security

- CodeQL alerts resolved: rate limiting on webui-server + bot stats API routes, `Object.hasOwn`
  guard on `KNOWN_SETTINGS` lookup (prototype-pollution-shaped access), timing-safe basic-auth
  comparison (`4a30404`, `de564a5`)
- `undici` override bumped to `^6.27.0`, resolving 4 security advisories (`2d24e10`)
- dependabot security-updates group bump, 10 packages (`3d5a854`)

### Fixed

- Fixed a rotted `test:e2e` suite: `download.js` had picked up a `getCobaltMediaUrls` import
  (url-only mode) that the e2e module mock for `utils/cobalt.js` didn't provide, so all 4
  full-pipeline e2e tests failed at import time. Added the missing mock export (`46ab83f`)
- Cobalt queue dedup entry registered under the wrong key; now registered before the async
  cache check (`92e6bb7`)
- Sequence-reset race causing duplicate-key errors in CI (`c981fb4`), plus follow-up queue
  dedup / test-reset review findings (`35e58ca`)
- `pgrep` healthcheck replaced with a Node HTTP probe (`98443f8`)
- Cobalt cookie string format corrected in `cookies.example.json` and docs (`d3c5c78`)
- 13 lint issues flagged by a newer ESLint ruleset (`0960445`)
- Stale trimmed-buffer size fallback corrected; `convert.js` now uses `safeInteractionEditReply`
  for its Discord-attachment-upload path (`14c9b31`)
- `undici` pinned via `overrides`; socket-error retry added to `safeInteractionEditReply`,
  cherry-picked from the archived pre-fork history (`d8a733e`)

### Changed

- Wired `npm run test:e2e` into CI: a `test-e2e` job now runs on both GitHub Actions and
  GitLab CI (Node 24, Postgres service) on every push/MR — previously it was runnable only
  locally, which is how it rotted unnoticed (`46ab83f`)
- Removed dead subsystems: Jekyll/Cloudflare KV stats sync, per-call giflossy `docker run`
  (gifsicle now bundled in the app image, giflossy compose service dropped), cobalt rate-limit
  heuristics simplified to explicit 429/rate codes, operations tracker slimmed to lifecycle-only
  logging (`49c2956`)
- webui restyled onto shared design tokens with consistent text casing (`572efdb`)
- Test suite overhauled for speed and parallel-run reliability (`38c86c7`)
- CI: actions bumped to Node24-based majors (`7455e26`); Blacksmith runners reverted to
  GitHub-hosted `ubuntu-latest` (`9c60bf4`); `workflow_dispatch` added to CodeQL for manual
  re-runs (`b04ddd8`)
- Decluttered the project root: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and `security.md`
  (renamed `SECURITY.md`) moved into `.github/`, where GitHub surfaces them natively.
  `npm run fetch:security` now writes to `logs/code-scanning-issues.json` instead of the repo
  root. The old `plan.md` was archived to `docs/archive/` (gitignored, local-only) (`e40b2fe`)
- `TODO.md` is now gitignored — it's a local scratch handoff (current state, ranked next
  steps, backlog), not a tracked project artifact. Trimmed its contents to match: dropped
  sections that duplicated `CLAUDE.md`'s dev-loop/rules/architecture documentation.

## [0.15.5] - 2026-07-01

### Security

- **npm dependency update**: `npm update` bumped all dependencies to the latest semver-compatible
  versions, resolving 43 of 47 known vulnerabilities (47 → 4; 3 critical and 14 of 15 high fixed).
  `package.json` unchanged (existing `^` ranges), `package-lock.json` only. (`d4d0d45`)
- **Remaining 4 vulnerabilities (3 moderate, 1 high) are accepted, upstream-only risk**: a transitive
  `undici@6.24.1` pinned by `discord.js@14.26.4` (the latest available release) via
  `@discordjs/rest`/`@discordjs/ws`. `npm audit fix --force` "fixes" this by downgrading to
  `discord.js@13.x`, a breaking API change — not applied. `undici` here is discord.js's own outbound
  HTTP/WS client to Discord's API only, not attacker-facing.

### Fixed

- Corrected three inaccurate entries that had been added to this changelog under `[0.15.4]` without
  matching code ever landing: a claimed `npm run backlog` script (no such script exists), claimed
  `AGENTS.md`-searching behavior in the bot (no such file or code exists in this repo), and a claimed
  "double-count operations on rate-limited requests" fix that doesn't correspond to any change in
  `run-media-command.js`/`command-guards.js`. Removed all three from the `[0.15.4]` entry below since
  they never happened.
- Bumped `package.json`/`package-lock.json` version from `0.15.3` straight to `0.15.5` — the
  `[0.15.4]` entry below had been written and dated (`a04aac8`, 2026-06-26) but the version bump
  itself was never applied to `package.json`, so it had drifted out of sync with the changelog. Since
  this bot is deployed via Docker (not published to npm) and both `0.15.4`'s and `0.15.5`'s changes
  are already fully present in this commit, there is no meaningful distinct `0.15.4` build to bump
  to separately.

## [0.15.3] - 2026-06-26

> Previously mislabeled 0.15.4 — `package.json` was bumped to 0.15.3 for this release
> and 0.15.4 never shipped.

### Added

- Download command full-pipeline E2E tests with module-mocked network boundary
  - `test/commands/download-e2e.test.js` (new file)
  - `test:e2e` npm script (`--experimental-test-module-mocks`)
  - Tests: single-file video → Discord attachment, multi-file picker → multiple attachments, deleted post → curated error, URL cache-hit → CDN URL reply
  - Uses a throwaway temp storage directory per run for filesystem-level isolation
  - Gracefully skips under the main `test:safe` suite when the mock flag is absent

### Changed

- `plan.md` gitignored — `TODO.md` is the canonical handoff

### Fixed

- **yt-dlp error message curation**: user-facing `NetworkError`s in `src/utils/ytdlp.js` no longer leak raw internals
  - "yt-dlp output path is not a file: `/tmp/...`" → generic `yt-dlp output path is not a file`
  - "output file too small (123 bytes)" → generic `yt-dlp segment download failed: output file too small`
  - The byte count is dropped but the `output file too small` substring is preserved so the ffmpeg fallback signal at line ~474 still fires

### Refactored

- **Dedupe rate-limit guard** (`b1de34f`): extracted the ~7-line rate-limit-check-and-reply block duplicated in all six `handle*` functions into `src/commands/shared/command-guards.js` (`replyIfRateLimited`)
- **Migrate download to runMediaCommand wrapper** (`06f4f1c`): Phase 3 complete
- **Migrate convert to runMediaCommand wrapper** (`139e8a1`): Phase 3, part 2
- **Add reply-agnostic runMediaCommand wrapper; migrate optimize** (`4a36e87`): Phase 3, part 1
- **Extract shared url-cache write helpers** (`c4a1053`): Phase 2
- **Extract shared buffer-validation + curated-error helpers** (`bce8f5f`)
- **Consolidate cleanupTempFiles** (`5e088a2`): download.js local wrapper now delegates file deletion to shared `storage.cleanupTempFiles`; only the `tmpDir.removeCallback()` stays in the local wrapper

### Fixed (previous, grouped)

- CodeQL warnings fixed, CI env vars corrected (`fbc25cf`)
- isTwitterXUrl referenceError resolved; X/Twitter yt-dlp fallback wired up (`807bd45`)
- Operations-tracker test suite made deterministic (`0dde377`)
- Version bumped to 0.15.3 and shown as `/stats` footer (`0085063`)

## [0.15.1] - 2025-12-08

### Added

- Added unit tests for `yt-dlp` integration and cleanup utilities
- Added configurable `DISCORD_SIZE_LIMIT` to configuration
- Added `scripts/fix-docker-credentials.sh` script for Docker credential management

### Changed

- Updated CodeQL actions to v4
- Enforced consistent LF line endings via `.gitattributes`
- Applied Prettier formatting to codebase (78 files)
- Fixed executable permissions for shell scripts
- Updated documentation with yt-dlp prerequisites

## [0.15.0] - 2025-12-08

### Added

- yt-dlp integration for YouTube downloads
  - Added new utility module `src/utils/ytdlp.js` for YouTube video downloads via yt-dlp
  - Added `YTDLP_ENABLED` and `YTDLP_QUALITY` configuration options
  - YouTube downloads now use yt-dlp instead of being blacklisted
  - Supports quality selection (1080p max for regular users, unlimited for admins)
  - Added yt-dlp installation to Dockerfile runtime stage

### Changed

- YouTube URLs now use yt-dlp for downloads instead of being blacklisted
- Updated download command to route YouTube URLs to yt-dlp
- Updated wiki documentation to reflect yt-dlp integration for YouTube

## [0.14.3] - 2025-12-06

### Added

- Docker support for Cloudflare KV stats sync
  - Added Cloudflare environment variables to docker-compose.yml (API_TOKEN, ACCOUNT_ID, KV_NAMESPACE_ID, PAGES_PROJECT_NAME)
  - Added `kv:sync-stats:docker` npm script for running KV sync from within Docker containers
  - Improved sync-stats-to-kv.js to handle Docker environment where .env file may not be mounted
  - Enhanced PROD\_\* variable mapping to work with docker-compose.yml environment variable structure

### Changed

- Improved PostgreSQL connection handling for production scripts
  - Enhanced `getDefaultPostgresHost()` to respect explicit POSTGRES_HOST when FORCE_PRODUCTION_MODE is set
  - Allows production scripts (like KV sync) to connect to correct host even when running locally
  - Better logging for host resolution decisions

### Dependencies

- Security updates (from dependabot)
  - `@aws-sdk/client-s3`: `3.940.0` → `3.946.0`
  - `@aws-sdk/lib-storage`: `3.940.0` → `3.946.0`
  - `prettier`: `3.7.3` → `3.7.4`
  - `svelte`: `5.45.2` → `5.45.6`
  - `lucide-svelte`: `0.555.0` → `0.556.0`
  - `vite`: `7.2.6` → `7.2.7`

## [0.14.2] - 2025-12-05

### Changed

- optimized Dockerfile with multi-stage build to reduce image size and build time
  - separated builder stage (with build tools) from runtime stage (production-only dependencies)
  - replaced docker-ce-cli package installation with lightweight Docker CLI binary copy from official Docker image
  - eliminated unnecessary Docker repository setup (gnupg, lsb-release, curl for repo key)
  - build tools (python3, make, g++) no longer included in final runtime image
  - devDependencies automatically excluded through stage separation
  - improved layer caching strategy for faster rebuilds
  - no functional changes, fully backward compatible

### Fixed

- Fixed PostgreSQL initialization race conditions in parallel test execution
  - Added error handling for index conflicts (error 23505) during database initialization
  - Added error handling for table conflicts (error 42P07) when tables already exist
  - Fixed order of operations: drop tables before dropping types to prevent dependency errors
  - Made database initialization fully idempotent for parallel test runs
  - Fixed GitHub Actions test jobs by adding missing WEBUI_PORT=3101 environment variable

### Changed

- Migrated GitHub repository to gronkanium organization
  - Updated all GitHub references from thedorekaczynski to gronkanium organization
  - Updated package.json author field, README badges, and documentation links
  - Updated CHANGELOG version comparison links and Jekyll site references
  - GitLab remote remains unchanged as primary development remote

### Fixed

- Fixed Jekyll site routing and documentation structure
  - Removed \_redirects and \_headers files to fix redirect loop on privacy/terms pages
  - Removed docs from Jekyll site, using GitHub wiki exclusively for documentation
  - Added Cloudflare Pages routing configuration for /docs/ path

## [0.14.0] - 2025-12-03

### Removed

- **BREAKING**: Removed all SQLite database support
  - SQLite is no longer supported as a database backend
  - PostgreSQL is now the only supported database
  - Removed `GRONKA_DB_PATH` environment variable (no longer needed with PostgreSQL)
  - Removed `DATABASE_TYPE` environment variable (no longer needed - always PostgreSQL)
  - Removed SQLite-related code from `scripts/bot-start.js`
  - Removed SQLite references from `docker-compose.yml`
  - Removed SQLite references from test scripts in `package.json`
  - Removed legacy file-based database path logic
  - Test/prod database isolation now done via PostgreSQL database names (`TEST_POSTGRES_DB` vs `POSTGRES_DB`)
  - Migration: users must migrate to PostgreSQL before upgrading to v0.14.0 (see v0.13.0 changelog for migration script)

### Changed

- Simplified database configuration
  - Database configuration now exclusively uses PostgreSQL connection parameters
  - Test mode detection simplified to use `NODE_ENV` instead of database file paths
  - Removed database file path checks from `src/utils/logger.js` and `src/utils/operations-tracker.js`

### Documentation

- Updated all documentation to remove SQLite references
  - Removed `GRONKA_DB_PATH` configuration from all wiki pages
  - Updated blog posts with SQLite deprecation notices
  - Clarified that PostgreSQL is now required
  - Updated configuration examples to show PostgreSQL-only setup

### Added

- Enhanced clean-slate reset script to wipe PostgreSQL databases
  - Updated `scripts/reset-clean-slate.js` to drop all PostgreSQL tables when PostgreSQL is configured
  - Script now handles both database types: drops PostgreSQL tables and deletes SQLite database files
  - Added `wipePostgresDatabase()` function that connects to PostgreSQL and drops all tables in correct order
  - Supports both `DATABASE_URL` and individual PostgreSQL connection parameters
  - Gracefully handles cases where PostgreSQL is not configured or connection fails
  - Updated messaging to clearly indicate both databases are being wiped
- Minimal HTTP stats server built into bot process
  - Bot now includes a lightweight Express server for `/api/stats/24h` endpoint
  - Only serves stats endpoint for Jekyll site integration
  - No file serving - all files served from R2 or Discord
  - Supports basic authentication via `STATS_USERNAME` and `STATS_PASSWORD`
  - Configurable via `SERVER_PORT` and `SERVER_HOST` environment variables

### Changed

- **BREAKING**: Removed standalone server.js and simplified architecture
  - Architecture reduced from 3 processes to 2 processes (bot + webui)
  - Removed `src/server.js` - functionality moved to bot process
  - Bot process now includes minimal HTTP server for stats endpoint only
  - WebUI now calculates stats directly from database and filesystem instead of proxying HTTP requests
  - Docker healthcheck changed from HTTP check to process-based check
  - Updated all startup scripts: `docker-entrypoint.sh`, `bot-start.js`, `local-up.js`, `local-verify.js`
  - Removed `npm run server` script from package.json
  - Files no longer served via HTTP - only from R2 or Discord attachments
  - Migration: existing deployments will automatically work with new architecture, no manual changes needed
- Removed `MAIN_SERVER_URL` configuration variable
  - WebUI no longer needs `MAIN_SERVER_URL` environment variable
  - Stats and health data calculated directly instead of via HTTP proxy
  - Simplified configuration and eliminated port mismatch issues
  - Removed from `webuiConfig` in `src/utils/config.js`
- Simplified server configuration
  - `SERVER_PORT` and `SERVER_HOST` now only used for bot's minimal stats HTTP server
  - Removed unused `CORS_ORIGIN` from server config
  - Configuration is now focused on stats endpoint only

### Documentation

- Updated wiki documentation for new architecture
  - Rewrote `wiki/API-Endpoints.md` to reflect new stats-only HTTP server
  - Updated `wiki/Configuration.md` with simplified server configuration
  - Updated `wiki/Installation.md` to remove server.js startup instructions
  - Updated `wiki/Technical-Specification.md` to mark CDN server as deprecated
  - Updated `wiki/Jekyll-Stats.md` to reflect bot's built-in stats endpoint
  - Added migration notes and version information throughout documentation

### Fixed

- Fixed PostgreSQL test failures after SQLite to PostgreSQL migration
  - Fixed timestamp comparison issues by switching from strict equality to approximate matching (1 second tolerance)
  - Fixed duplicate key violations in logs by ensuring unique timestamps and component names for each test
  - Fixed user count mismatches by using unique user IDs per test run to prevent conflicts with previous test data
  - Fixed connection handling in `insertProcessedUrl` to gracefully handle closed database connections
  - Added cache invalidation in test setup to prevent stale data from previous test runs
  - Updated test files: `test/utils/database.test.js`, `test/utils/user-tracking.test.js`, `test/utils/log-metrics.test.js`
  - Updated database function: `src/utils/database/processed-urls-pg.js` for better error handling
- Fixed WebUI "invalid date" errors for timestamps after PostgreSQL migration
  - PostgreSQL's `postgres.js` library returns BIGINT values as strings instead of numbers
  - WebUI was showing "invalid date" because `new Date(timestamp)` failed when timestamp was a string
  - Created helper functions in `src/utils/database/helpers-pg.js` to convert timestamp fields from strings to numbers
  - Updated all PostgreSQL query functions to convert timestamps before returning:
    - `logs-pg.js` - Converts `timestamp` in `getLogs()` and `getLogMetrics()`
    - `alerts-pg.js` - Converts `timestamp` in `getAlerts()` and `insertAlert()`
    - `operations-pg.js` - Converts `timestamp` in `getOperationLogs()`, `getOperationTrace()`, and `getRecentOperations()` (including nested timestamps in performance metrics steps)
    - `metrics-pg.js` - Converts `timestamp` in `getSystemMetrics()`, `getLatestSystemMetrics()`, and `last_command_at`/`updated_at` in `getUserMetrics()` and `getAllUsersMetrics()`
    - `users-pg.js` - Converts `first_used` and `last_used` in `getUser()`
    - `processed-urls-pg.js` - Converts `processed_at` in `getProcessedUrl()`, `getUserMedia()`, and `getUserR2Media()`
  - All timestamps are now returned as numbers, allowing `new Date()` to parse them correctly
  - WebUI now displays timestamps correctly instead of showing "invalid date"
- Fixed WebUI API empty responses after Postgres migration
  - Fixed critical async/await bug in `src/webui-server/index.js` where `getRecentOperations()` was called without `await` during server startup
  - Operations were not loading from Postgres database at startup, causing empty responses
  - Added proper validation to ensure operations array is valid before processing
  - Enhanced error handling in route handlers (`users.js`, `logs.js`, `metrics.js`) with null/undefined checks
  - Added comprehensive error logging with stack traces for debugging database query failures
  - All endpoints now properly handle async database queries and return correct data types (arrays/numbers instead of empty objects)
  - WebUI API endpoints now return proper JSON responses with data instead of empty `{}` objects

## [0.13.0] - 2025-12-01

### Added

- PostgreSQL database support with SQLite deprecation path
  - Complete PostgreSQL migration implementation
  - Database abstraction layer to route to PostgreSQL
  - PostgreSQL connection pooling and async query support
  - New PostgreSQL-specific modules in `src/utils/database/`:
    - `connection-pg.js` - PostgreSQL connection management
    - `init-pg.js` - PostgreSQL schema initialization
    - `logs-pg.js`, `users-pg.js`, `operations-pg.js`, `metrics-pg.js`, `alerts-pg.js`, `processed-urls-pg.js`, `temporary-uploads-pg.js` - PostgreSQL implementations
  - Migration script: `scripts/migrate-sqlite-to-postgres.js` for seamless data migration
  - PostgreSQL debugging and testing utilities:
    - `scripts/debug-postgres-queries.js` - Query debugging tool
    - `scripts/reset-postgres-sequences.js` - Sequence reset utility
    - `scripts/test-database-wrapper.js` - Database wrapper testing
    - `scripts/test-get24HourStats.js` - Stats testing utility
    - `scripts/test-getAllUsersMetrics.js` - Metrics testing utility
  - **Note**: SQLite was deprecated in this version and removed completely in v0.14.0

### Changed

- **Critical fix**: Fixed async database write issues
  - Resolved critical bug where code was still using synchronous SQLite writes even after switching to PostgreSQL
  - Updated all database operations to use async PostgreSQL API consistently
  - Fixed database operation failures caused by sync/async mismatch
  - All webui-server routes and operations now use async database calls
  - Operations tracker and stats utilities updated for PostgreSQL async support
- Updated all tests to use async database API
  - Fixed test failures caused by synchronous database calls
  - Updated `test/utils/database.test.js`, `test/utils/user-tracking.test.js`, `test/utils/log-metrics.test.js`, `test/utils/logger.test.js`, `test/utils/logger-sanitization.test.js`, `test/webui-server-operations.test.js`
  - All tests now properly await async database operations
  - Added defensive assertions to `test/utils/operations-tracker.test.js` for better reliability

### Dependencies

- Security updates (from dependabot PR #12):
  - `@aws-sdk/client-s3`: `3.937.0` → `3.940.0`
  - `@aws-sdk/lib-storage`: `3.937.0` → `3.940.0`
  - `better-sqlite3`: `12.4.6` → `12.5.0` (removed in v0.14.0)
  - `lucide-svelte`: `0.554.0` → `0.555.0`
  - `prettier`: `3.6.2` → `3.7.3`
  - `svelte`: `5.43.14` → `5.45.2`
  - `vite`: `7.2.4` → `7.2.6`

### Deprecated

- SQLite database support (removed completely in v0.14.0)
  - All users should migrate to PostgreSQL using the provided migration script
  - `GRONKA_DB_PATH` environment variable (replaced by PostgreSQL connection parameters)
  - `DATABASE_TYPE` environment variable (PostgreSQL becomes the only option)

### Fixed

- Fixed failing CI test in `operations-tracker.test.js`
  - Added defensive assertions to ensure operation and step exist before accessing properties
  - Improved test reliability with better error messages

## [0.13.0-prerelease] - 2025-11-30

### Added

- Cloudflare KV and Pages integration for stats
  - Cloudflare KV storage for stats synchronization
  - Automated stats sync from bot server to Cloudflare KV
  - Cloudflare Pages build integration to fetch stats from KV
  - New scripts: `sync-stats-to-kv.js`, `fetch-stats-from-kv.js`
  - Validation and testing scripts: `validate-cloudflare-config.js`, `test-cloudflare-kv.js`
  - New npm scripts: `kv:sync-stats`, `kv:fetch-stats`, `validate:cloudflare`, `test:cloudflare`
  - Comprehensive documentation in `wiki/Cloudflare-Pages-Deployment.md`
  - Stats automatically update in Jekyll site footer via Cloudflare Pages builds

### Changed

- Refactored webui-server.js into modular structure
  - Broke down monolithic `src/webui-server.js` into focused modules organized in `src/webui-server/` subdirectory
  - Created separate modules for different webui concerns:
    - `webui-server/app.js` - Express app setup and configuration
    - `webui-server/index.js` - Main entry point and server startup
    - `webui-server/cache/` - Caching utilities (crypto-cache, stats-cache)
    - `webui-server/middleware/` - Express middleware (security, static file serving)
    - `webui-server/operations/` - Operation-related utilities (enrichment, reconstruction, storage)
    - `webui-server/routes/` - API route handlers (alerts, logs, metrics, moderation, operations, proxy, users)
    - `webui-server/utils/` - Utility functions (auth, validation)
    - `webui-server/websocket/` - WebSocket server implementation (broadcast, handlers, server)
  - Maintained backward compatibility by keeping main `src/webui-server.js` as a thin wrapper that imports from the modular structure
  - All existing npm scripts and imports continue to work without modification
  - Improved code organization, maintainability, and testability
  - No breaking changes - API and functionality remain identical

## [0.12.5] - 2025-11-29

### Added

- Quality parameter to `/convert` command
- Jekyll site footer statistics display
  - 24-hour activity statistics displayed in Jekyll site footer
  - Shows unique users, total files processed, and total data processed in the past 24 hours
  - Automatic stats polling via `scripts/update-jekyll-stats.js`
  - Integration with `scripts/update-jekyll-site.sh` to update stats before each build
  - New API endpoint `/api/stats/24h` for fetching 24-hour activity statistics
  - New environment variable `BOT_API_URL` for configuring bot server API URL
  - Stats display with proper singular/plural grammar handling
  - Graceful error handling - site builds even if stats update fails
  - Added `quality` option to `/convert` command with choices: low, medium, high
  - Allows users to specify GIF quality preset per conversion
  - Defaults to medium quality when not specified

### Changed

- Refactored database.js into modular structure
  - Broke down monolithic `src/utils/database.js` (1948 lines) into focused modules organized in `src/utils/database/` subdirectory
  - Created separate modules for different database concerns:
    - `database/connection.js` - Database connection state management and shared utilities
    - `database/init.js` - Database initialization and schema management
    - `database/logs.js` - Log-related operations (insertLog, getLogs, getLogsCount, getLogComponents, getLogMetrics)
    - `database/users.js` - User-related operations (insertOrUpdateUser, getUser, getUniqueUserCount)
    - `database/processed-urls.js` - Processed URL operations (getProcessedUrl, insertProcessedUrl, getUserMedia, getUserR2Media, deleteProcessedUrl, deleteUserR2Media)
    - `database/operations.js` - Operation tracking (insertOperationLog, getOperationLogs, getOperationTrace, getRecentOperations, getStuckOperations, markOperationAsFailed)
    - `database/metrics.js` - Metrics operations (insertOrUpdateUserMetrics, getUserMetrics, getAllUsersMetrics, insertSystemMetrics, getSystemMetrics)
    - `database/alerts.js` - Alert operations (insertAlert, getAlerts, getAlertsCount)
  - Maintained backward compatibility by keeping main `src/utils/database.js` as a barrel export that re-exports all functions from submodules
  - All existing imports continue to work without modification
  - Improved code organization, maintainability, and testability
  - No breaking changes - function signatures remain identical
- Refactored video-processor.js into modular structure
  - Broke down monolithic `src/utils/video-processor.js` (549 lines) into focused modules organized in `src/utils/video-processor/` subdirectory
  - Created separate modules for different video processing operations:
    - `video-processor/utils.js` - Shared utilities (validateNumericParameter, checkFFmpegInstalled)
    - `video-processor/convert-to-gif.js` - Video to GIF conversion
    - `video-processor/convert-image-to-gif.js` - Image to GIF conversion
    - `video-processor/trim-video.js` - Video trimming functionality
    - `video-processor/trim-gif.js` - GIF trimming functionality
    - `video-processor/metadata.js` - Video metadata extraction
  - Maintained backward compatibility by keeping main `src/utils/video-processor.js` as a barrel export that re-exports all functions from submodules
  - All existing imports continue to work without modification
  - Improved code organization, maintainability, and testability
  - No breaking changes - function signatures remain identical
- Default GIF quality changed from high back to medium
  - Quality default reverted to medium for better balance between file size and quality
  - Applies to all conversions when quality parameter is not specified
  - Configurable via `GIF_QUALITY` environment variable

### Fixed

- Code scanning issues
  - Fixed code scanning alerts and warnings
- Code cleanup
  - Removed unused imports in race-conditions test

## [0.12.4] - 2025-11-27

### Added

- GIF and video trimming functionality
  - Added `start_time` and `end_time` parameters to `/convert` and `/download` commands
  - Support for trimming GIFs and videos before processing
  - Comprehensive test coverage for trimming functionality
- Video trimming support for `/convert` command

### Changed

- CI/CD pipeline improvements
  - Restructured GitLab CI with multiple descriptive stages (setup, validate, test:utils, test:commands, test:scripts, test:integration)
  - Restructured GitHub Actions to match GitLab CI structure with segmented test execution
  - Tests now run in parallel across separate jobs for better visibility and faster feedback
  - Improved test organization and categorization
- Docker production configuration now explicitly uses data-prod directories
  - Updated docker-compose.yml to set `GRONKA_DB_PATH` using `PROD_GRONKA_DB_PATH` environment variable (defaults to `./data-prod/gronka.db`)
  - Updated docker-compose.yml to set `GIF_STORAGE_PATH` using `PROD_GIF_STORAGE_PATH` environment variable (defaults to `./data-prod/gifs`)
  - Production Docker containers now write to `data-prod` directory instead of deprecated `data` directory
  - Ensures production data is isolated from test data and prevents test users from polluting production database
- Simplified docker-up script
  - Removed container status verification loop from docker-up.ps1
  - Script now starts containers and exits immediately without verification delays
  - Faster startup experience for development
- WebUI layout improvements for better readability and visual hierarchy
  - Added max-width constraints (1400px) to main content areas to prevent edge-to-edge stretching
  - Centered content on large screens with automatic margins
  - Improved table column sizing with min/max width constraints for better readability
  - Enhanced responsive design with better breakpoint handling
  - Optimized card and section layouts across all pages (Users, Operations, Logs, Monitoring, Stats, Health)
  - Better text overflow handling with ellipsis and word wrapping
  - Improved spacing and visual hierarchy throughout the interface
- Code refactoring and cleanup
  - Replaced MAX_GIF_WIDTH and DEFAULT_FPS with GIF_QUALITY preset system
  - Cleanup of unused code and configuration inconsistencies
  - Improved code organization and maintainability

### Fixed

- Fixed useless conditional checks flagged by GitHub Advanced Security
  - Removed always-false conditionals related to `treatAsGif` variable in GIF handling code
  - Simplified code logic in download command
- Fixed missing `tmp` package in production Docker builds
  - Moved `tmp` package from devDependencies to dependencies in package.json
  - Package is required by production code (`src/commands/download.js`) but was being removed by `npm prune --production`
  - Resolves bootloop issue where containers failed to start with "Cannot find package 'tmp'" error
- Fixed webui health check 500 error
  - Created missing `data-prod/gifs` directory in Dockerfile
  - Health check endpoint now passes when storage directory exists
  - Updated Dockerfile to create both `data-prod/gifs` and `data-test/gifs` directories for future builds
- Fixed storage directory creation for test and production environments
  - Updated server health check to automatically create storage directory if it doesn't exist
  - Server now creates `data-test/gifs` or `data-prod/gifs` directories automatically on startup
  - Prevents 500 errors on `/api/health` endpoint when directories are missing
  - Works for both `bot:test:webui` and `bot:prod:webui` commands
- Fixed video trimming and file type cache validation issues
- Fixed operations tracker test failures - fixed duration calculation test and variable initialization order
- Fixed CI/CD test job failures - use npx cross-env in test jobs to fix command not found error

### Removed

- Deferred downloads feature
  - Removed deferred download queue system that was never used in practice
  - Removed deferred download notification handlers
  - Removed "try again later" button UI from rate limit error messages
  - Removed test suite for deferred download functionality (453 test lines)
  - Rate limit errors now show a simple error message instructing users to try again later
  - Removed 1556 lines of code across 7 files (queue system, notifiers, tests, and related integrations)
  - Simplifies codebase by removing unused functionality that added unnecessary complexity

## [0.12.3-beta] - 2025-11-26

### Added

- Cookie authentication support for Cobalt restricted content
  - Added cookies.example.json with Twitter, Instagram, and Reddit cookie format examples
  - Updated docker-compose.yml to enable COOKIE_PATH and volume mount for cookies.json
  - Comprehensive documentation in Docker-Deployment.md covering setup, supported services, error handling, and security considerations
  - Enables Cobalt to access content requiring authentication from social media platforms
- R2 moderation system for managing user uploads
  - New moderation page in WebUI for viewing and managing user uploads stored in R2
  - Support for filtering and searching user media by file type
  - Pagination support for user list and media display
- Comprehensive test suite additions
  - Added tests for operations tracker, deferred download notifier, and operations search APIs
  - Improved test coverage for operation duration and status tracking
- Buffer size validation for video downloads
  - Added validation to ensure video buffers meet size requirements before processing
- Info-level logging for Discord uploads
  - Enhanced logging to include URLs when files are uploaded to Discord

### Changed

- Pre-commit hook improvements
  - Hook now automatically fixes formatting and linting issues when possible
  - Improved developer experience with auto-fix capabilities
- Video download limit reduction
  - Reduced maximum video download size from 500MB to 100MB
  - Updated tests to reflect new limit
- Pagination improvements
  - Added pagination to moderation page user list
  - Improved media pagination in moderation interface
- GitHub repository URL updates
  - Updated repository references to reflect current GitHub organization

### Fixed

- Discord URL tracking in database
  - Fixed issue where Discord attachment URLs were not being saved to database when files uploaded to Discord
  - Now properly captures Discord attachment URLs for tracking
- Operation duration calculation
  - Ensured operation duration is always at least 1ms to prevent zero-duration operations
  - Fixed test timing issues related to duration calculations
- Test mocks and assertions
  - Corrected test mocks for Discord.js Collection API
  - Fixed duration assertion issues in test suite
- R2 URL database storage
  - Fixed issue where R2 URLs were being saved to database even when files were not actually uploaded to R2
  - Only saves R2 URLs when files are successfully uploaded
- Log verbosity reduction
  - Reduced unnecessary log verbosity in various components

## [0.12.2-beta] - 2025-11-25

### Added

- Discord upload support for cached GIFs
  - Cached GIFs under 8MB are now uploaded as Discord attachments instead of URLs
  - Provides better user experience with direct file previews for cached conversions
  - Automatic fallback to R2 URL if Discord upload fails
- Operations search and debug page
  - New advanced operations search endpoint with filtering capabilities
  - New OperationsDebug page in WebUI for searching and filtering operations
  - Support for filtering by operation ID, status, type, user, URL pattern, date range, duration, and file size
  - Related operations endpoint for finding operations with matching URLs

### Changed

- Default quality setting changed from medium to high
  - All new conversions now default to high quality unless user specifies otherwise
  - Applies to convert and optimize commands
- Pre-commit hook optimization
  - Hook now only checks staged files instead of all files
  - Faster commit times by skipping checks on unchanged files
  - Only runs check:sync when package files are staged
  - Only runs linting on JavaScript/TypeScript files
  - Only runs formatting checks on Prettier-supported files
- GIF quality improvements
  - Use floyd-steinberg dithering for better color accuracy
  - Improved palette generation for better visual quality
- Operations tracking enhancements
  - Multi-instance support for operations tracking (supports multiple WebUI instances)
  - Enhanced logging with detailed operation steps for optimize command
  - Better operation step tracking with metadata
- WebUI styling improvements
  - Improved log level toggle button styling and compactness
  - Better table layout and spacing in user profile operations table
  - Enhanced error display formatting
  - Improved trace step display with better empty state handling

### Fixed

- Palette generation compatibility
  - Removed stats_mode=single from palettegen to fix compatibility issues with some FFmpeg versions
- GIF optimizer logging verbosity
  - Reduced logging verbosity by changing info-level logs to debug for path conversion details

## [0.12.1-beta] - 2025-11-25

### Added

- GitHub issue templates
  - Added issue templates for bug reports, feature requests, and other common issue types

### Changed

- Reorganized webui files into structured folders
  - Improved code organization and maintainability
- Updated repository references from p2xai to thedorekaczynski
  - Updated all repository references to reflect new organization name

### Fixed

- CodeQL false positives suppression
  - Suppressed false positive alerts for log injection and network-to-file access
- CodeQL security issues
  - Resolved log injection vulnerabilities
  - Fixed network data validation issues
- CodeQL-recognized sanitization patterns
  - Applied CodeQL-recognized sanitization patterns for log injection prevention
- CodeQL security vulnerabilities and warnings
  - Resolved additional CodeQL security vulnerabilities and warnings

### Dependencies

- Bumped body-parser from 2.2.0 to 2.2.1

### Removed

- Deleted wiki-repo
  - Removed wiki repository from project structure

## [0.12.0-prerelease] - 2025-11-25

### Added

- Test and production bot support with environment variable prefixes
  - Support for `TEST_*` and `PROD_*` prefixed environment variables for running separate test and production bots
  - New `bot-start.js` script that handles TEST/PROD prefixes and maps prefixed env vars to standard names
  - `register-commands.js` now supports TEST/PROD prefixes for command registration
  - Separate database files: `gronka-test.db` and `gronka-prod.db` for isolated data storage
  - New npm scripts for bot management:
    - `bot:test` / `bot:prod` - Start test or production bot
    - `bot:test:webui` / `bot:prod:webui` - Start bot with webui server
    - `bot:test:dev` / `bot:prod:dev` - Start bot with watch mode for development
    - `bot:register:test` / `bot:register:prod` - Register Discord commands for test or production bot
  - Support for prefixed configuration variables (e.g., `TEST_ADMIN_USER_IDS`, `PROD_CDN_BASE_URL`, `TEST_R2_BUCKET_NAME`)
  - Allows running both test and production bots simultaneously with independent configurations
- Local development scripts
  - Cross-platform scripts for managing local development environment
  - Similar to docker scripts but for local development
  - Scripts for starting, stopping, restarting, and verifying local services
- Wiki documentation and cloudflared configuration
  - Added wiki documentation structure
  - Cloudflared tunnel configuration for local development

### Security

- Shell metacharacter validation in optimize command
  - Added validation to prevent command injection via file paths in gif-optimizer.js
  - Checks for dangerous shell metacharacters in input and output paths
  - Throws ValidationError if invalid characters are detected

### Fixed

- Ntfy.sh notifications now properly contain duration metadata
  - Fixed operation ID handling through the notification pipeline
  - Duration information now correctly passed to ntfy notifications
- CSS asset loading through cloudflared tunnel
  - Fixed 404 errors for CSS assets when using cloudflared tunnel
  - Updated to use relative_url for CSS assets
- Privacy and terms documentation updates
  - Updated documentation for accuracy

### Changed

- **BREAKING**: Default upload strategy changed from R2-first to Discord-first
  - Files now default to Discord attachments for better user experience
  - Falls back to R2 storage for files larger than 8MB
  - Affects all commands: convert, download, optimize
  - Provides direct file previews in Discord for smaller files
- Docker configuration updates
  - Updated docker-compose.yml with new environment variable structure
  - Added data-test and data-prod volume mounts for separate test/prod data storage
  - Updated default environment variable handling for PROD/TEST prefixes
- Jekyll posts now tracked in git
- Updated .gitignore to exclude prod/test data folders
- Improved markdown formatting across documentation files
- Removed .cloudflared/config.yml from git tracking (now in .gitignore)

## [0.11.4-prerelease] - 2025-11-24

### Added

- Discord attachment support for files under 8MB
  - Files smaller than 8MB are now sent as Discord attachments instead of URLs
  - Provides better user experience with direct file previews in Discord
  - Automatic detection based on file size using `shouldUploadToDiscord()` helper
  - All commands (download, convert, optimize) support Discord attachments
  - Enhanced storage functions return buffer and upload method information
- Stuck operations cleanup system
  - Automatic cleanup runs every 5 minutes to detect and resolve stuck operations
  - Configurable timeout (default 10 minutes) for stuck operation detection
  - Users receive DM notifications when their stuck operations are cleaned up
  - New `cleanupStuckOperations()` function in operations-tracker.js
  - Manual cleanup script: `fix-stuck-operations.js` (accessible via `npm run fix:stuck-ops`)
  - Enhanced database functions: `getStuckOperations()`, `markOperationAsFailed()`
- Fast Docker reload scripts
  - Cross-platform fast reload for development (JS wrapper, PowerShell, Bash)
  - New npm script: `docker:reload:fast` for faster iteration cycles
  - Platform detection and appropriate script execution
- Dockerfile cache strategy documentation
  - Added comments throughout Dockerfile explaining cache invalidation points
  - Documents which layers are cached and when they invalidate
  - Helps with build optimization understanding
- Log metrics test suite
  - Comprehensive tests for `getLogMetrics()` function
  - Tests component filtering, level aggregation, and edge cases

### Changed

- Storage function return format
  - `saveGif()`, `saveVideo()`, and `saveImage()` now return `{ url, buffer, method }` object
  - `url`: File URL or local path
  - `buffer`: File buffer for Discord attachments
  - `method`: 'discord' or 'r2' based on file size
  - **BREAKING**: Code using these functions must be updated to use `.url` property
- Rate limiting improvements
  - Localhost (IPv4 and IPv6) now bypasses rate limiting for development
  - Health check endpoint (`/health`) excluded from rate limiting
  - Rate limiter middleware moved after `/health` route
  - Improved skip logic for internal network requests
- Deferred download notifications
  - Updated to support Discord attachments via `AttachmentBuilder`
  - Can now send files as attachments or URLs based on size

### Fixed

- Test suite updates for new storage return format
  - Updated `storage.test.js` to use `.url` property from storage function returns
  - Fixed `database.test.js` metadata parsing (getLogs already parses JSON)

## [0.11.3-prerelease] - 2025-11-24

### Added

- Docker webui rebuild scripts
  - Added `docker:rebuild-webui` npm script
  - Cross-platform scripts (JS wrapper, bash, PowerShell) for rebuilding webui in Docker containers
  - Installs devDependencies and builds webui inside container
- Operation duration tracking in notifications
  - Automatic duration calculation and display in ntfy notifications
  - Duration formatting (ms, seconds, minutes, hours)
  - Duration display in Alerts.svelte metadata
- Stats caching improvements
  - Added 30-second cache for stats API endpoint in webui-server.js
  - Added localStorage caching (5min TTL) for error metrics and storage stats in Monitoring.svelte
  - Reduces load on main server and improves dashboard responsiveness
- User operations pagination
  - Added pagination support for user operations in UserProfile.svelte
  - Offset and limit parameters for efficient data loading
  - Real-time WebSocket updates refresh current page
- getOperation() function in operations-tracker.js for retrieving operations by ID

### Changed

- Social media URL cache behavior
  - Skip cache for social media URLs if cached result is not a GIF
  - Allows social media URLs to be processed fresh through Cobalt for conversion
  - Improves conversion quality for social media content
- Storage stats calculation improvements
  - Added mutex to prevent concurrent filesystem scans for the same storage path
  - Added 30-second timeout protection for stats calculations
  - Enhanced error handling with safe default values
  - Improved input validation for storage paths
- File size formatting improvements
  - Added comprehensive input validation (null, undefined, NaN, negative numbers)
  - Better error handling and logging for edge cases
  - Returns safe defaults instead of throwing errors
- Storage path validation
  - Enhanced getStoragePath() with input validation and error handling
  - Better error messages and logging
- Database query improvements
  - Added excludeComponentLevels parameter for filtering specific component+level combinations
  - Allows fine-grained log filtering (e.g., exclude webui INFO logs but keep ERROR/WARN)
- Operation trace improvements
  - Update 'created' step status to 'success' when execution steps exist
  - Better status tracking for operation lifecycle
- Stats endpoint improvements
  - Enhanced validation and error handling
  - Better error messages and logging
  - Safe default values on errors
- Rate limiting adjustments
  - Increased stats endpoint rate limit from 10 to 60 requests per 15min
  - Supports dashboard polling at 30s intervals
- Stats API endpoint path
  - Fixed webui-server.js to use `/api/stats` instead of `/stats`
  - Matches main server API structure
- WebUI logs filtering
  - Exclude webui INFO logs from logs list to reduce noise
  - Keep ERROR/WARN logs from webui visible for monitoring
- Error metrics endpoint
  - Don't exclude webui from error/warning counts
  - Only exclude webui INFO logs from totals/aggregations
- User operations endpoint
  - Improved database querying to fetch all operations for accurate counting
  - Better pagination support with offset and limit

### Fixed

- Stats endpoint validation and error handling
- Storage path validation edge cases
- File size formatting edge cases (null, undefined, NaN, negative numbers)
- Concurrent stats calculation race conditions
- Stats API endpoint path mismatch between webui-server and main server
- Rate limiting too strict for dashboard polling

## [0.11.2] - 2025-11-24

### Security

- Fixed insecure temporary file creation in test files
  - Replaced `os.tmpdir()` with `tmp` library for secure temporary file handling
  - Resolves CodeQL alerts #61, #60, #59 (CWE-377, CWE-378)

### Added

- Comprehensive test suite with 130 new tests
  - Logger sanitization tests (17 tests)
  - Serve-site security tests (22 tests)
  - WebUI rate limit tests (12 tests)
  - Video-processor validation tests (29 tests)
  - Docker-verify wrapper tests (12 tests)
  - Docker-copy-webui wrapper tests (12 tests)
  - Fetch-code-scanning-issues tests (22 tests)
  - Enhanced existing logger tests with sanitization (4 new tests)
- Command source tracking in operations
  - Track whether commands come from slash commands or context menus
  - Display command source in WebUI user profiles
- User metrics broadcast callback support in operations-tracker.js

### Changed

- Improved code formatting in bot.js, convert.js, download.js, database.js, optimize.js, modals.js, and webui-server.js
- Updated index.html formatting
- Enhanced operation context tracking with commandSource metadata
- Added rule to use `tmp` library for all temporary file operations

### Fixed

- Logger test: sanitization only removes control characters, not text content
- Test failures: simplified fetch-code-scanning-issues tests and fixed Linux path handling
- Stop tracking code-scanning-issues.json in git (now properly ignored)

## [0.11.2-prerelease] - 2025-11-24

### Added

- Comprehensive test suite with 130 new tests
  - Logger sanitization tests (17 tests)
  - Serve-site security tests (22 tests)
  - WebUI rate limit tests (12 tests)
  - Video-processor validation tests (29 tests)
  - Docker-verify wrapper tests (12 tests)
  - Docker-copy-webui wrapper tests (12 tests)
  - Fetch-code-scanning-issues tests (22 tests)
  - Enhanced existing logger tests with sanitization (4 new tests)
- Command source tracking in operations
  - Track whether commands come from slash commands or context menus
  - Display command source in WebUI user profiles
- User metrics broadcast callback support in operations-tracker.js

### Changed

- Improved code formatting in bot.js, convert.js, download.js, database.js, optimize.js, modals.js, and webui-server.js
- Updated index.html formatting
- Enhanced operation context tracking with commandSource metadata

### Fixed

- Logger test: sanitization only removes control characters, not text content
- Test failures: simplified fetch-code-scanning-issues tests and fixed Linux path handling
- Stop tracking code-scanning-issues.json in git (now properly ignored)

## [0.11.1-prerelease] - 2025-11-24

### Security

- Fixed additional CodeQL security vulnerabilities

## [0.11.0-prerelease] - 2025-11-24

### Security

- Resolved all 17 CodeQL security vulnerabilities
  - Fixed log injection vulnerability by sanitizing user input in logger
  - Fixed file system race conditions in optimize command
  - Fixed insecure temporary file creation in test files using tmp package
  - Fixed HTTP-to-file access vulnerabilities in optimize.js and convert.js with path validation
  - Fixed command injection in gif-optimizer.js by using spawn instead of exec
  - Fixed 8 path injection issues in serve-site.js with path validation
  - Fixed reflected XSS in serve-site.js with HTML escaping
  - Fixed type confusion through parameter tampering
  - Added rate limiting to webui-server.js file-serving routes
  - Fixed incomplete sanitization in docker-security.test.js
- Enhanced security measures
  - Added file buffer validation with magic byte checking for gif/video files
  - Improved error handling to show specific messages to users
  - Standardized all user-facing messages to lowercase monotone style
  - Documented file size limits in command descriptions and readme

### Added

- GitHub security features
  - Added GitHub Dependabot for automated dependency updates
  - Added CodeQL security scanning workflow
  - Added dependency review workflow
  - Added fetch-code-scanning-issues.js script to fetch security alerts
- Documentation
  - Added TODO.md for tracking tasks (github templates, wiki, documentation, logs toolbar fix)

### Changed

- WebUI improvements
  - Redesigned user profile page for compact layout
    - Consolidated header, stats, and command breakdown into single section
    - Hide empty sections instead of showing large empty state blocks
    - Convert operations from cards to compact table format
    - Limit activity timeline to 10 most recent entries in compact table
    - Reduced all spacing: container gaps (2rem->1rem), padding (1.5rem->1rem), stat values (2rem->1.5rem)
    - Made media table more compact with reduced padding and font sizes
    - Improved space efficiency throughout the profile page
  - Updated to Svelte 5 with mount() API for component mounting
  - Updated command handlers, database utilities, and webui components
- DevOps
  - Optimized CI/CD workflows: skip CodeQL for dependabot, add path filters, add concurrency controls
  - Removed prettier check from github ci workflow
  - Restored escapeShellArg function in gif-optimizer.js for test compatibility
  - Added FFmpeg installation to CI workflow for both test jobs

### Dependencies

- Major dependency updates (11 packages)
  - @aws-sdk/client-s3: 3.936.0 → 3.937.0
  - @aws-sdk/lib-storage: 3.936.0 → 3.937.0
  - discord.js: 14.24.2 → 14.25.1
  - dotenv: 16.6.1 → 17.2.3 (major)
  - express: 4.21.2 → 5.1.0 (major)
  - express-rate-limit: 7.5.1 → 8.2.1 (major)
  - marked: 17.0.0 → 17.0.1
  - @sveltejs/vite-plugin-svelte: 3.1.2 → 6.2.1 (major)
  - concurrently: 8.2.2 → 9.2.1 (major)
  - svelte: 4.2.20 → 5.43.14 (major)
  - vite: 5.4.21 → 7.2.4 (major)

### Fixed

- Fixed code style issues in serve-site.js
- Fixed formatting for CI
- Fixed linting errors: add caughtErrorsIgnorePattern to eslint config, remove unused imports

### Removed

- Removed aspirations.md

## [0.10.0] - 2025-11-23

### Security

- Added comprehensive Docker security tests for vulnerability detection
  - Added 22 new security tests covering resource limits, capabilities, namespace isolation
  - Tests for path traversal, container escape prevention, docker API security
  - Added health check security, network security, and filesystem security tests
- Fixed Docker security test false positives for CI workspace paths
  - Only flag direct mounts of sensitive root directories (depth <= 1)
  - Skip checks for known CI workspace paths (/home/runner/work/, /builds/, etc.)
  - Prevents false positives when ./data resolves to CI workspace paths

### Added

- Windows PowerShell support for docker scripts
  - Created PowerShell versions of docker-up, docker-reload, and docker-restart scripts
  - Added cross-platform Node.js wrappers that detect OS and run appropriate script
  - Updated package.json to use wrappers instead of direct bash calls
  - Fixed profile argument handling in PowerShell (using array splatting)
  - Updated message text from 'may take a while' to 'will take a while'
  - Scripts now show docker compose output for better visibility
- CI/CD tests for GitHub

### Fixed

- Fixed pre-commit hook for SSH/WSL environment
- Fixed version tagging logic: only mark versions with hyphen as prerelease, not 0.x versions

### Changed

- Updated GitHub repository references from p2xai to thedorekaczynski
- Removed inspiration section from README

## [0.9.0] - 2025-11-22

### Added

- Initial tracked release
- Core Discord bot functionality
  - `/download` command for downloading media from social media platforms
  - `/convert` command for converting videos and images to GIFs
  - `/optimize` command for optimizing existing GIFs
  - `/stats` command for viewing storage statistics
  - Context menu commands: "convert to gif", "download", "optimize"
  - Support for multiple media formats (mp4, mov, webm, avi, mkv, png, jpg, jpeg, webp, gif)
- WebUI dashboard
  - Statistics and monitoring interface
  - User profiles and activity tracking
  - Operations tracking
  - Logs viewer
  - Health monitoring
  - Alerts system
- Docker support
  - Docker Compose configuration
  - Multi-service setup (app, cobalt, webui)
  - Health checks and restart policies
- R2 storage integration
  - Cloudflare R2 support for storing and serving media files
  - Automatic upload to R2 when configured
  - Fallback to local filesystem storage
  - Public domain serving via R2
- Cobalt integration
  - Self-hosted API for downloading media from social platforms
  - Support for Twitter/X, TikTok, Instagram, YouTube, Reddit, Facebook, Threads
  - Automatic media detection and download
- Local server
  - Health check endpoint
  - Stats API endpoint
  - Static HTML pages (terms, privacy)
- Database utilities
  - SQLite database for tracking operations, users, and metrics
  - Log storage and retrieval
  - User metrics tracking
- File size limits
  - GIF optimization: maximum 50mb
  - Video conversion: maximum 100mb
  - Image conversion: maximum 50mb
  - Video download: maximum 500mb
  - Image download: maximum 50mb
  - Admin bypass for downloads
- Rate limiting
  - Express rate limiting for file-serving routes
  - Admin user bypass support
- Development tools
  - ESLint and Prettier configuration
  - Husky git hooks
  - Pre-commit validation
  - Docker buildx setup for cache support

[0.15.4]: https://github.com/gronkanium/gronka/compare/v0.15.3...v0.15.4
[0.15.0]: https://github.com/gronkanium/gronka/compare/v0.14.3...v0.15.0
[0.13.0]: https://github.com/gronkanium/gronka/compare/v0.13.0-prerelease...v0.13.0
[0.12.5]: https://github.com/gronkanium/gronka/compare/v0.12.4...v0.12.5
[0.12.4]: https://github.com/gronkanium/gronka/compare/v0.12.3-beta...v0.12.4
[0.12.3-beta]: https://github.com/gronkanium/gronka/compare/v0.12.2-beta...v0.12.3-beta
[0.12.2-beta]: https://github.com/gronkanium/gronka/compare/v0.12.1-beta...v0.12.2-beta
[0.12.1-beta]: https://github.com/gronkanium/gronka/compare/v0.12.0-prerelease...v0.12.1-beta
[0.12.0-prerelease]: https://github.com/gronkanium/gronka/compare/v0.11.4-prerelease...v0.12.0-prerelease
[0.11.3-prerelease]: https://github.com/gronkanium/gronka/compare/v0.11.2...v0.11.3-prerelease
[0.11.2]: https://github.com/gronkanium/gronka/compare/v0.11.1-prerelease...v0.11.2
[0.11.2-prerelease]: https://github.com/gronkanium/gronka/compare/v0.11.1-prerelease...v0.11.2-prerelease
[0.11.1-prerelease]: https://github.com/gronkanium/gronka/compare/v0.11.0-prerelease...v0.11.1-prerelease
[0.11.0-prerelease]: https://github.com/gronkanium/gronka/compare/v0.10.0...v0.11.0-prerelease
[0.10.0]: https://github.com/gronkanium/gronka/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/gronkanium/gronka/releases/tag/v0.9.0
