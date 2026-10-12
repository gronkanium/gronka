# configuration

everything is set in `.env`. `bun run setup` writes it for you; [`.env.example`](https://github.com/gronkanium/gronka/blob/master/.env.example) lists every key.

`.env` holds two bots: names prefixed `PROD_` are the docker bot, `TEST_` the [[Test-Bot]]. the app itself reads plain names (`DISCORD_TOKEN`, `CLIENT_ID`, ...); `docker-compose.yml` and `bun run bot:test` copy the right prefix onto them.

## what gronka keeps

nothing about who uses it. files are processed in a temporary folder and deleted when the request ends; a file too big for a discord attachment is uploaded to r2 under a random name and deleted when its time is up. the database holds settings, the media job queue (a row lives only while its job runs), anonymous hourly command counts, and failure records (command, full link, error, steps tried) for `RETENTION_DAYS`, never tied to a user. logs go to the console.

## discord

| key | default | what it does |
| --- | --- | --- |
| `PROD_DISCORD_TOKEN` / `TEST_DISCORD_TOKEN` | | bot token from the developer portal |
| `PROD_CLIENT_ID` / `TEST_CLIENT_ID` | | application id |
| `COMMAND_PREFIX` | `^g` | prefix for message commands in dms; in servers, mention the bot |
| `SUPPORT_INVITE_URL` | | your support server, shown in `/info`; leave empty to show none |

## media

| key | default | what it does |
| --- | --- | --- |
| `MAX_VIDEO_SIZE` | 1 GB | largest download, in bytes (the webui setting overrides it) |
| `MAX_IMAGE_SIZE` | 50 MB | largest image, in bytes |
| `DISCORD_SIZE_LIMIT` | 8 MB | fallback attachment limit when discord does not say |
| `COBALT_ENABLED`, `COBALT_API_URL` | `true`, `http://cobalt:9000` | the cobalt instance downloads go through |
| `YTDLP_ENABLED`, `YTDLP_QUALITY` | `true` | yt-dlp for youtube and the sites cobalt does not cover |
| `GALLERY_DL_ENABLED` | `true` | gallery-dl for manga and galleries |
| `YTDLP_COOKIES_PATH`, `INSTAGRAM_COOKIES_PATH` | | logins for gated content, see [[Cookies]] |
| `MEDIA_WORKERS` | `true` in docker | run media jobs in the worker containers; `false` runs them in the bot |

## geo-blocked sources (optional)

`GEO_PROXY_URL` sends Pornhub, xHamster and RedTube through an HTTP proxy. Other sources use their usual connection. The `vpn` profile provides a Mullvad WireGuard tunnel: set `COMPOSE_PROFILES=vpn`, `VPN_WIREGUARD_PRIVATE_KEY`, `VPN_WIREGUARD_ADDRESSES` and `GEO_PROXY_URL=http://vpn:8888` in `.env`, then run `docker compose up -d vpn`.

The hosted web backend can use that same tunnel with the tracked VPN overlay:

```bash
docker compose -f docker-compose.web.yml -f web/docker-compose.vpn.yml \
  --env-file .env --env-file .env.web up -d gronka-web
```

The bot stack creates the private proxy network; only its VPN and the web backend join it. Their databases stay on separate networks. `GEO_PROXY_NETWORK` changes the shared network name (default `gronka-geo-proxy`); both stacks must use the same value. Start the bot's VPN first, and include the overlay whenever updating the web backend. Without the overlay, the web stack has no shared network dependency. To use a separately reachable proxy without the overlay, set `WEB_GEO_PROXY_URL` in `.env.web`.

## r2 (optional)

without r2, files too big for a discord attachment are refused. with it, they are uploaded and linked. see [[R2-Storage]].

| key | default | what it does |
| --- | --- | --- |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` | | bucket credentials |
| `R2_PUBLIC_DOMAIN` | | the bucket's public domain, without `https://` |
| `R2_CLEANUP_ENABLED` | `false` | delete each upload once it is older than its size tier (the "upload lifetime tiers" webui setting) |
| `R2_CLEANUP_INTERVAL_MS` | 1 hour | how often the cleanup runs |

## retention and logging

| key | default | what it does |
| --- | --- | --- |
| `RETENTION_ENABLED` | `true` | delete failure records after `RETENTION_DAYS` |
| `RETENTION_DAYS` | `7` | how long a failure record is kept |
| `RETENTION_INTERVAL_MS` | 6 hours | how often the retention job runs |
| `LOG_LEVEL` | `INFO` | console log level; per-request detail is `DEBUG` and off by default |

## ports and database

| key | default | what it does |
| --- | --- | --- |
| `PROD_SERVER_PORT` / `SERVER_PORT` | `3000` | `/health` and `/api/bot/status` |
| `PROD_WEBUI_PORT` / `WEBUI_PORT` | `3001` | the webui |
| `PROD_POSTGRES_*` / `TEST_POSTGRES_*` | | postgres host, port, user, password and database |
| `STATS_CACHE_TTL` | 5 minutes | how long the webui and `/info` reuse the r2 file count |

## webui settings

some limits are changed live in the webui instead of `.env`, see [[Bot-Settings]].
