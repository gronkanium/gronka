# api endpoints

gronka has a minimal http server built into the bot process that provides a stats endpoint for jekyll site integration. files are served directly from r2 or discord (no local file serving).

## architecture

as of version 0.13.0, the standalone express server (`src/server.js`) has been removed. the bot now includes a minimal http server that only serves `/api/stats/24h` for jekyll site integration.

- **bot process**: discord bot + minimal stats http server (port 3000)
- **webui process**: dashboard interface (port 3001) - calculates stats directly from database/filesystem
- **files**: served directly from r2 or discord attachments (no http endpoints)

## base url

the stats endpoint runs on port 3000 (configurable via `SERVER_PORT`):

```
http://localhost:3000
```

## endpoints

### `GET /api/stats/24h`

get 24-hour activity statistics for jekyll site footer.

**authentication:**

if `STATS_USERNAME` and `STATS_PASSWORD` are configured, basic auth is required. this endpoint is publicly accessible (not restricted to internal network).

**purpose:**

returns statistics about user activity in the past 24 hours, including unique users, total files processed, and total data processed. this endpoint is designed for use by the jekyll site stats polling script.

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
- `500` - server error

**example:**

```bash
# without auth (if not configured)
curl http://localhost:3000/api/stats/24h

# with auth
curl -u admin:password http://localhost:3000/api/stats/24h

# with verbose output for debugging
curl -v -u admin:password http://localhost:3000/api/stats/24h
```

**use cases:**

- jekyll site footer statistics display
- automated stats polling via `scripts/update-jekyll-stats.js`
- monitoring 24-hour activity trends

**notes:**

- stats are calculated in real-time from the database
- the 24-hour window is based on the current time when the request is made

## webui endpoints

the webui dashboard (port 3001) has its own health and stats endpoints for internal use:

- `GET /api/health` - webui health check
- `GET /api/stats` - storage statistics (calculated directly from database/filesystem)

these are for dashboard use only and are not intended for external consumption.

## r2 storage

when r2 is configured, files are served directly from your r2 public domain:

- `{R2_PUBLIC_DOMAIN}/gifs/{hash}.gif`
- `{R2_PUBLIC_DOMAIN}/videos/{hash}.{ext}`
- `{R2_PUBLIC_DOMAIN}/images/{hash}.{ext}`

## discord attachments

files smaller than 8mb are uploaded as discord attachments and served directly from discord's cdn.

## security

when exposing the stats endpoint publicly:

- use a reverse proxy (nginx, caddy, etc.)
- enable authentication with `STATS_USERNAME` and `STATS_PASSWORD`
- use https (via reverse proxy)
- consider additional rate limiting at the reverse proxy level

the stats server binds to `0.0.0.0` by default (configurable via `SERVER_HOST`), making it accessible from the network.

## migration notes

if upgrading from version < 0.13.0:

- the standalone `src/server.js` has been removed
- file serving endpoints (`/gifs/*`, `/videos/*`, `/images/*`) are gone - files are now served from r2 or discord only
- health and storage stats endpoints (`/health`, `/stats`, `/api/stats`, `/api/health`) have been removed or moved to webui
- only `/api/stats/24h` remains for jekyll integration
- the bot now starts the stats http server automatically
- docker healthcheck changed from http check to process check
