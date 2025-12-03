---
layout: post
title: development cycle for gronka
date: 2025-11-24
description: An overview of the current development cycle, CI/CD workflows, versioning strategy, and release process for the gronka Discord bot.
author: thedorekaczynski
tags:
  - development
  - cicd
  - workflow
  - process
---

# development cycle for gronka

this post outlines the current development cycle for gronka, covering everything from local development to automated releases.

## overview

gronka follows a structured development workflow with automated testing, security scanning, and release processes. the project uses semantic versioning, dual git remotes (gitlab and github), and docker-based deployment.

## local development

### getting started

local development uses node.js 20+ with hot reload support:

```bash
npm install
npm run dev          # bot with hot reload
npm run local        # bot + server together
npm run webui:dev    # webui with vite hot reload
```

### running test and prod bots

for local development, you can run both test and prod bots simultaneously using prefixed environment variables. this allows you to test changes against a test bot while keeping a production bot running.

configure your `.env` file with prefixed variables:

```bash
# test bot credentials
TEST_DISCORD_TOKEN=your_test_bot_token
TEST_CLIENT_ID=your_test_bot_client_id

# prod bot credentials
PROD_DISCORD_TOKEN=your_prod_bot_token
PROD_CLIENT_ID=your_prod_bot_client_id
```

available npm scripts:

```bash
npm run bot:test          # start test bot
npm run bot:prod          # start prod bot
npm run bot:test:dev      # test bot with hot reload
npm run bot:prod:dev      # prod bot with hot reload
npm run bot:register:test # register test bot commands
npm run bot:register:prod # register prod bot commands
```

each bot uses a separate database file (`gronka-test.db` and `gronka-prod.db`) and can have independent configuration using prefixed environment variables (e.g., `TEST_ADMIN_USER_IDS`, `PROD_CDN_BASE_URL`). see the [configuration documentation](https://github.com/thedorekaczynski/gronka/wiki/Configuration) for full details on prefixed variables.

### code quality checks

before committing, the project enforces code quality through git hooks (husky):

- **package-lock.json sync** - ensures dependencies are in sync
- **eslint** - code linting with zero warnings policy
- **prettier** - code formatting validation

you can run these manually:

```bash
npm run validate     # all checks at once
npm run lint         # linting only
npm run format       # format code
npm run check:sync   # verify lock file
```

if a commit fails due to formatting, run `npm run format` to fix it automatically.

### testing

the project includes a comprehensive test suite:

```bash
npm test             # run all tests
npm run test:watch   # watch mode for development
```

tests run automatically in CI/CD pipelines and must pass before merging code.

## git workflow

### dual remote setup

gronka uses two git remotes:

- **gitlab** (`git@192.168.0.20:thedorekaczynski/gronka.git`) - primary development remote with CI/CD
- **origin** (`https://github.com/thedorekaczynski/gronka.git`) - github mirror

always specify the remote explicitly when pushing:

```bash
git push gitlab main      # for active development
git push origin main      # for github sync
```

### merge requests

for significant changes (multiple files, features, or refactoring), create a merge request:

```bash
glab mr create
```

this creates a merge request on gitlab for code review and CI/CD validation.

## versioning strategy

gronka follows semantic versioning (MAJOR.MINOR.PATCH):

- **MAJOR** (1.0.0): breaking changes, major feature overhauls
- **MINOR** (0.1.0): new features, backwards-compatible additions
- **PATCH** (0.0.1): bug fixes, small improvements

### prerelease workflow

for testing and CI/CD validation, use prerelease versions:

1. update version in `package.json` to `X.Y.Z-prerelease`
2. update `CHANGELOG.md` with new section `[X.Y.Z-prerelease] - YYYY-MM-DD`
3. commit changes: `git commit -m "chore: bump version to X.Y.Z-prerelease and update changelog"`
4. push commit: `git push gitlab main`
5. create annotated tag: `git tag -a vX.Y.Z-prerelease -m "Release vX.Y.Z-prerelease: [description]"`
6. push tag: `git push gitlab vX.Y.Z-prerelease`
7. monitor CI/CD pipelines for build completion

prerelease tags trigger the same CI/CD workflows but mark releases as prerelease on github.

### full release workflow

for production releases:

1. ensure all changes are tested and committed
2. update version in `package.json` to `X.Y.Z` (remove `-prerelease` suffix)
3. update `CHANGELOG.md`:
   - change `[X.Y.Z-prerelease]` to `[X.Y.Z]`
   - update date to actual release date
   - add compare link at bottom
4. commit changes: `git commit -m "chore: bump version to X.Y.Z and update changelog"`
5. push commit: `git push gitlab main && git push origin main`
6. create annotated tag: `git tag -a vX.Y.Z -m "Release vX.Y.Z: [description]"`
7. push tags to both remotes: `git push gitlab vX.Y.Z && git push origin vX.Y.Z`
8. github actions automatically creates release with docker images

## CI/CD pipelines

### github actions

github actions provides multiple workflows:

**CI workflow** (`.github/workflows/ci.yml`):

- runs on push to main/master and pull requests
- dependency review for PRs
- validation checks (lock sync, linting)
- test suite execution
- skips for markdown-only changes

**codeql workflow** (`.github/workflows/codeql.yml`):

- security scanning with codeql
- runs on push and weekly schedule
- skips for dependabot PRs

**release workflow** (`.github/workflows/release.yml`):

- triggers on version tags (`v*`)
- verifies version matches package.json
- generates release notes from changelog
- builds and pushes docker images to ghcr.io
- creates github release with source archives and checksums
- marks prerelease versions appropriately

### gitlab CI

gitlab CI (`.gitlab-ci.yml`) runs on merge requests and main branch:

- installs dependencies
- runs validation (`npm run validate`)
- executes test suite
- caches node_modules for faster builds

## changelog maintenance

the `CHANGELOG.md` file is critical for tracking all changes. it follows the [keep a changelog](https://keepachangelog.com/en/1.0.0/) format.

### categories

changes are categorized as:

- **Added** - new features
- **Changed** - changes in existing functionality
- **Deprecated** - soon-to-be removed features
- **Removed** - removed features
- **Fixed** - bug fixes
- **Security** - security fixes and improvements

### process

1. review commits since last release: `git log vX.Y.Z..HEAD --oneline --no-merges`
2. categorize changes appropriately
3. write clear, descriptive entries
4. update `CHANGELOG.md` before tagging the release
5. include compare link at bottom for full release versions

## docker development

docker is the recommended deployment method and supports local development:

```bash
npm run docker:up              # start all services
npm run docker:reload          # rebuild and restart
npm run docker:reload:fast      # fast reload for development
npm run docker:down            # stop containers
npm run docker:logs            # view logs
npm run docker:register        # register discord commands
```

the docker setup includes:

- **app** - main service (bot + server)
- **cobalt** - self-hosted social media downloader
- **giflossy** - gif optimization service
- **watchtower** - automatic cobalt updates
- **webui** - optional dashboard (requires profile)

### fast reload

for faster iteration during development, use the fast reload script:

```bash
npm run docker:reload:fast
```

this uses platform-specific scripts (powershell on windows, bash on linux/mac) to quickly rebuild and restart containers without full docker compose rebuilds.

## security

security is a priority with multiple automated checks:

- **codeql scanning** - automated security vulnerability detection
- **dependency review** - checks for vulnerable dependencies
- **license checking** - denies GPL-2.0 and GPL-3.0 licenses
- **dependabot** - automated dependency updates

security fixes are documented in the changelog under the "Security" category.

## release automation

when a version tag is pushed, the release workflow automatically:

1. verifies version matches package.json
2. extracts release notes from changelog
3. creates source archive (tar.gz)
4. generates sha256 checksum
5. builds docker image with buildx cache
6. pushes to github container registry (ghcr.io)
7. creates github release with all artifacts
8. marks as prerelease if version contains `-prerelease`

the docker image is tagged with both the specific version and `latest` tag.

## current state

as of version 0.11.4-prerelease, the development cycle includes:

- comprehensive test suite (130+ tests)
- automated security scanning
- dual CI/CD pipelines (github + gitlab)
- docker-based deployment
- automated releases with docker images
- changelog-driven release notes
- semantic versioning with prerelease support

the project is actively developed with regular releases and continuous improvements to the development workflow itself.

## best practices

when contributing to gronka:

1. **always run validation** before committing: `npm run validate`
2. **update changelog** for user-facing changes
3. **create merge requests** for significant changes
4. **test locally** before pushing
5. **follow semantic versioning** when releasing
6. **document breaking changes** clearly in changelog
7. **use prerelease versions** for testing before full releases

this development cycle ensures code quality, security, and reliable releases while maintaining a smooth development experience.
