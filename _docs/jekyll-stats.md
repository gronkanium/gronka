---
layout: doc
title: jekyll stats
permalink: /docs/jekyll-stats/
topic: reference
chapter: 5
description: jekyll site footer statistics display system
---

# jekyll stats

jekyll site footer statistics display system. shows 24-hour activity stats in the site footer: "in the past 24 hours, x users have processed x files amounting to x data". stats are fetched from the discord bot's database via api endpoint and automatically updated every time the jekyll site is rebuilt.

## architecture

the system has three parts:

1. **bot server api endpoint** (`/api/stats/24h`): exposes 24-hour statistics from the sqlite database
2. **polling script** (`scripts/update-jekyll-stats.js`): fetches stats from bot api and writes to `_data/stats.json`
3. **jekyll footer** (`_includes/footer.html`): displays stats from the json data file

## how it works

1. the discord bot server runs on one machine and exposes `/api/stats/24h` endpoint
2. the jekyll site runs on a different server (accessible over local network)
3. a polling script runs before each jekyll build (via `scripts/update-jekyll-site.sh`) to fetch stats from the bot api
4. the script writes the stats to `_data/stats.json` in the jekyll site directory
5. jekyll reads this file during build and displays stats in the footer
6. when you rebuild jekyll (via your existing cron job), the latest stats are included

## integration with cron job

the stats update is automatically integrated into your existing jekyll rebuild cron job. the `scripts/update-jekyll-site.sh` script has been updated to:

- update stats from bot api **before** building jekyll
- continue with build even if stats update fails (graceful degradation)
- log all stats update attempts and results

this ensures stats are always fresh when the site rebuilds. this is more efficient than running two separate cron jobs.

## setup

### step 1: environment variables

on the jekyll server, set these environment variables in your `.env` file:

```env
# bot api url - use the local ip address of the bot server
BOT_API_URL=http://YOUR_BOT_SERVER_LOCAL_IP:3000

# optional: basic auth credentials (if STATS_USERNAME/STATS_PASSWORD are set on bot server)
STATS_USERNAME=your-username
STATS_PASSWORD=your-password
```

**notes:**

- use the **local network ip** of the bot server (e.g., `192.168.0.20:3000`), not `localhost`
- the bot server must be accessible from the jekyll server over the local network
- if `STATS_USERNAME` and `STATS_PASSWORD` are not set on the bot server, you can omit these env vars
- the bot server's `/api/stats/24h` endpoint uses basic auth if credentials are configured

### step 2: verify bot server api is accessible

test that the jekyll server can reach the bot api:

```bash
# from jekyll server, test the api endpoint
curl http://YOUR_BOT_SERVER_LOCAL_IP:3000/api/stats/24h

# if auth is required, test with credentials:
curl -u "username:password" http://YOUR_BOT_SERVER_LOCAL_IP:3000/api/stats/24h
```

you should see json output like:

```json
{
  "unique_users": 42,
  "total_files": 123,
  "total_data_bytes": 1234567890,
  "total_data_formatted": "1.15 GB",
  "period": "24 hours",
  "last_updated": 1234567890
}
```

### step 3: test the polling script manually

before relying on the automated cron job, test the script manually:

```bash
# from jekyll site directory
cd /path/to/jekyll/site

# run the script
npm run jekyll:update-stats

# check that stats.json was created/updated
cat _data/stats.json
```

the script should:
- fetch stats from the bot api
- write to `_data/stats.json`
- display success message with stats summary

### step 4: verify integration with update script

the `scripts/update-jekyll-site.sh` script automatically runs stats update before building. test the full flow:

```bash
# run the update script (it will update stats, then build)
bash scripts/update-jekyll-site.sh
```

check the logs to verify:
- stats update was attempted
- stats update succeeded (or gracefully failed)
- jekyll build completed
- stats appear in the built site footer

### step 5: verify stats in built site

after building, verify stats appear in the footer:

```bash
# build the site
bundle exec jekyll build

# check the footer in the built site
grep -A 1 "past 24 hours" _site/index.html
```

you should see output like:

```html
In the past 24 hours, 1 user has processed 1 file amounting to 2.03 MB
```

**note:** the footer uses proper grammar - "user has" for count = 1, "users have" for count > 1, and "file" vs "files" accordingly.

## troubleshooting

### stats not updating

1. **check bot server is running**: `curl http://YOUR_BOT_SERVER_LOCAL_IP:3000/health`
2. **check api endpoint**: `curl http://YOUR_BOT_SERVER_LOCAL_IP:3000/api/stats/24h`
3. **check network connectivity**: can jekyll server ping bot server?
4. **check file permissions**: can the script write to `_data/stats.json`?
5. **check logs**: look at `logs/jekyll-update.log` for errors
6. **check environment variables**: verify `BOT_API_URL` is set correctly in `.env`

### stats show zero or old data

1. **verify bot has processed files**: check bot database has recent entries in `processed_urls` table
2. **check time window**: stats are for last 24 hours from current time
3. **verify file was updated**: check `_data/stats.json` modification time
4. **check jekyll rebuild**: stats file must exist before jekyll builds
5. **verify api response**: test the endpoint directly with curl

### authentication errors

1. **verify credentials match**: `STATS_USERNAME` and `STATS_PASSWORD` on jekyll server must match bot server
2. **check bot server config**: verify `STATS_USERNAME` and `STATS_PASSWORD` are set on bot server
3. **test with curl**: use curl with `-u` flag to test authentication
4. **check basic auth**: ensure both username and password are provided if auth is enabled

### script fails but build continues

this is expected behavior - the update script is designed to continue even if stats update fails. check:

1. **logs**: review `logs/jekyll-update.log` for warning messages
2. **network issues**: bot server may be temporarily unavailable
3. **api errors**: check bot server logs for api endpoint errors
4. **last known stats**: jekyll will use the last successfully updated stats file

### stats not appearing in footer

1. **check stats file exists**: `cat _data/stats.json`
2. **verify jekyll build**: rebuild jekyll and check footer in built site
3. **check footer template**: verify `_includes/footer.html` has the stats display code
4. **verify stats data format**: stats.json should have required fields

## file locations

- **polling script**: `scripts/update-jekyll-stats.js`
- **stats data file**: `_data/stats.json` (created/updated by polling script)
- **footer template**: `_includes/footer.html` (displays stats)
- **update script**: `scripts/update-jekyll-site.sh` (integrates stats update)
- **api endpoint**: `src/server.js` (bot server, `/api/stats/24h`)
- **database function**: `src/utils/database/stats.js` (queries sqlite)
- **log file**: `logs/jekyll-update.log` (update script logs)

## api endpoint

**endpoint**: `GET /api/stats/24h`

**authentication**: basic auth (if `STATS_USERNAME` and `STATS_PASSWORD` are configured on bot server)

**rate limiting**: 60 requests per 15 minutes (should be plenty for hourly polling)

**response:**

```json
{
  "unique_users": 42,
  "total_files": 123,
  "total_data_bytes": 1234567890,
  "total_data_formatted": "1.15 GB",
  "period": "24 hours",
  "last_updated": 1234567890
}
```

**response fields:**

- `unique_users` (number): number of unique users who processed files in the last 24 hours
- `total_files` (number): total number of files processed in the last 24 hours
- `total_data_bytes` (number): total data processed in bytes
- `total_data_formatted` (string): human-readable data size (e.g., "1.15 GB")
- `period` (string): always "24 hours"
- `last_updated` (number): unix timestamp of when stats were calculated

**status codes:**

- `200` - success
- `401` - unauthorized (if auth is required but not provided)
- `429` - too many requests (rate limit exceeded)
- `500` - server error

**example:**

```bash
# without authentication (if not configured)
curl http://192.168.0.212:3000/api/stats/24h

# with basic auth
curl -u "admin:password" http://192.168.0.212:3000/api/stats/24h

# with verbose output for debugging
curl -v -u "admin:password" http://192.168.0.212:3000/api/stats/24h
```

## environment variables

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

## npm scripts

### `jekyll:update-stats`

updates jekyll site statistics from bot api.

**usage:**

```bash
npm run jekyll:update-stats
```

**what it does:**

1. loads environment variables from `.env` file
2. fetches stats from `${BOT_API_URL}/api/stats/24h`
3. writes stats to `_data/stats.json`
4. displays success message with stats summary

**environment variables used:**

- `BOT_API_URL` (required)
- `STATS_USERNAME` (optional, if auth required)
- `STATS_PASSWORD` (optional, if auth required)

**exit codes:**

- `0` - success
- `1` - error (api failure, network error, file write error)

## cron job integration

the stats update is automatically integrated into the existing jekyll update cron job. your crontab should look like:

```bash
0 * * * * cd /home/p1x/docker/esm && ./scripts/update-jekyll-site.sh >> logs/jekyll-update.log 2>&1
```

this cron job will:

1. check for git updates
2. pull latest changes if available
3. **update stats from bot api** (new)
4. build jekyll site
5. deploy the updated site

the stats update happens automatically before each build, ensuring fresh stats on every deployment.

## grammar and display

the footer automatically handles singular/plural forms:

- **1 user has** processed **1 file** (singular)
- **2 users have** processed **5 files** (plural)

this is handled in the jekyll template using conditional logic:

```liquid
{% if user_count == 1 %}user has{% else %}users have{% endif %}
{% if file_count == 1 %}file{% else %}files{% endif %}
```

## summary

1. set `BOT_API_URL` environment variable to bot server's local ip
2. optionally set `STATS_USERNAME` and `STATS_PASSWORD` if bot requires auth
3. the `scripts/update-jekyll-site.sh` script automatically updates stats before building
4. stats are displayed in the jekyll site footer with proper grammar
5. stats update every time jekyll rebuilds (via cron job or manual rebuild)
6. the system is designed to fail gracefully - if stats can't be fetched, jekyll will use the last known stats or defaults, so the site will still build successfully

the system is fully automated and requires no manual intervention once configured. stats will update automatically with each site rebuild.

