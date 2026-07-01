# Gronka — Handoff / TODO

Handoff for the next AI taking over. Branch: **`main`** (landed and pushed; this is canonical now
— see "Repo history / fork note" below for a real gotcha about GitHub `main`). Bot is live
(`gronka#3227`) and healthy on the latest image. Version 0.15.3.

## TL;DR current state (last updated 2026-07-01)

- lint clean, **598 tests pass** (`npm run test:safe`); `npm run test:e2e` = 4/4 pass separately.
- A 5-phase media-pipeline refactor is **complete** and deployed: download/convert/optimize now
  share a lifecycle wrapper + helper modules under `src/commands/shared/`.
- All refactor work landed onto `main` and pushed to GitHub (`origin`). Old GitHub `main` (a ~400
  commit independent 3-month history) was archived to `main-github-archive`, not deleted.
- `plan.md` (a fuller version of this plan) is gitignored — this `TODO.md` is the canonical handoff.
- **npm dependencies updated 2026-07-01** (`d4d0d45`): 47 → 4 vulnerabilities. See "Backlog" below
  for the 4 remaining (accepted risk, upstream-only).

## Runtime / ops facts (don't relearn these the hard way)

- Runs **natively in Docker Desktop** (Linux containers) from `C:\gronka`. **NOT WSL.**
- Build: `docker compose build app` (default BuildKit — the old `DOCKER_BUILDKIT=0` hack is retired;
  the broken `credsStore: wincred` was removed from `~/.docker/config.json`).
- Deploy: `docker compose up -d --no-build app`, then
  `docker compose logs app --tail 30` — healthy = `bot logged in as gronka#3227` + `All processes running`.
- A Task Scheduler job (`scripts/ensure-gronka-stack.ps1`, every 15m + at logon) keeps the stack up.
- Postgres test DB `gronka_test` **persists between runs** — tests must not assume a clean DB.
- Tests run with `NODE_ENV=test` (set in the npm scripts); this skips the optional webui HTTP POST.
- The `FFmpeg pass 1 (palette) failed ...` ERROR lines in test output are **expected** — the
  video-processor tests intentionally feed a bad mp4. The suite still passes.

## Conventions / gotchas

- **Commit messages:** write to a temp file and `git commit -F .git/COMMIT_MSG_TMP.txt`, then delete
  it. PowerShell here-strings mangle multi-line `git commit -m`. Pre-commit hook runs prettier+eslint
  on staged files.
- **GPG signing is disabled** for this repo (`git config commit.gpgsign false`) — pinentry was broken.
- Always `npm run lint` (eslint, `--max-warnings=0`) and `npm run test:safe` before committing.
  Removing code usually leaves unused imports → lint tells you exactly which to drop.

## Architecture: the shared command layer (`src/commands/shared/`)

The three command files (`download.js`, `convert.js`, `optimize.js`) used to each repeat the full
pipeline. Now each `process*` function provides only its _differences_ and runs inside a shared wrapper.

- **`run-media-command.js`** — `runMediaCommand(type, interaction, async (ctx) => {...}, options)`.
  Owns ONLY the identical, **reply-agnostic** lifecycle: `createOperation` (+context), optional DB
  init (`options.skipDbInit` — optimize uses it; convert keeps its own conditional init in the
  callback), flip to `running`, the outer try/catch (→ curated error reply + `notifyCommandFailure`),
  and `finally` temp-file cleanup (`ctx.tempFiles`). **The callback keeps full ownership of
  download/transform/save/upload/Discord-reply/success bookkeeping** (`updateOperationStatus('success')`,
  `recordRateLimit`, `notifyCommandSuccess`). `options`: `{ commandSource, commandName, context,
errorFallback, skipDbInit }`. `ctx`: `{ operationId, userId, username, adminUser, operationContext,
tempFiles, buildMetadata, logStep }`.
- **`command-errors.js`** — `curatedErrorMessage(error, fallback)` / `replyWithCuratedError(...)`.
  Shows `AppError` messages verbatim, replaces anything else with `fallback` so raw internals never
  reach Discord.
- **`buffer-validation.js`** — `validateVideoBuffer` / `validateGifBuffer` /
  `writeValidatedFileBuffer(path, buf, kind)` (`kind`: 'video'|'gif'|'image'; validation co-located
  with the write for CodeQL data-flow).
- **`url-cache.js`** — `recordProcessedUrl({...})` + `trackR2UploadIfApplicable(urlHash, url, admin)`.
- **`command-guards.js`** — `replyIfRateLimited(interaction, { type, action, commandSource })` → boolean.

Tests: `test/commands/shared/*.test.js`, `test/commands/run-media-command.test.js` (in-process Discord
E2E using `test/helpers/fake-interaction.js` — a stub+spy for the discord.js interaction object).

### ⚠️ Critical lesson (why the wrapper is reply-agnostic)

External AI tools first wrote a wrapper that **moved the Discord reply into the wrapper**. It lint-
passed and tests-passed but had real bugs (double-reply in convert, lost Discord-URL capture + R2
fallback, empty multi-file filenames) because the unit tests don't exercise the Discord reply path.
It was reverted and redone with the wrapper NOT touching replies. **Do not move reply logic into the
wrapper.** When changing command reply behavior, verify with the E2E test AND a live Discord smoke test.

## NEXT — ranked

### 1. Full-pipeline tests (highest durable value) — ✅ DONE

The E2E covers the wrapper; the `process*` bodies (real download→save→reply) are still untested
end-to-end. Use `test/helpers/fake-interaction.js` + Node module mocking
(`node --test --experimental-test-module-mocks`, Node 24 is installed) to stub the network boundary
(`utils/cobalt.js` `downloadFromSocialMedia`, `utils/ytdlp.js` `downloadWithYtdlp`,
`utils/file-downloader.js` `downloadImage`/`downloadVideo`) and drive a whole command, asserting the
reply. Add a `test:e2e` npm script if the mock flag complicates the main run.
Acceptance: a passing test that downloads (mocked) and asserts the exact `editReply` content/files for
single-file, picker/array, and cached paths.

**Completed 2026-06-26:** Added `test/commands/download-e2e.test.js` + `test:e2e` npm script. Drives
`handleDownloadCommand` (the public slash entry point) with a deferred fake interaction and
`mock.module`-stubbed network boundary (cobalt, yt-dlp, file-downloader) so no real HTTP is made.
Tests 4 paths: single-file video → Discord attachment, multi-file picker → 2 attachments, deleted post
→ curated error, and URL cache → second reply is a CDN URL. Uses a throwaway temp storage dir per run
for isolation. The test file gracefully skips under the plain `test:safe` suite (detects
`mock.module` presence). Requires `--experimental-test-module-mocks`; provided by `test:e2e` script.
Verified: `test:e2e` = 4/4 pass; `test:safe` = 598 pass (the skip placeholder adds 1).

> **⚠️ FOLLOW-UP — wire `test:e2e` into CI.** It is NOT part of `test` / `test:safe` (needs Postgres +
> `--experimental-test-module-mocks`), so it will silently rot unless CI invokes `npm run test:e2e`
> explicitly. Add it as a CI step (it needs the `gronka_test` Postgres DB available, same as `test:safe`).
> Minor: the cache-hit test's comment says "matched by content hash" but it's actually the URL cache
> (`getProcessedUrl`) firing first — the assertion holds either way; just an imprecise comment.

### 2. Fix remaining yt-dlp raw leaks (quick) — ✅ DONE

`src/utils/ytdlp.js` still throws `NetworkError`s with raw internals that reach users via
`curatedErrorMessage` (they're AppErrors):

- **line ~200**: `yt-dlp output path is not a file: ${outputPath}` — leaks the temp path. Curate.
- **line ~265**: `...could not read output directory: ${readError.message}` — leaks fs error. Curate.
- **lines ~192/215/243**: `output file too small (${size} bytes)` — leaks byte counts.
  **GOTCHA:** line ~474 does `segmentError.message.includes('output file too small')` as a
  control-flow signal to trigger the ffmpeg fallback. If you reword these, update line ~474 too, or
  keep an internal marker separate from the user-facing message.
  Pattern: `logger.error(<raw>); reject(new NetworkError(<generic curated message>));`

**Completed 2026-06-26:** All three leak sites curated. `output file too small (${size} bytes)` → generic
`yt-dlp segment download failed: output file too small` (byte count dropped but the `output file too small`
substring is preserved so line ~474's ffmpeg-fallback signal still fires). `output path is not a file`
similarly stripped of the temp path. Raw detail remains in `logger.error` for debugging. lint clean;
597 tests pass.

### 3. Land the branch — ✅ DONE and PUSHED

**Completed 2026-06-26.** `revitalize/cleanup-and-devops` was landed onto `main` and pushed to
GitHub (`origin`). The `revitalize/cleanup-and-devops` branch itself has been deleted (local + remote)
now that it's merged.

**⚠️ Repo history / fork note — read this if anything about `main`'s history looks confusing.**
When we went to push, `origin/main` on GitHub turned out to have **diverged ~3 months earlier**
(fork point `e274043`, 2025-11-22) into its own independent line of ~400 commits (webui dashboard,
admin cleanup panel, 5 dependabot security bumps, etc.), ending at `d092263` (2026-03-02). Our
refactor branch was built off an older base and had no idea. A normal push/merge was impossible
(two genuinely parallel histories, no common recent ancestor). **Resolution:** the old GitHub
`main` (`d092263`) was renamed to **`main-github-archive`** (nothing deleted — fully recoverable),
then our branch tip was force-pushed to become the new `main`. This was an explicit, informed
owner decision ("pure ai slop, gone to void") — not an accident.
**Known cost:** the 5 dependabot security bumps that only existed on the old line are gone from
`main`; this is part of why `npm audit` needed a fresh pass (see the security update entry above
and the `undici`/discord.js note in Backlog). If a webui dashboard / admin cleanup panel feature is
ever wanted back, it can be cherry-picked from `main-github-archive` — it still exists on GitHub.

### 4. Loose ends

- ~~`plan.md`~~ — done: added to `.gitignore`; `TODO.md` is the canonical handoff.
- ~~Reconcile the two `cleanupTempFiles`~~ — done: `download.js` local wrapper now delegates file
  deletion to the shared `storage.cleanupTempFiles(files)` and only keeps the extra
  `tmpDir.removeCallback()` locally. (`5e088a2`)
- A **live** Discord smoke test (real upload/URL, which the faked-interaction E2E can't cover):
  normal download, multi-image tweet (picker path), video→gif convert, Tenor optimize, deleted tweet.
  — covered by the E2E suite in `test/commands/download-e2e.test.js` for the four command paths
  (single, picker, deleted error, cached). Live real-Discord upload is manual by nature.

## Backlog

- **Live Discord smoke test** — the faked-interaction E2E (`test:e2e`) covers command logic but
  NOT the actual Discord upload/URL round-trip. Before cutting the next release, run these
  manually against the live bot (`gronka#3227`):
  1. `/download` a normal video (e.g. TikTok) — confirm Discord attachment arrives
  2. `/download` a multi-image tweet — confirm picker → multiple attachments
  3. `/convert` a video to GIF — confirm `.gif` attachment
  4. `/optimize` an existing GIF with lossy=35 — confirm smaller `.gif` returned
  5. `/download` a deleted tweet — confirm curated "unavailable or deleted" error
     Re-run after any change to upload, R2, or storage layer.

- **`undici` vuln, upstream-only, accepted risk (2026-07-01, `d4d0d45`)** — `npm audit` shows 4
  remaining vulnerabilities (3 moderate, 1 high), all a transitive `undici@6.24.1` pinned by
  `discord.js@14.26.4` (the latest release) via `@discordjs/rest`/`@discordjs/ws`. `npm audit fix
--force` "fixes" this by downgrading to `discord.js@13.x` — a breaking API change, not applied.
  `undici` is discord.js's own outbound HTTP/WS client to Discord's API only, not attacker-facing,
  so practical exploitability is low. **Action:** periodically re-run `npm outdated discord.js` /
  `npm audit` and take the fix once discord.js bumps its `undici` pin upstream. No code change needed
  on our side when that happens — just `npm update discord.js`. **Note:** `package.json` now has
  `"overrides": { "undici": "~6.24.1" }` (added `d8a733e`, see next item) — this does NOT fix these
  4 CVEs (6.24.1 is still in the vulnerable range), it only prevents a _different_ class of future
  breakage (an uncontrolled major-version jump). Both notes stay independently relevant.
- **Cherry-picked `undici` override + `editReply` socket retry from the archived branch
  (2026-07-01, `d8a733e`)** — see "Repo history / fork note" above for why an archived branch
  exists at all. Pulled forward one real, incident-driven fix from `main-github-archive` (original:
  `1a51c4f`, 2026-02-22): an unpinned `undici` had once resolved to a breaking major version (7.x),
  causing every `interaction.editReply()` to fail with `UND_ERR_SOCKET` — bot stuck on "thinking" in
  Discord. Added `overrides.undici: "~6.24.1"` (pinned to our current verified-safe version, not the
  archive's stale `~6.23.0`) and 3-attempt retry logic in `safeInteractionEditReply` for transient
  socket/timeout errors only (expired/already-acknowledged interactions still fail immediately).
  Did NOT bring forward that commit's `minimatch` override (unneeded now, would conflict with tools
  needing minimatch 3.x) or its `sanitizeDiscordError` call (from a separate, later, unrelated commit
  on that branch — out of scope). **If mining the archive for more fixes**, check `git log
origin/main-github-archive` — there may be other real incident fixes worth the same treatment,
  but verify each one against current code before porting (things drift after ~5 months).
- **TypeScript rewrite attempt was discarded (2026-07-01)** — a `typescript-rewrite` branch had
  uncommitted scaffolding (`src/types.ts`, `src/utils/config.ts`, `src/utils/errors.ts`,
  `src/utils/database/*.ts`, plus `typescript`/`tsx`/`@types/*` devDependencies) that was deleted
  per owner request before it went anywhere. If a TS migration is wanted again, start fresh — don't
  try to recover those files, they were never committed and are gone.
- **Docker Desktop LAN-access networking issue (2026-07-01) — STATUS UNCERTAIN, verify from a real
  second device.** The webui (port 3001) was reachable via `localhost` but timed out from the LAN IP
  (`192.168.0.212`) from a different machine. Initial theory: Windows' `netsh interface portproxy`
  table (which forwards host traffic into the WSL2 VM Docker Desktop runs on) had a stale internal
  WSL2 IP that doesn't always refresh after a restart. Did a full restart to test the theory:
  `Stop-Process -Name "Docker Desktop" -Force`, `wsl --shutdown`, relaunch Docker Desktop (briefly
  stops all containers, including the live bot, while it reinitializes) — check with `netsh
interface portproxy show all` vs `wsl -d docker-desktop -- ip addr show eth0`.
  **After the restart, the portproxy table's IP correctly matched the current WSL2 VM IP, yet
  `Invoke-WebRequest http://192.168.0.212:3001` from the SAME host still timed out.** This does NOT
  necessarily mean the fix failed — Windows frequently can't "hairpin" back to its own LAN IP even
  when a genuinely separate device works fine (NAT loopback limitation), so a same-host self-test is
  not reliable evidence either way here. **Never independently confirmed from an actual second
  device.** If this resurfaces: test from a real second machine first before assuming the portproxy
  theory was wrong; if it's still broken from a real second device too, the root cause is something
  else (check Windows Firewall profile matching on whichever NIC is currently active, or try a full
  Windows reboot rather than just Docker Desktop/WSL2 restart).

## Reference

- Commits: `git log --oneline fbc25cf..HEAD`
- Run tests: `npm run test:safe` | lint: `npm run lint` | format: `npm run format`
- Errors: `src/utils/errors.js` (`AppError` + subclasses; commands show only AppError messages to users).
- The old "fix the webui after postgres migration" TODO was here previously — per the owner it's
  already fixed; removed.
