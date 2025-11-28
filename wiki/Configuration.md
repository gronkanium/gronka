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

## example configuration

complete example `.env` file:

```env
# required
DISCORD_TOKEN=your_discord_token
CLIENT_ID=your_client_id

# storage
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
