# Gronka — Handoff / TODO

Handoff for the next AI taking over. Branch: `revitalize/cleanup-and-devops`. Bot is live
(`gronka#3227`) and healthy on the latest image. Version 0.15.3.

## TL;DR current state

- lint clean, **597 tests pass** (`npm run test:safe`).
- A 5-phase media-pipeline refactor is **complete** and deployed: download/convert/optimize now
  share a lifecycle wrapper + helper modules under `src/commands/shared/`.
- **12 commits this session** (`git log --oneline fbc25cf..HEAD`), all green, all deployed.
- Working tree: only `plan.md` is untracked (a fuller version of this plan; commit or gitignore it).

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

### 1. Full-pipeline tests (highest durable value)

The E2E covers the wrapper; the `process*` bodies (real download→save→reply) are still untested
end-to-end. Use `test/helpers/fake-interaction.js` + Node module mocking
(`node --test --experimental-test-module-mocks`, Node 24 is installed) to stub the network boundary
(`utils/cobalt.js` `downloadFromSocialMedia`, `utils/ytdlp.js` `downloadWithYtdlp`,
`utils/file-downloader.js` `downloadImage`/`downloadVideo`) and drive a whole command, asserting the
reply. Add a `test:e2e` npm script if the mock flag complicates the main run.
Acceptance: a passing test that downloads (mocked) and asserts the exact `editReply` content/files for
single-file, picker/array, and cached paths.

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

### 3. Land the branch

`revitalize/cleanup-and-devops` is 12 commits off main. Merge or open a PR before it drifts.

### 4. Loose ends

- Decide on `plan.md` (untracked in repo root): commit or add to `.gitignore`.
- Reconcile the two `cleanupTempFiles`: `utils/storage.js` (array form) vs the local one in
  `download.js` (tmp-dir-object form). Different signatures — intentionally not merged yet.
- A **live** Discord smoke test (real upload/URL, which the faked-interaction E2E can't cover):
  normal download, multi-image tweet (picker path), video→gif convert, Tenor optimize, deleted tweet.

## Reference

- Commits: `git log --oneline fbc25cf..HEAD`
- Run tests: `npm run test:safe` | lint: `npm run lint` | format: `npm run format`
- Errors: `src/utils/errors.js` (`AppError` + subclasses; commands show only AppError messages to users).
- The old "fix the webui after postgres migration" TODO was here previously — per the owner it's
  already fixed; removed.
