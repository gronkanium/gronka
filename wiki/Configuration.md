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

**default:** `./data-prod` (production) or `./data-test` (testing)

**notes:**

- for production deployments, use `./data-prod` or a custom path
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
```

## server configuration

### `SERVER_PORT`

port for the express server.

**default:** `3000`

**example:**

```env
SERVER_PORT=3000
```

### `STATS_USERNAME`

username for basic auth on `/stats` endpoint.

**optional**

**example:**

```env
STATS_USERNAME=admin
```

### `STATS_PASSWORD`

password for basic auth on `/stats` endpoint.

**optional** (recommended if `STATS_USERNAME` is set)

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

- `TEST_DISCORD_TOKEN` / `PROD_DISCORD_TOKEN`
- `TEST_CLIENT_ID` / `PROD_CLIENT_ID`
- `TEST_GIF_STORAGE_PATH` / `PROD_GIF_STORAGE_PATH`
- `TEST_GRONKA_DB_PATH` / `PROD_GRONKA_DB_PATH`
- `TEST_CDN_BASE_URL` / `PROD_CDN_BASE_URL`
- `TEST_ADMIN_USER_IDS` / `PROD_ADMIN_USER_IDS`
- `TEST_R2_BUCKET_NAME` / `PROD_R2_BUCKET_NAME`
- and any other configuration variable

### database separation

each bot uses a separate database file:

- test bot: `gronka-test.db` (in `data-test/` or path specified by `TEST_GRONKA_DB_PATH`)
- prod bot: `gronka-prod.db` (in `data-prod/` or path specified by `PROD_GRONKA_DB_PATH`)

if `GRONKA_DB_PATH` is not explicitly set via prefix, it's automatically derived from the storage path.

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

# server
SERVER_PORT=3000
STATS_USERNAME=admin
STATS_PASSWORD=secure_password
STATS_CACHE_TTL=300000

# cobalt
COBALT_API_URL=http://cobalt:9000
COBALT_ENABLED=true

# admin
ADMIN_USER_IDS=123456789012345678

# notifications
NTFY_TOPIC=gronka-notifications
```
