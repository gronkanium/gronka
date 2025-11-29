---
layout: doc
title: api endpoints
description: http api endpoints for the local server
topic: reference
chapter: 3
---

the express server provides http endpoints for serving files and checking status. these endpoints are only available when using local storage (not r2).

## base url

all endpoints are relative to the server base url. default port is 3000.

```
http://localhost:3000
```

## endpoints

### `GET /health`

check if the server is running.

**response:**

```json
{
  "status": "ok",
  "uptime": 12345
}
```

**status codes:**

- `200` - server is healthy
- `500` - server error

**example:**

```bash
curl http://localhost:3000/health
```

### `GET /stats`

get storage statistics.

**authentication:**

if `STATS_USERNAME` and `STATS_PASSWORD` are configured, basic auth is required.

**response:**

```json
{
  "total_gifs": 1234,
  "total_videos": 567,
  "total_images": 890,
  "disk_usage_bytes": 1234567890,
  "disk_usage_formatted": "1.15 GB"
}
```

**status codes:**

- `200` - success
- `401` - unauthorized (if auth is required)
- `500` - server error

**example:**

```bash
# without auth
curl http://localhost:3000/stats

# with auth
curl -u admin:password http://localhost:3000/stats
```

**caching:**

stats are cached for 5 minutes by default (configurable via `STATS_CACHE_TTL`). set to `0` to disable caching.

### `GET /api/stats/24h`

get 24-hour activity statistics for jekyll site footer.

**authentication:**

if `STATS_USERNAME` and `STATS_PASSWORD` are configured, basic auth is required.

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
- `429` - too many requests (rate limit exceeded)
- `500` - server error

**rate limiting:**

60 requests per 15 minutes (should be plenty for hourly polling)

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
- this endpoint is separate from `/stats` which shows storage statistics

### `GET /gifs/{hash}.gif`

serve a gif file.

**parameters:**

- `hash` - md5 hash of the gif file (filename without extension)

**response:**

- content-type: `image/gif`
- file content

**status codes:**

- `200` - file found
- `404` - file not found
- `500` - server error

**example:**

```bash
curl http://localhost:3000/gifs/abc123def456.gif
```

**caching:**

files are served with cache headers for 7 days. files are immutable (hash-based names).

### `GET /videos/{hash}.{ext}`

serve a video file.

**parameters:**

- `hash` - md5 hash of the video file
- `ext` - file extension (mp4, mov, webm, etc.)

**response:**

- content-type: appropriate video mime type
- file content

**status codes:**

- `200` - file found
- `404` - file not found
- `500` - server error

**example:**

```bash
curl http://localhost:3000/videos/abc123def456.mp4
```

### `GET /images/{hash}.{ext}`

serve an image file.

**parameters:**

- `hash` - md5 hash of the image file
- `ext` - file extension (png, jpg, jpeg, webp, gif)

**response:**

- content-type: appropriate image mime type
- file content

**status codes:**

- `200` - file found
- `404` - file not found
- `500` - server error

**example:**

```bash
curl http://localhost:3000/images/abc123def456.jpg
```

### `GET /`

get api information.

**response:**

```json
{
  "name": "gronka",
  "version": "1.0.0",
  "endpoints": {
    "health": "/health",
    "stats": "/stats",
    "gifs": "/gifs/{hash}.gif",
    "videos": "/videos/{hash}.{ext}",
    "images": "/images/{hash}.{ext}"
  }
}
```

**status codes:**

- `200` - success

**example:**

```bash
curl http://localhost:3000/
```

## r2 storage

when r2 is configured, files are served directly from your r2 public domain instead of these endpoints. the `/health` and `/stats` endpoints still work, but file serving is handled by r2.

r2 file urls follow the same pattern:

- `{R2_PUBLIC_DOMAIN}/gifs/{hash}.gif`
- `{R2_PUBLIC_DOMAIN}/videos/{hash}.{ext}`
- `{R2_PUBLIC_DOMAIN}/images/{hash}.{ext}`

## cors

cors is enabled for all endpoints, allowing cross-origin requests. this is useful for embedding files in web pages.

## rate limiting

most api endpoints do not have rate limiting. the `/api/stats/24h` endpoint has rate limiting of 60 requests per 15 minutes. consider adding rate limiting to other endpoints if exposing the server publicly.

## security

when exposing the server publicly:

- use a reverse proxy (nginx, caddy, etc.)
- enable authentication on `/stats` and `/api/stats/24h` endpoints
- consider adding rate limiting
- use https (via reverse proxy or cloudflare r2 public domain)

the server binds to `0.0.0.0` by default, making it accessible from the network. for local development, this is fine. for production, use a reverse proxy or configure cloudflare r2 with a public domain.

