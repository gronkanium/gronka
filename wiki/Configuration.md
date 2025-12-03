all environment variables and configuration options for gronka.

## required variables

these must be set for the bot to function:

### `DISCORD_TOKEN`

discord bot token from the developer portal.

**where to get it:**

1. go to [https://discord.com/developers/applications](https://discord.com/developers/applications)
2. select your application
3. go to "bot" section
4. click "reset token" or "copy" to get your token

**example:**

```env
DISCORD_TOKEN=MTIzNDU2Nzg5MDEdMzQ1Njc4OQ.GaBcDe.FgHiJkLmNoPqRsTuVwXyadASaBcDeFgHiJkLmNo
```

### `CLIENT_ID`

discord application/client id.

**where to get it:**

1. go to [https://discord.com/developers/applications](https://discord.com/developers/applications)
2. select your application
3. go to "general information"
4. copy the "application id"

**example:**

```env
CLIENT_ID=1234567890123456789
```

## storage configuration

### `GIF_STORAGE_PATH`

path to store gifs, videos, and images locally.

**default:** `./data-test/gifs` (bot) or `./data-test` (server)

**notes:**

- bot uses `./data-test/gifs` by default (includes 'gifs' subdirectory)
- server uses `./data-test` by default (base path, 'gifs' subdirectory is appended automatically)
- for production deployments, use `./data-prod/gifs` or a custom path
- for testing, use `./data-test` to avoid conflicts with production data
- when using test/prod bot prefixes, each bot can have its own storage path via `TEST_GIF_STORAGE_PATH` or `PROD_GIF_STORAGE_PATH`

**example:**

```env
GIF_STORAGE_PATH=/var/www/gifs
# or for test bot
TEST_GIF_STORAGE_PATH=./data-test
PROD_GIF_STORAGE_PATH=./data-prod
```

### `CDN_BASE_URL`

base url for serving files.

**default:** `https://cdn.gronka.p1x.dev/gifs`

**notes:**

- used when r2 is not configured
- should point to your public domain or localhost for development
- files are served at `{CDN_BASE_URL}/{hash}.gif`

**example:**

```env
CDN_BASE_URL=https://cdn.example.com/gifs
```

## r2 storage

these are optional but recommended for production:

### `R2_ACCOUNT_ID`

your cloudflare account id.

**where to find it:**

- in the cloudflare dashboard url
- in the r2 overview page

**example:**

```env
R2_ACCOUNT_ID=abc123def456789
```

### `R2_ACCESS_KEY_ID`

r2 api access key id.

**where to get it:**

1. go to cloudflare dashboard → r2
2. click "manage r2 api tokens"
3. create a new token
4. copy the access key id

**example:**

```env
R2_ACCESS_KEY_ID=your_access_key_id
```

### `R2_SECRET_ACCESS_KEY`

r2 api secret access key.

**where to get it:**

- created alongside the access key id
- only shown once, save it securely

**example:**

```env
R2_SECRET_ACCESS_KEY=your_secret_access_key
```

### `R2_BUCKET_NAME`

name of your r2 bucket.

**example:**

```env
R2_BUCKET_NAME=gronka-media
```

### `R2_PUBLIC_DOMAIN`

public domain for your r2 bucket.

**example:**

```env
R2_PUBLIC_DOMAIN=https://cdn.example.com
```

### `R2_TEMP_UPLOADS_ENABLED`

enable automatic tracking and cleanup of temporary r2 uploads.

**default:** `false`

**notes:**

- when enabled, all new r2 uploads are tracked with a ttl
- existing files uploaded before enabling remain permanent
- requires `R2_CLEANUP_ENABLED=true` for automatic deletion
- can be enabled without cleanup for tracking only

**example:**

```env
R2_TEMP_UPLOADS_ENABLED=true
```

### `R2_TEMP_UPLOAD_TTL_HOURS`

time-to-live in hours for temporary r2 uploads.

**default:** `72`

**range:** 1-8760 (1 hour to 1 year)

**notes:**

- files are automatically deleted after this period
- each upload has its own ttl (reference counting)
- files are only deleted when all uploads have expired

**example:**

```env
R2_TEMP_UPLOAD_TTL_HOURS=72
```

### `R2_CLEANUP_ENABLED`

enable background cleanup job to delete expired r2 files.

**default:** `false`

**notes:**

- requires `R2_TEMP_UPLOADS_ENABLED=true` to function
- cleanup job runs periodically based on `R2_CLEANUP_INTERVAL_MS`
- failed deletions are retried on each run
- admin alerts are sent after 5 failed attempts

**example:**

```env
R2_CLEANUP_ENABLED=true
```

### `R2_CLEANUP_INTERVAL_MS`

cleanup job run interval in milliseconds.

**default:** `3600000` (1 hour)

**range:** 60000-86400000 (1 minute to 1 day)

**notes:**

- how often the cleanup job checks for expired files
- shorter intervals check more frequently but use more resources
- longer intervals reduce resource usage but delay deletion

**example:**

```env
R2_CLEANUP_INTERVAL_MS=3600000
```

### `R2_CLEANUP_LOG_LEVEL`

logging verbosity for cleanup job.

**default:** `detailed`

**options:**

- `minimal` - errors and summary only
- `detailed` - each file deletion attempt and result
- `debug` - everything including timing and batch info

**example:**

```env
R2_CLEANUP_LOG_LEVEL=detailed
```

## processing options

### `MAX_GIF_WIDTH`

maximum width for converted gifs in pixels.

**default:** `720`

**range:** 1-4096

**example:**

```env
MAX_GIF_WIDTH=1080
```

### `MAX_GIF_DURATION`

maximum video duration in seconds for conversion.

**default:** `30`

**range:** 1-300

**example:**

```env
MAX_GIF_DURATION=60
```

### `DEFAULT_FPS`

default frames per second for gif conversion.

**default:** `30`

**range:** 1-120

**example:**

```env
DEFAULT_FPS=15
```

### `RATE_LIMIT`

cooldown period in seconds between commands per user.

**default:** `10`

**range:** 1+

**notes:**

- rate limiting prevents abuse by enforcing a cooldown between commands
- admin users (configured via `ADMIN_USER_IDS`) bypass rate limiting
- rate limits apply per user, not per server

**example:**

```env
RATE_LIMIT=10
# or for test/prod bots
TEST_RATE_LIMIT=5
PROD_RATE_LIMIT=10
```

## file size limits

### `MAX_VIDEO_SIZE`

maximum video file size in bytes for downloads and conversions.

**default:** `104857600` (100MB)

**range:** 1+

**notes:**

- applies to video files downloaded via `/download` or converted via `/convert`
- admin users can bypass this limit for downloads
- conversion limits still apply for security reasons
- value is in bytes (e.g., 100MB = 104857600)

**example:**

```env
MAX_VIDEO_SIZE=104857600
# or for test/prod bots
TEST_MAX_VIDEO_SIZE=52428800
PROD_MAX_VIDEO_SIZE=104857600
```

### `MAX_IMAGE_SIZE`

maximum image file size in bytes for downloads and conversions.

**default:** `52428800` (50MB)

**range:** 1+

**notes:**

- applies to image files downloaded via `/download` or converted via `/convert`
- admin users can bypass this limit for downloads
- conversion limits still apply for security reasons
- value is in bytes (e.g., 50MB = 52428800)

**example:**

```env
MAX_IMAGE_SIZE=52428800
# or for test/prod bots
TEST_MAX_IMAGE_SIZE=26214400
PROD_MAX_IMAGE_SIZE=52428800
```

### `GIF_QUALITY`

gif conversion quality setting.

**default:** `medium`

**options:**

- `low` - faster conversion, lower quality, smaller file size
- `medium` - balanced quality and file size (recommended)
- `high` - slower conversion, higher quality, larger file size

**notes:**

- affects the quality of converted gifs
- higher quality takes longer to process
- lower quality produces smaller files

**example:**

```env
GIF_QUALITY=medium
# or for test/prod bots
TEST_GIF_QUALITY=low
PROD_GIF_QUALITY=high
```

## server configuration

note: as of version 0.13.0, the standalone express server (`src/server.js`) has been removed. these settings now configure the minimal http stats server built into the bot process, which only serves `/api/stats/24h` for jekyll integration.

### `SERVER_PORT`

port for the stats http server (built into bot process).

**default:** `3000`

**range:** 1-65535

**notes:**

- the bot process includes a minimal http server for stats
- only serves `/api/stats/24h` endpoint for jekyll integration
- no file serving - files are served from r2 or discord

**example:**

```env
SERVER_PORT=3000
# or for test/prod bots
TEST_SERVER_PORT=3000
PROD_SERVER_PORT=3000
```

### `SERVER_HOST`

host/address for the stats http server to bind to.

**default:** `0.0.0.0`

**notes:**

- `0.0.0.0` binds to all network interfaces (accessible from network)
- `127.0.0.1` or `localhost` binds to localhost only (local access only)
- use `127.0.0.1` for security if you don't need network access
- applies to the stats server built into the bot process

**example:**

```env
SERVER_HOST=0.0.0.0
# or for test/prod bots
TEST_SERVER_HOST=127.0.0.1
PROD_SERVER_HOST=0.0.0.0
```

### `CORS_ORIGIN`

explicit cors origin override.

**optional**

**notes:**

- if not set, cors origin is automatically derived from `CDN_BASE_URL`
- set this to override the automatic derivation
- use `*` to allow all origins (not recommended for production)
- should be a valid url origin (e.g., `https://example.com`)

**example:**

```env
CORS_ORIGIN=https://example.com
# or for test/prod bots
TEST_CORS_ORIGIN=http://localhost:3000
PROD_CORS_ORIGIN=https://cdn.example.com
```

### `BOT_API_URL`

url of the bot server api endpoint for jekyll stats polling.

**required for jekyll stats feature**

**format:** `http://IP_ADDRESS:PORT` or `http://localhost:3000`

**default:** `http://localhost:3000`

**notes:**
- use the local network ip address of the bot server, not `localhost`
- the bot server must be accessible from the jekyll server over the network
- used by `scripts/update-jekyll-stats.js` to fetch stats from `/api/stats/24h` endpoint

**example:**

```env
BOT_API_URL=http://192.168.0.212:3000
```

### `STATS_USERNAME`

username for basic auth on `/stats` and `/api/stats/24h` endpoints.

**optional** (required if bot server has basic auth enabled)

**notes:**
- used for both `/stats` endpoint (storage stats) and `/api/stats/24h` endpoint (24-hour activity stats)
- must match the `STATS_USERNAME` configured on the bot server
- if set, `STATS_PASSWORD` should also be set

**example:**

```env
STATS_USERNAME=admin
```

### `STATS_PASSWORD`

password for basic auth on `/stats` and `/api/stats/24h` endpoints.

**optional** (recommended if `STATS_USERNAME` is set)

**notes:**
- used for both `/stats` endpoint (storage stats) and `/api/stats/24h` endpoint (24-hour activity stats)
- must match the `STATS_PASSWORD` configured on the bot server
- should be set if `STATS_USERNAME` is configured

**example:**

```env
STATS_PASSWORD=secure_password_here
```

### `STATS_CACHE_TTL`

cache ttl for stats in milliseconds.

**default:** `300000` (5 minutes)

**set to `0` to disable caching**

**example:**

```env
STATS_CACHE_TTL=600000
# or for test/prod bots
TEST_STATS_CACHE_TTL=0
PROD_STATS_CACHE_TTL=300000
```

## webui configuration

### `WEBUI_PORT`

port for the webui dashboard server.

**default:** `3001`

**range:** 1-65535

**notes:**

- webui provides a dashboard for viewing stats and logs
- typically only accessible from localhost for security
- can be started with `npm run bot:test:webui` or `npm run bot:prod:webui`

**example:**

```env
WEBUI_PORT=3001
# or for test/prod bots
TEST_WEBUI_PORT=3002
PROD_WEBUI_PORT=3001
```

### `WEBUI_HOST`

host/address for the webui server to bind to.

**default:** `127.0.0.1`

**notes:**

- `127.0.0.1` binds to localhost only (recommended for security)
- `0.0.0.0` binds to all network interfaces (not recommended)
- webui should typically only be accessible locally

**example:**

```env
WEBUI_HOST=127.0.0.1
# or for test/prod bots
TEST_WEBUI_HOST=127.0.0.1
PROD_WEBUI_HOST=127.0.0.1
```

### `MAIN_SERVER_URL` (removed)

this configuration variable has been removed in version 0.13.0. the webui now calculates stats directly from the database and filesystem instead of proxying requests to a separate server.

**migration:**

if upgrading from < 0.13.0, you can safely remove `MAIN_SERVER_URL` from your `.env` file. it is no longer used.

**old example (deprecated):**

```env
# MAIN_SERVER_URL=http://localhost:3000 (no longer needed)
# or for test/prod bots
TEST_MAIN_SERVER_URL=http://localhost:3000
PROD_MAIN_SERVER_URL=http://localhost:3000
```

### `WEBUI_URL` / `WEBUI_SERVER_URL`

alternative webui url configuration.

**optional**

**notes:**

- used internally by operations tracker
- if not set, defaults to `http://localhost:{WEBUI_PORT}`
- typically not needed unless using custom webui setup

**example:**

```env
WEBUI_URL=http://localhost:3001
# or
WEBUI_SERVER_URL=http://localhost:3001
```

## database configuration

gronka uses PostgreSQL for all database operations. Configure PostgreSQL connection parameters:

- `POSTGRES_HOST` - PostgreSQL server hostname (default: `postgres` in Docker, `localhost` locally)
- `POSTGRES_PORT` - PostgreSQL server port (default: `5432`)
- `POSTGRES_USER` - PostgreSQL username (default: `gronka`)
- `POSTGRES_PASSWORD` - PostgreSQL password (default: `gronka`)
- `POSTGRES_DB` - PostgreSQL database name (default: `gronka`)
- `DATABASE_URL` - Full PostgreSQL connection string (optional, overrides individual parameters)

for test/prod isolation, use prefixed variables:
- `TEST_POSTGRES_DB` - Test database name (e.g., `gronka_test`)
- `PROD_POSTGRES_DB` - Production database name (e.g., `gronka`)

**example:**

```env
# production
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_USER=gronka
POSTGRES_PASSWORD=your_password
POSTGRES_DB=gronka

# or use connection string
DATABASE_URL=postgresql://gronka:password@postgres:5432/gronka

# test/prod separation
TEST_POSTGRES_DB=gronka_test
PROD_POSTGRES_DB=gronka
```

## logging configuration

### `LOG_DIR`

directory for log files.

**default:** `./logs`

**notes:**

- log files are stored in this directory
- ensure the directory exists and is writable
- logs are rotated based on `LOG_ROTATION` setting

**example:**

```env
LOG_DIR=./logs
# or for test/prod bots
TEST_LOG_DIR=./logs-test
PROD_LOG_DIR=./logs-prod
```

### `LOG_LEVEL`

logging verbosity level.

**default:** `INFO`

**options:**

- `DEBUG` - most verbose, includes all debug information
- `INFO` - standard logging, includes informational messages
- `WARN` - warnings and errors only
- `ERROR` - errors only

**notes:**

- higher levels (DEBUG, INFO) produce more log output
- lower levels (WARN, ERROR) produce less output
- use DEBUG for troubleshooting, INFO for normal operation

**example:**

```env
LOG_LEVEL=INFO
# or for test/prod bots
TEST_LOG_LEVEL=DEBUG
PROD_LOG_LEVEL=INFO
```

### `LOG_ROTATION`

log file rotation strategy.

**default:** `daily`

**options:**

- `daily` - rotate log files daily
- `none` - no rotation, single log file

**notes:**

- daily rotation helps manage log file sizes
- rotated logs are kept in the same directory with date suffixes
- use `none` if you prefer manual log management

**example:**

```env
LOG_ROTATION=daily
# or for test/prod bots
TEST_LOG_ROTATION=daily
PROD_LOG_ROTATION=daily
```

## cobalt integration

### `COBALT_API_URL`

url of your cobalt api instance.

**default:** `http://cobalt:9000`

**example:**

```env
COBALT_API_URL=http://cobalt:9000
```

### `COBALT_ENABLED`

enable or disable cobalt integration.

**default:** `true`

**example:**

```env
COBALT_ENABLED=true
```

## admin configuration

### `ADMIN_USER_IDS`

comma-separated list of discord user ids with admin privileges.

**optional**

**admin privileges:**

- bypass rate limiting
- upload files larger than normal limits
- convert videos longer than 30 seconds

**example:**

```env
ADMIN_USER_IDS=123456789012345678,987654321098765432
```

## notifications

### `NTFY_TOPIC`

ntfy topic for notifications.

**optional**

when set, enables notifications for completed downloads and errors.

**example:**

```env
NTFY_TOPIC=gronka-notifications
```

## test and production bot configuration

gronka supports running separate test and production bots simultaneously using prefixed environment variables. any environment variable can be prefixed with `TEST_` or `PROD_` to create bot-specific configuration.

### prefixed variables

to configure separate test and production bots, prefix any environment variable with `TEST_` or `PROD_`:

```env
# test bot configuration
TEST_DISCORD_TOKEN=test_bot_token
TEST_CLIENT_ID=test_client_id
TEST_GIF_STORAGE_PATH=./data-test
TEST_ADMIN_USER_IDS=123456789012345678

# prod bot configuration
PROD_DISCORD_TOKEN=prod_bot_token
PROD_CLIENT_ID=prod_client_id
PROD_GIF_STORAGE_PATH=./data-prod
PROD_ADMIN_USER_IDS=987654321098765432
```

### how it works

when you start a bot with `npm run bot:test` or `npm run bot:prod`, the bot-start script:

1. reads prefixed environment variables (e.g., `TEST_DISCORD_TOKEN`)
2. maps them to standard variable names (e.g., `DISCORD_TOKEN`)
3. sets bot-specific database paths (`gronka-test.db` or `gronka-prod.db`)
4. starts the bot with the mapped configuration

### supported prefixes

all environment variables support the `TEST_` and `PROD_` prefixes, including:

**required variables:**
- `TEST_DISCORD_TOKEN` / `PROD_DISCORD_TOKEN`
- `TEST_CLIENT_ID` / `PROD_CLIENT_ID`

**storage configuration:**
- `TEST_GIF_STORAGE_PATH` / `PROD_GIF_STORAGE_PATH`
- `TEST_CDN_BASE_URL` / `PROD_CDN_BASE_URL`

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
- `TEST_DATABASE_URL` / `PROD_DATABASE_URL`

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

and any other configuration variable

### database separation

each bot uses a separate PostgreSQL database:

- test bot: `gronka_test` (configured via `TEST_POSTGRES_DB`)
- prod bot: `gronka` (configured via `PROD_POSTGRES_DB`)

the bots connect to the same PostgreSQL server but use different database names for isolation.

### running the bots

```bash
# start test bot
npm run bot:test

# start prod bot
npm run bot:prod

# register commands
npm run bot:register:test
npm run bot:register:prod
```

for more details, see the [[Test-Bot|test bot documentation]].

## local vs docker deployment variable handling

there is an important difference in how environment variables are handled between local deployments (using `npm run bot:prod:webui`) and docker deployments (using `npm run docker:up`).

### local deployment (`npm run bot:prod:webui`)

when you run `npm run bot:prod:webui`, it uses the `bot-start.js` script which:

1. loads environment variables from your `.env` file
2. automatically maps **all** `PROD_*` prefixed variables to standard names
3. supports `PROD_*` prefix for **37+ configuration variables**
4. runs the bot, server, and webui as separate node processes with mapped variables

**all variables support the `PROD_*` prefix** when using local deployment commands:

```bash
npm run bot:prod          # uses PROD_* variables
npm run bot:prod:webui    # uses PROD_* variables
npm run bot:test          # uses TEST_* variables
npm run bot:test:webui    # uses TEST_* variables
```

**example:** if you set `PROD_MAX_GIF_DURATION=60` in your `.env`, the bot will use 60 seconds when started with `npm run bot:prod:webui`.

### docker deployment (`npm run docker:up`)

when you run `npm run docker:up`, it uses `docker-compose.yml` which:

1. sets environment variables directly in the container
2. **only supports `PROD_*` prefix for 4 variables:**
   - `PROD_DISCORD_TOKEN` (falls back to `DISCORD_TOKEN`)
   - `PROD_CLIENT_ID` (falls back to `CLIENT_ID`)
   - `PROD_POSTGRES_DB` (falls back to `POSTGRES_DB`)
   - `PROD_GIF_STORAGE_PATH` (falls back to `./data-prod/gifs`)
3. all other variables use **standard names without prefix support**
4. the container runs bot/server/webui directly without using `bot-start.js`

**why the difference?**

the docker container uses `docker-entrypoint.sh` which directly executes `node src/bot.js` and `node src/webui-server.js`. it does not use the `bot-start.js` script that performs prefix mapping. instead, variables are set directly in `docker-compose.yml` using docker's variable substitution syntax.

note: as of version 0.13.0, `src/server.js` has been removed. the bot process now includes a minimal stats http server.

### variables that support `PROD_*` prefix in docker

only these 4 variables support the `PROD_*` prefix in docker:

```env
# docker-compose.yml uses these with PROD_ prefix support
PROD_DISCORD_TOKEN=${PROD_DISCORD_TOKEN:-${DISCORD_TOKEN}}
PROD_CLIENT_ID=${PROD_CLIENT_ID:-${CLIENT_ID}}
PROD_GRONKA_DB_PATH=${PROD_GRONKA_DB_PATH:-./data-prod/gronka.db}
PROD_GIF_STORAGE_PATH=${PROD_GIF_STORAGE_PATH:-./data-prod/gifs}
```

### variables that do not support `PROD_*` prefix in docker

all other variables in `docker-compose.yml` use standard names and do not support the `PROD_*` prefix:

```env
# these use standard names (no PROD_ prefix support)
CDN_BASE_URL=${CDN_BASE_URL:-https://cdn.gronka.p1x.dev/gifs}
MAX_GIF_DURATION=${MAX_GIF_DURATION:-30}
GIF_QUALITY=${GIF_QUALITY:-medium}
ADMIN_USER_IDS=${ADMIN_USER_IDS:-}
STATS_USERNAME=${STATS_USERNAME:-}
R2_ACCOUNT_ID=${R2_ACCOUNT_ID:-}
# ... and many others
```

if you need different values for docker deployment, you must set the standard variable names directly.

### practical implications

**for local development:**
- you can use `PROD_*` prefixed variables for any configuration
- perfect for running test and prod bots simultaneously with different configs

**for docker deployment:**
- use `PROD_*` prefix only for: `DISCORD_TOKEN`, `CLIENT_ID`, `POSTGRES_DB`, `GIF_STORAGE_PATH`
- use standard variable names for all other configuration
- if you need different configs, you may need separate docker-compose files or environment files

### example: same config, different methods

**local deployment with `npm run bot:prod:webui`:**
```env
PROD_DISCORD_TOKEN=prod_token
PROD_CLIENT_ID=prod_client_id
PROD_MAX_GIF_DURATION=60
PROD_GIF_QUALITY=high
PROD_R2_BUCKET_NAME=prod-bucket
```

**docker deployment with `npm run docker:up`:**
```env
PROD_DISCORD_TOKEN=prod_token           # supports PROD_ prefix
PROD_CLIENT_ID=prod_client_id          # supports PROD_ prefix
PROD_GIF_STORAGE_PATH=./data-prod      # supports PROD_ prefix
PROD_GRONKA_DB_PATH=./data-prod/gronka.db  # supports PROD_ prefix

MAX_GIF_DURATION=60                    # standard name (no prefix)
GIF_QUALITY=high                       # standard name (no prefix)
R2_BUCKET_NAME=prod-bucket             # standard name (no prefix)
```

notice that `MAX_GIF_DURATION`, `GIF_QUALITY`, and `R2_BUCKET_NAME` use standard names in docker, not `PROD_*` prefixes.

## example configuration

complete example `.env` file:

```env
# required
DISCORD_TOKEN=your_discord_token
CLIENT_ID=your_client_id

# storage
GIF_STORAGE_PATH=./data-prod
CDN_BASE_URL=https://cdn.example.com/gifs

# r2 (optional)
R2_ACCOUNT_ID=your_account_id
R2_ACCESS_KEY_ID=your_access_key
R2_SECRET_ACCESS_KEY=your_secret_key
R2_BUCKET_NAME=gronka-media
R2_PUBLIC_DOMAIN=https://cdn.example.com

# r2 temporary uploads (optional)
R2_TEMP_UPLOADS_ENABLED=false
R2_TEMP_UPLOAD_TTL_HOURS=72
R2_CLEANUP_ENABLED=false
R2_CLEANUP_INTERVAL_MS=3600000
R2_CLEANUP_LOG_LEVEL=detailed

# processing
MAX_GIF_WIDTH=720
MAX_GIF_DURATION=30
DEFAULT_FPS=30
RATE_LIMIT=10

# file size limits
MAX_VIDEO_SIZE=104857600
MAX_IMAGE_SIZE=52428800
GIF_QUALITY=medium

# server
SERVER_PORT=3000
SERVER_HOST=0.0.0.0
STATS_USERNAME=admin
STATS_PASSWORD=secure_password
STATS_CACHE_TTL=300000

# webui
WEBUI_PORT=3001
WEBUI_HOST=127.0.0.1

# database
GRONKA_DB_PATH=./data-prod/gronka.db

# logging
LOG_DIR=./logs
LOG_LEVEL=INFO
LOG_ROTATION=daily

# cobalt
COBALT_API_URL=http://cobalt:9000
COBALT_ENABLED=true

# admin
ADMIN_USER_IDS=123456789012345678

# notifications
NTFY_TOPIC=gronka-notifications
```

## example test/prod bot configuration

complete example `.env` file for running both test and production bots:

```env
# test bot credentials
TEST_DISCORD_TOKEN=test_bot_token_here
TEST_CLIENT_ID=test_client_id_here

# prod bot credentials
PROD_DISCORD_TOKEN=prod_bot_token_here
PROD_CLIENT_ID=prod_client_id_here

# test bot configuration
TEST_GIF_STORAGE_PATH=./data-test
TEST_CDN_BASE_URL=http://localhost:3000/gifs
TEST_POSTGRES_DB=gronka_test
TEST_ADMIN_USER_IDS=123456789012345678

# prod bot configuration
PROD_GIF_STORAGE_PATH=./data-prod
PROD_CDN_BASE_URL=https://cdn.example.com/gifs
PROD_POSTGRES_DB=gronka
PROD_ADMIN_USER_IDS=987654321098765432

# test bot file size limits
TEST_MAX_VIDEO_SIZE=52428800
TEST_MAX_IMAGE_SIZE=26214400
TEST_GIF_QUALITY=low

# prod bot file size limits
PROD_MAX_VIDEO_SIZE=104857600
PROD_MAX_IMAGE_SIZE=52428800
PROD_GIF_QUALITY=medium

# test bot processing
TEST_MAX_GIF_WIDTH=480
TEST_MAX_GIF_DURATION=15
TEST_DEFAULT_FPS=15
TEST_RATE_LIMIT=5

# prod bot processing
PROD_MAX_GIF_WIDTH=720
PROD_MAX_GIF_DURATION=30
PROD_DEFAULT_FPS=30
PROD_RATE_LIMIT=10

# test bot server
TEST_SERVER_PORT=3000
TEST_SERVER_HOST=127.0.0.1
TEST_STATS_USERNAME=test_admin
TEST_STATS_PASSWORD=test_password

# prod bot server
PROD_SERVER_PORT=3000
PROD_SERVER_HOST=0.0.0.0
PROD_STATS_USERNAME=admin
PROD_STATS_PASSWORD=secure_password

# test bot webui
TEST_WEBUI_PORT=3002
TEST_WEBUI_HOST=127.0.0.1

# prod bot webui
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

# test bot r2 (optional)
TEST_R2_BUCKET_NAME=gronka-test-media
TEST_R2_PUBLIC_DOMAIN=https://test-cdn.example.com

# prod bot r2 (optional)
PROD_R2_BUCKET_NAME=gronka-prod-media
PROD_R2_PUBLIC_DOMAIN=https://cdn.example.com

# shared cobalt (or use prefixed versions)
COBALT_API_URL=http://cobalt:9000
COBALT_ENABLED=true
```
