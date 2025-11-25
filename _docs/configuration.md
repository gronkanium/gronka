---
layout: doc
title: configuration
description: complete reference for all configuration options
topic: reference
chapter: 2
---

all environment variables and configuration options for gronka.

## required variables

these must be set for the bot to function:

### `DISCORD_TOKEN`

discord bot token from the developer portal.

**where to get it:**

1. go to https://discord.com/developers/applications
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

1. go to https://discord.com/developers/applications
2. select your application
3. go to "general information"
4. copy the "application id"

**example:**

```env
CLIENT_ID=1234567890123456789
```

## test and prod bot configuration

for local development, you can run both test and prod bots simultaneously using prefixed environment variables.

### `TEST_DISCORD_TOKEN` / `TEST_CLIENT_ID`

credentials for the test bot instance.

**usage:** use with `npm run bot:test` or `npm run bot:test:dev`

**example:**

```env
TEST_DISCORD_TOKEN=your_test_bot_token_here
TEST_CLIENT_ID=your_test_bot_client_id_here
```

### `PROD_DISCORD_TOKEN` / `PROD_CLIENT_ID`

credentials for the prod bot instance.

**usage:** use with `npm run bot:prod` or `npm run bot:prod:dev`

**example:**

```env
PROD_DISCORD_TOKEN=your_prod_bot_token_here
PROD_CLIENT_ID=your_prod_bot_client_id_here
```

### prefixed configuration variables

you can use prefixed versions of any configuration variable for bot-specific settings:

- `TEST_*` prefix for test bot (e.g., `TEST_ADMIN_USER_IDS`, `TEST_CDN_BASE_URL`)
- `PROD_*` prefix for prod bot (e.g., `PROD_ADMIN_USER_IDS`, `PROD_CDN_BASE_URL`)

**supported prefixed variables:**

- `TEST_ADMIN_USER_IDS` / `PROD_ADMIN_USER_IDS`
- `TEST_CDN_BASE_URL` / `PROD_CDN_BASE_URL`
- `TEST_GIF_STORAGE_PATH` / `PROD_GIF_STORAGE_PATH`
- `TEST_COBALT_API_URL` / `PROD_COBALT_API_URL`
- `TEST_COBALT_ENABLED` / `PROD_COBALT_ENABLED`
- `TEST_R2_*` / `PROD_R2_*` (all r2 variables)
- and any other configuration variable

**example:**

```env
# test bot uses separate storage and admin users
TEST_GIF_STORAGE_PATH=./data-test
TEST_ADMIN_USER_IDS=123456789,987654321

# prod bot uses production settings
PROD_GIF_STORAGE_PATH=./data-prod
PROD_CDN_BASE_URL=https://cdn.prod.example.com/gifs
PROD_ADMIN_USER_IDS=111222333
```

## storage configuration

### `GIF_STORAGE_PATH`

path to store gifs, videos, and images locally.

**default:** `./data`

**example:**

```env
GIF_STORAGE_PATH=/var/www/gifs
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

## example configuration

complete example `.env` file:

```env
# required (for default bot)
DISCORD_TOKEN=your_discord_token
CLIENT_ID=your_client_id

# test bot configuration (for local development)
TEST_DISCORD_TOKEN=your_test_bot_token
TEST_CLIENT_ID=your_test_bot_client_id
TEST_GIF_STORAGE_PATH=./data-test
TEST_ADMIN_USER_IDS=123456789,987654321

# prod bot configuration (for local development)
PROD_DISCORD_TOKEN=your_prod_bot_token
PROD_CLIENT_ID=your_prod_bot_client_id
PROD_GIF_STORAGE_PATH=./data-prod
PROD_CDN_BASE_URL=https://cdn.prod.example.com/gifs
PROD_ADMIN_USER_IDS=111222333

# storage (default, used if prefixed version not set)
GIF_STORAGE_PATH=./data
CDN_BASE_URL=https://cdn.example.com/gifs

# r2 (optional)
R2_ACCOUNT_ID=your_account_id
R2_ACCESS_KEY_ID=your_access_key
R2_SECRET_ACCESS_KEY=your_secret_key
R2_BUCKET_NAME=gronka-media
R2_PUBLIC_DOMAIN=https://cdn.example.com

# processing
MAX_GIF_WIDTH=720
MAX_GIF_DURATION=30
DEFAULT_FPS=30

# server
SERVER_PORT=3000
STATS_USERNAME=admin
STATS_PASSWORD=secure_password
STATS_CACHE_TTL=300000

# cobalt (for local dev, use http://localhost:9000)
COBALT_API_URL=http://localhost:9000
COBALT_ENABLED=true

# admin (default)
ADMIN_USER_IDS=123456789012345678

# notifications
NTFY_TOPIC=gronka-notifications

# logging
LOG_DIR=./logs
LOG_LEVEL=INFO
LOG_ROTATION=daily

# webui
WEBUI_PORT=3001
WEBUI_HOST=127.0.0.1
MAIN_SERVER_URL=http://localhost:3000
```

