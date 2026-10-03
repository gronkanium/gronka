# contributing to gronka

thanks for helping. issues and pull requests are welcome; this page covers how the code is laid out,
how to run it, and what a pull request needs before it can merge.

## run it

```bash
git clone https://github.com/gronkanium/gronka.git && cd gronka
bun install
bun run setup            # writes .env; `bun run setup --help` lists flags for scripted installs
docker compose up -d --build
```

you need [bun](https://bun.sh) 1.3, docker with compose, and a discord application for the bot token.
the [wiki](https://github.com/gronkanium/gronka/wiki) covers configuration in detail.

## how it fits together

| part          | where                               | what it does                                                                                    |
| ------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| bot           | `src/bot.js`                        | discord commands (`/download`, `/convert`, `/optimize`) and replies                             |
| media workers | `src/worker.js`                     | run every download and conversion from the `media_jobs` table; two by default                   |
| webui         | `src/webui-server.js`, `src/webui/` | the operator dashboard (svelte, built by `src/webui/vite.config.js`)                            |
| gronka web    | `src/web-server.js`, `web/`         | the hosted site at web.gronka.dev; it needs cloudflare and is not part of a self-hosted install |

`docker compose up` starts `app` (bot and webui), `worker`, `postgres`, `cobalt` (the media downloader)
and `watchtower` (keeps cobalt updated). gifs are optimized with `gifsicle` inside the image.

## the development loop

1. branch from `master`.
2. run your change against a **test bot**, never a live one: put `TEST_DISCORD_TOKEN` and
   `TEST_CLIENT_ID` in `.env`, then `bun run bot:register:test` once and `bun run bot:test`.
3. pass the gate. postgres must be running (`docker compose up -d postgres`):

   ```bash
   bun run validate     # lock file sync, public-file check, lint, formatting
   bun run test:safe    # the full suite
   bun run test:e2e     # the mocked download pipeline
   ```

4. open a pull request against `master`. ci runs the same gate plus codeql and a dependency review.

### commits

use [conventional commits](https://www.conventionalcommits.org/en/v1.0.0/): `feat:`, `fix:`, `docs:`,
`refactor:`, `test:`, `chore:`, `ci:`. release-please turns `feat:` and `fix:` subjects into the
changelog word for word, so make the subject say what changed. never edit `CHANGELOG.md` or the
version in `package.json` by hand; merging the release pull request does both.

a pre-commit hook (husky) checks lock file sync and runs eslint and prettier on staged files.

### code

- plain esm javascript on bun, no typescript.
- users only ever see curated error messages; raw errors go to the log.
- the bot stores nothing about users or requests: anything new that would outlive a request
  (a table, column, log line or file) needs a reason in the pull request.
- comments explain why, not what, and stay short.

### public files stay generic

the repository is a product anyone can run, so nothing tracked describes one particular
deployment: no host names, private addresses, home paths or machine-specific steps in docs, web
pages or comments. source maps stay off everywhere. `bun run check:public` enforces both and runs in
ci.

## dependencies

add packages with `bun add <name>` (or `bun add --dev <name>`) and commit `bun.lock`. if
`bun run check:sync` says the lock file drifted, `bun install` repairs it. docker builds use
`--frozen-lockfile` and fail on drift.

## docs

documentation lives in `wiki/` (obsidian-style `[[links]]`). maintainers publish it to the github
wiki with `bun run wiki:sync`.

## useful scripts

| script                          | does                                                          |
| ------------------------------- | ------------------------------------------------------------- |
| `bun run setup` / `setup:check` | write `.env` / check an install, `--json` for tooling         |
| `bun run dev`                   | the bot with auto-restart                                     |
| `bun run webui:dev`             | the webui with hot reload                                     |
| `bun run build:webui`           | build the webui                                               |
| `bun run lint:fix` / `format`   | fix lint and formatting                                       |
| `bun run docker:logs`           | follow the container logs                                     |
| `bun run docker:register`       | re-register slash commands (the container does this on start) |

## name and artwork

the code is MIT. the gronka name, logo and penguin are not; see [TRADEMARKS](TRADEMARKS.md).
