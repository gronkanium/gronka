# test and production bot separation

gronka supports running separate test and production bots simultaneously, allowing you to test changes against a test bot while keeping a production bot running.

## why separate test and prod bots?

separating test and production bots provides several benefits:

- **isolated testing** - test new features without affecting production
- **independent configuration** - different settings for test and prod (admin users, storage paths, etc.)
- **separate databases** - test bot uses `gronka-test.db`, prod bot uses `gronka-prod.db`
- **isolated storage** - test bot uses `data-test/`, prod bot uses `data-prod/`
- **simultaneous operation** - run both bots at the same time for parallel testing
- **safe development** - test changes without risk to production data

## configuration

test and production bots are configured using prefixed environment variables. any environment variable can be prefixed with `TEST_` or `PROD_` to create bot-specific configuration.

### basic setup

configure your `.env` file with prefixed bot credentials:

```env
# test bot credentials
TEST_DISCORD_TOKEN=your_test_bot_token
TEST_CLIENT_ID=your_test_bot_client_id

# prod bot credentials
PROD_DISCORD_TOKEN=your_prod_bot_token
PROD_CLIENT_ID=your_prod_bot_client_id
```

### storage configuration

each bot can have its own storage directory:

```env
# test bot storage
TEST_GIF_STORAGE_PATH=./data-test

# prod bot storage
PROD_GIF_STORAGE_PATH=./data-prod
```

### database configuration

each bot uses a separate PostgreSQL database:

- test bot: `gronka_test` (configured via `TEST_POSTGRES_DB`)
- prod bot: `gronka` (configured via `PROD_POSTGRES_DB`)

configure PostgreSQL database names:

```env
# test bot database
TEST_POSTGRES_DB=gronka_test

# prod bot database
PROD_POSTGRES_DB=gronka
```

both bots connect to the same PostgreSQL server but use different database names for isolation.

### other prefixed variables

any configuration variable can be prefixed for bot-specific settings:

```env
# test bot configuration
TEST_ADMIN_USER_IDS=123456789012345678
TEST_CDN_BASE_URL=http://localhost:3000/gifs
TEST_MAX_GIF_WIDTH=480
TEST_R2_BUCKET_NAME=gronka-test-media

# prod bot configuration
PROD_ADMIN_USER_IDS=987654321098765432
PROD_CDN_BASE_URL=https://cdn.example.com/gifs
PROD_MAX_GIF_WIDTH=720
PROD_R2_BUCKET_NAME=gronka-prod-media
```

### supported prefixed variables

all standard environment variables support the `TEST_` and `PROD_` prefixes:

**required variables:**
- `TEST_DISCORD_TOKEN` / `PROD_DISCORD_TOKEN`
- `TEST_CLIENT_ID` / `PROD_CLIENT_ID`

**storage configuration:**
- `TEST_GIF_STORAGE_PATH` / `PROD_GIF_STORAGE_PATH`
- `TEST_CDN_BASE_URL` / `PROD_CDN_BASE_URL`
- `TEST_POSTGRES_DB` / `PROD_POSTGRES_DB`

**file size limits:**
- `TEST_MAX_VIDEO_SIZE` / `PROD_MAX_VIDEO_SIZE`
- `TEST_MAX_IMAGE_SIZE` / `PROD_MAX_IMAGE_SIZE`
- `TEST_GIF_QUALITY` / `PROD_GIF_QUALITY`

**processing options:**
- `TEST_MAX_GIF_WIDTH` / `PROD_MAX_GIF_WIDTH`
- `TEST_MAX_GIF_DURATION` / `PROD_MAX_GIF_DURATION`
- `TEST_DEFAULT_FPS` / `PROD_DEFAULT_FPS`
- `TEST_RATE_LIMIT` / `PROD_RATE_LIMIT`

**server configuration:**
- `TEST_SERVER_PORT` / `PROD_SERVER_PORT`
- `TEST_SERVER_HOST` / `PROD_SERVER_HOST`
- `TEST_STATS_USERNAME` / `PROD_STATS_USERNAME`
- `TEST_STATS_PASSWORD` / `PROD_STATS_PASSWORD`
- `TEST_STATS_CACHE_TTL` / `PROD_STATS_CACHE_TTL`

**webui configuration:**
- `TEST_WEBUI_PORT` / `PROD_WEBUI_PORT`
- `TEST_WEBUI_HOST` / `PROD_WEBUI_HOST`

**database configuration:**
- `TEST_POSTGRES_DB` / `PROD_POSTGRES_DB`
- `TEST_POSTGRES_HOST` / `PROD_POSTGRES_HOST`
- `TEST_POSTGRES_USER` / `PROD_POSTGRES_USER`
- `TEST_POSTGRES_PASSWORD` / `PROD_POSTGRES_PASSWORD`

**logging configuration:**
- `TEST_LOG_DIR` / `PROD_LOG_DIR`
- `TEST_LOG_LEVEL` / `PROD_LOG_LEVEL`
- `TEST_LOG_ROTATION` / `PROD_LOG_ROTATION`

**r2 storage:**
- `TEST_R2_ACCOUNT_ID` / `PROD_R2_ACCOUNT_ID`
- `TEST_R2_ACCESS_KEY_ID` / `PROD_R2_ACCESS_KEY_ID`
- `TEST_R2_SECRET_ACCESS_KEY` / `PROD_R2_SECRET_ACCESS_KEY`
- `TEST_R2_BUCKET_NAME` / `PROD_R2_BUCKET_NAME`
- `TEST_R2_PUBLIC_DOMAIN` / `PROD_R2_PUBLIC_DOMAIN`
- `TEST_R2_TEMP_UPLOADS_ENABLED` / `PROD_R2_TEMP_UPLOADS_ENABLED`
- `TEST_R2_TEMP_UPLOAD_TTL_HOURS` / `PROD_R2_TEMP_UPLOAD_TTL_HOURS`
- `TEST_R2_CLEANUP_ENABLED` / `PROD_R2_CLEANUP_ENABLED`
- `TEST_R2_CLEANUP_INTERVAL_MS` / `PROD_R2_CLEANUP_INTERVAL_MS`
- `TEST_R2_CLEANUP_LOG_LEVEL` / `PROD_R2_CLEANUP_LOG_LEVEL`

**cobalt integration:**
- `TEST_COBALT_API_URL` / `PROD_COBALT_API_URL`
- `TEST_COBALT_ENABLED` / `PROD_COBALT_ENABLED`

**admin and notifications:**
- `TEST_ADMIN_USER_IDS` / `PROD_ADMIN_USER_IDS`
- `TEST_NTFY_TOPIC` / `PROD_NTFY_TOPIC`

and any other configuration variable.

## running the bots

### start test bot

```bash
npm run bot:test
```

starts the test bot using `TEST_*` prefixed environment variables.

### start prod bot

```bash
npm run bot:prod
```

starts the production bot using `PROD_*` prefixed environment variables.

### development mode

run bots with hot reload for development:

```bash
# test bot with watch mode
npm run bot:test:dev

# prod bot with watch mode
npm run bot:prod:dev
```

### with webui

start bot with webui server:

```bash
# test bot with webui
npm run bot:test:webui

# prod bot with webui
npm run bot:prod:webui
```

## registering commands

each bot needs its commands registered separately:

```bash
# register test bot commands
npm run bot:register:test

# register prod bot commands
npm run bot:register:prod
```

commands are registered globally for each bot's application id, so they will appear in all servers where the bot is present.

## running both bots simultaneously

you can run both bots at the same time for parallel testing:

```bash
# terminal 1: start test bot
npm run bot:test

# terminal 2: start prod bot
npm run bot:prod
```

both bots will run independently with their own:
- database files
- storage directories
- configuration settings
- discord connections

## data separation

test and production bots maintain complete data separation:

### storage directories

- **test bot**: stores files in `data-test/` (or path specified by `TEST_GIF_STORAGE_PATH`)
- **prod bot**: stores files in `data-prod/` (or path specified by `PROD_GIF_STORAGE_PATH`)

### database files

- **test bot**: `gronka-test.db` in the test storage directory
- **prod bot**: `gronka-prod.db` in the prod storage directory

### r2 buckets

if using r2 storage, you can configure separate buckets:

```env
TEST_R2_BUCKET_NAME=gronka-test-media
PROD_R2_BUCKET_NAME=gronka-prod-media
```

this ensures test data never mixes with production data.

## development workflow

recommended workflow for development:

1. **configure both bots** in `.env` with prefixed variables
2. **start test bot** in development mode: `npm run bot:test:dev`
3. **test changes** using the test bot
4. **verify production bot** continues running normally (if started)
5. **deploy to production** once changes are verified

this allows you to:
- test new features safely
- verify changes don't break existing functionality
- maintain production uptime during development

## example configuration

complete example `.env` file for running both bots:

```env
# test bot credentials
TEST_DISCORD_TOKEN=test_bot_token_here
TEST_CLIENT_ID=test_client_id_here

# prod bot credentials
PROD_DISCORD_TOKEN=prod_bot_token_here
PROD_CLIENT_ID=prod_client_id_here

# test bot storage and database
TEST_GIF_STORAGE_PATH=./data-test
TEST_CDN_BASE_URL=http://localhost:3000/gifs
TEST_ADMIN_USER_IDS=123456789012345678

# prod bot storage and database
PROD_GIF_STORAGE_PATH=./data-prod
PROD_CDN_BASE_URL=https://cdn.example.com/gifs
PROD_ADMIN_USER_IDS=987654321098765432

# shared configuration (applies to both if not prefixed)
MAX_GIF_WIDTH=720
MAX_GIF_DURATION=30
DEFAULT_FPS=15

# test bot file size limits
TEST_MAX_VIDEO_SIZE=52428800
TEST_MAX_IMAGE_SIZE=26214400
TEST_GIF_QUALITY=low

# prod bot file size limits
PROD_MAX_VIDEO_SIZE=104857600
PROD_MAX_IMAGE_SIZE=52428800
PROD_GIF_QUALITY=medium

# test bot server configuration
TEST_SERVER_HOST=127.0.0.1

# prod bot server configuration
PROD_SERVER_HOST=0.0.0.0

# test bot webui configuration
TEST_WEBUI_PORT=3002
TEST_WEBUI_HOST=127.0.0.1

# prod bot webui configuration
PROD_WEBUI_PORT=3001
PROD_WEBUI_HOST=127.0.0.1

# test bot logging
TEST_LOG_DIR=./logs-test
TEST_LOG_LEVEL=DEBUG
TEST_LOG_ROTATION=daily

# prod bot logging
PROD_LOG_DIR=./logs-prod
PROD_LOG_LEVEL=INFO
PROD_LOG_ROTATION=daily

# test bot specific r2 (optional)
TEST_R2_BUCKET_NAME=gronka-test-media
TEST_R2_PUBLIC_DOMAIN=https://test-cdn.example.com

# prod bot specific r2 (optional)
PROD_R2_BUCKET_NAME=gronka-prod-media
PROD_R2_PUBLIC_DOMAIN=https://cdn.example.com
```

## troubleshooting

### bot not starting

check that the required prefixed variables are set:

```bash
# check test bot variables
echo $TEST_DISCORD_TOKEN
echo $TEST_CLIENT_ID

# check prod bot variables
echo $PROD_DISCORD_TOKEN
echo $PROD_CLIENT_ID
```

### commands not appearing

ensure commands are registered for the correct bot:

```bash
# register test bot commands
npm run bot:register:test

# register prod bot commands
npm run bot:register:prod
```

### database conflicts

if you see database errors, verify each bot is using its own database:

- test bot should use `gronka-test.db`
- prod bot should use `gronka-prod.db`

check the database path in your configuration or logs.

### storage path issues

ensure storage directories exist and have proper permissions:

```bash
# create directories
mkdir -p data-test/gifs
mkdir -p data-prod/gifs

# set permissions
chmod -R 755 data-test data-prod
```

## best practices

1. **always use separate storage paths** - never share `data-test` and `data-prod`
2. **use separate r2 buckets** - if using r2, use different buckets for test and prod
3. **test before deploying** - always test changes with test bot before deploying to prod
4. **keep configurations separate** - use prefixed variables to avoid conflicts
5. **monitor both bots** - check logs for both bots when running simultaneously

## related documentation

- [[Configuration|configuration]] - complete environment variable reference
- [[Installation|installation]] - installation and setup guide
- [[Quick-Start|quick start]] - get started quickly
- [[Docker-Deployment|docker deployment]] - docker setup (test/prod separation works in docker too)

