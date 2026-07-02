# Gronka — Handoff / TODO

Tracked handoff for whoever (human or AI) works on this next. Branch: **`main`**. Bot is live
as `gronka#3227`. Version **0.15.5**.

Agent instructions (the required development loop, command reference, incident-derived rules)
live in `CLAUDE.md` / `AGENTS.md` in the repo root — **local-only, gitignored**. If you're on a
fresh clone without them, the non-negotiables are inlined below under "Working rules".

## Current state (verified 2026-07-02, full run this date)

- `npm run lint` clean; `npm run test:safe` **598/598 pass**; `npm run test:e2e` **4/4 pass**.
- ⚠️ **Deploy pending**: the running container's image was built 2026-07-02 07:16, which
  **predates commit `49c2956`** (dead-subsystem removal, gifsicle-in-image, Dockerfile change,
  09:00). A stale orphaned `giflossy` container is also still running from the old stack.
  → See NEXT #1. Do not remove the giflossy container before the redeploy — the running old
  image may still shell out to it.
- e2e suite had rotted (mock missing the newer `getCobaltMediaUrls` export — fixed 2026-07-02)
  and is now wired into **both** CI pipelines (`test-e2e` job in GitHub Actions and GitLab CI),
  so it can't rot silently again.
- Root cleanup (2026-07-02): `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md` / `SECURITY.md` moved to
  `.github/`; `npm run fetch:security` now writes to `logs/code-scanning-issues.json`; old
  `plan.md` archived to `docs/archive/` (local). **Rule going forward: no new files in the
  project root.**

## Working rules (non-negotiable, stand-alone copy)

1. Gate every commit on `npm run lint` + `npm run test:safe` + `npm run test:e2e`, all green.
2. Conventional commits (`feat:`/`fix:`/`chore:`/…). No AI attribution in commit messages.
   Multi-line messages via `git commit -F <tempfile>` (PowerShell mangles multi-line `-m`).
   GPG signing is off for this repo. Pre-commit hook runs prettier+eslint on staged files.
3. **Never move Discord reply logic into the `runMediaCommand` wrapper** — a past attempt was
   lint-green and test-green but double-replied and lost the R2 fallback live. Reply-path
   changes require the e2e suite AND a live Discord smoke test (checklist below).
4. Users only see curated errors: `AppError` messages verbatim, everything else replaced by
   `curatedErrorMessage` fallback. Raw detail goes to `logger.error` only.
   Gotcha: `ytdlp.js` uses the substring `output file too small` as a control-flow signal for
   the ffmpeg fallback (~line 474) — reword those messages only in lockstep.

## Runtime / ops facts (don't relearn these the hard way)

- Runs natively in **Docker Desktop (Linux containers)** from `C:\gronka`. **NOT WSL.**
- Deploy: `docker compose build app` → `docker compose up -d --no-build --remove-orphans app`
  → `docker compose logs app --tail 30`. Healthy = `bot logged in as gronka#3227` +
  `All processes running`. Then confirm the running image postdates your commit
  (`docker inspect gronka --format '{{.Image}}'` vs `docker images`).
- A Task Scheduler job (`scripts/ensure-gronka-stack.ps1`, every 15 min + at logon) keeps the stack up.
- Postgres test DB `gronka_test` **persists between runs** — tests must not assume a clean DB.
- Tests run with `NODE_ENV=test` (set in the npm scripts).
- `FFmpeg pass 1 (palette) failed` ERROR lines in test output are **expected** (intentional
  bad-mp4 fixtures); the suite still passes.
- Remotes: `origin` = GitHub (PRs, CodeQL, dependabot), `gitlab` = self-hosted (tag-driven
  release pipeline; tag `vX.Y.Z` matching `package.json`).

## Architecture: the shared command layer (`src/commands/shared/`)

`download.js` / `convert.js` / `optimize.js` each provide only their differences inside
`runMediaCommand(type, interaction, callback, options)` (`run-media-command.js`), which owns
ONLY the reply-agnostic lifecycle: operation create/flip-to-running, optional DB init, outer
try/catch → curated error reply, and `finally` temp-file cleanup. **The callback keeps full
ownership of download/transform/save/upload/reply/success bookkeeping.** Sibling helpers:
`command-errors.js` (curated errors), `buffer-validation.js`, `url-cache.js`,
`command-guards.js` (rate-limit guard). Tests: `test/commands/shared/*.test.js`,
`test/commands/run-media-command.test.js`, and `test/commands/download-e2e.test.js`
(mocked-network full pipeline, `npm run test:e2e`).

## NEXT — ranked

### 1. Redeploy the bot onto the current `main` image

The live container predates `49c2956` (see Current state). Run the deploy sequence above —
`--remove-orphans` will also clear the stale `giflossy` container (safe only once the new
image, which bundles gifsicle, is what's running). Then run the live smoke test checklist
(Backlog) since `49c2956` touched the gif-optimizer path.

### 2. Watch discord.js → undici

`npm audit` shows 4 remaining vulns (3 moderate, 1 high), all transitive `undici` pinned by
`discord.js@14.26.4`. Not attacker-facing (outbound client to Discord's API only); accepted
risk. Periodically `npm outdated discord.js` / `npm audit`; when discord.js bumps its pin,
`npm update discord.js` closes them. Separately, `package.json` `overrides.undici` exists to
prevent uncontrolled major jumps (an unpinned 7.x once broke every `editReply` —
`UND_ERR_SOCKET`); keep the override current-major.

### 3. Deduplication backlog (verified findings from the 2026-07-01 review pass, need design calls)

- `safeInteractionReply`/`FollowUp`/`DeferReply` in `interaction-helpers.js` lack the
  socket-error retry that `safeInteractionEditReply` has — same failure mode, lower likelihood.
- `download.js`: 4 near-identical ~45-line "file exists → build URL → stat → record → reply"
  blocks (~648–692, 777–828, 916–963, 1068–1116) → one shared helper.
- "Capture Discord attachment URL with message-fetch fallback" duplicated ~6× across all three
  command files → `shared/` helper candidate.
- Tenor-URL resolution duplicated 4× across `convert.js`/`optimize.js`.
- `download.js` multi-file picker loops are sequential `await`-in-`for` over independent items
  → `Promise.all`/`allSettled` candidate; confirm ordering/partial-failure semantics first.
- `convert.js`/`optimize.js` recompute `hashUrlWithParams(originalUrl, options)` at multiple
  call sites → hoist.

## Backlog / reference notes

- **Live Discord smoke test checklist** (manual; the e2e can't cover the real Discord
  round-trip). Run after any change to upload, R2, storage, replies — and after NEXT #1:
  1. `/download` a normal video (e.g. TikTok) → attachment arrives
  2. `/download` a multi-image tweet → picker → multiple attachments
  3. `/convert` a video to GIF → `.gif` attachment
  4. `/optimize` a GIF with lossy=35 → smaller `.gif` returned
  5. `/download` a deleted tweet → curated "unavailable or deleted" error
- **Repo history / fork note**: GitHub `main` once diverged into an independent ~400-commit
  line; it was archived (not deleted) as **`main-github-archive`** and our line force-pushed as
  the new `main` — an explicit owner decision. Mine the archive for incident fixes only
  (`git log origin/main-github-archive`), verifying each against current code; one such fix
  (undici pin + editReply retry) was already ported.
- **TypeScript rewrite was attempted and discarded (2026-07-01)** — never committed, files
  gone. If wanted again, start fresh; don't restart it uninvited.
- **Docker Desktop LAN access (webui :3001) — status uncertain.** Reachable via localhost,
  timed out from the LAN IP; portproxy table now matches the WSL2 VM IP but same-host testing
  is unreliable (NAT loopback). **Verify from a real second device** before theorizing further;
  if still broken there, check Windows Firewall profile on the active NIC or do a full Windows
  reboot.

## Reference

- Tests: `npm run test:safe` | e2e: `npm run test:e2e` | lint: `npm run lint` | format: `npm run format`
- Errors: `src/utils/errors.js` (`AppError` + subclasses; only AppError messages reach users).
- Security alerts snapshot: `npm run fetch:security` → `logs/code-scanning-issues.json`.
- History of the 2026-06 refactor and fork resolution: `CHANGELOG.md` + `git log`; archived
  long-form plan at `docs/archive/plan-2026-06-refactor.md` (local-only).
