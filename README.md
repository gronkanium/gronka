# gronka

![Bun](https://img.shields.io/badge/Bun-1.3-fbf0df?logo=bun&logoColor=fbf0df)
![Discord.js](https://img.shields.io/badge/Discord.js-14-5865F2?logo=discord&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)
[![Add to Discord](https://img.shields.io/badge/Add_to_Discord-5865F2?logo=discord&logoColor=white)](https://discord.com/oauth2/authorize?client_id=1522194017692156046)
[![Docs](https://img.shields.io/badge/read-docs-blue)](https://github.com/thedorekaczynski/gronka/wiki)
[![FFmpeg](https://img.shields.io/badge/FFmpeg-007808?logo=ffmpeg&logoColor=white)](https://ffmpeg.org/)
[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/thedorekaczynski/gronka)

a discord bot that downloads media from social platforms and direct urls, converts it to gifs, and optimizes gifs.

## commands

- `/download` — download a video/image from a social url (no conversion)
- `/convert` — attach a file or paste a url and convert it to a gif (quality preset `low`/`medium`/`high`, optional `optimize`, optional `lossy` 0-100, and `start_time`/`end_time` trimming for videos)
- `/optimize` — shrink an existing gif with lossy compression (`lossy` 0-100, default 35)
- `/stats` — storage and usage statistics
- `/info` — system info, cache stats, and configuration

the same three actions are also available by right-clicking a message → apps: **convert to gif**, **download**, and **optimize**.

### supported sources

- **cobalt** handles most social platforms: twitter/x, tiktok, instagram, youtube, reddit, facebook, twitch clips, soundcloud, tumblr, streamable, dailymotion, snapchat
- **yt-dlp** handles youtube, redgifs, imgur, kick, coub, rumble, newgrounds, niconico, bilibili, and the adult tube sites (pornhub, xvideos, xhamster, redtube); it is also the fallback for x/twitter and tiktok
- **pinterest** — a dedicated extractor for pins and `pin.it` share links (neither cobalt nor yt-dlp can read pinterest); grabs the pin's video, or its full-size image
- **Klipy** — a dedicated page-metadata extractor for Klipy GIF and sticker pages; downloads the page's video or image directly
- **booru boards** — danbooru, e621/e926, yande.re, and konachan posts via their JSON APIs
  (grabs the post's original file)
- direct urls to video/image files work with `/convert`

each source can be turned on/off individually from the webui **sources** page (in the sidebar); a turned-off source refuses `/download` with a short message.

video inputs: mp4, mov, webm, avi, mkv. image inputs: png, jpg, jpeg, webp, gif.

## how it works

- **discord bot** — lives in your server, downloads media, and runs the conversions (ffmpeg for video→gif, gifsicle for gif optimization)
- **storage** — files under discord's 8mb attachment limit are sent inline; larger files are uploaded to cloudflare r2 (optional) and delivered as a temporary url, falling back to local disk if r2 isn't configured or an upload fails
- **webui** — a small stats dashboard, served automatically alongside the bot

downloaded media is stored so a repeat of the same url skips re-downloading and re-converting.

### size limits

non-admin downloads are rejected above a hard ceiling (`MAX_VIDEO_SIZE`, default 1gb; `MAX_IMAGE_SIZE`, default 50mb). files delivered via r2 get a temporary url whose lifetime shrinks as size grows (roughly 72h for ≤100mb down to 2h at 1gb), keeping storage costs bounded. admins bypass the download ceiling; conversion and optimization limits still apply. users always see a clear message when a limit is hit.

## getting started

docker is the supported way to run gronka — the image bundles ffmpeg, gifsicle, and yt-dlp.

```bash
git clone https://github.com/thedorekaczynski/gronka.git
cd gronka
cp .env.example .env      # then edit it (see configuration below)
touch tiktok-cookies.txt  # bind-mounted as a file; docker mounts a directory if it's missing
docker compose up -d
docker compose run --rm app bun run register-commands   # once, to register slash commands
```

the stats dashboard is then available at `http://localhost:3001`.

> running the bot outside docker is possible for development but needs bun 1.3+, ffmpeg, and yt-dlp installed yourself; `/optimize` also needs gifsicle (linux/macOS, or docker on windows). see the [wiki](https://github.com/thedorekaczynski/gronka/wiki) for the local development workflow.

## configuration

everything lives in `.env`. the only required values are your discord credentials:

- `DISCORD_TOKEN` — bot token from the [discord developer portal](https://discord.com/developers/applications)
- `CLIENT_ID` — the application id from the same place

two optional values are worth setting before you invite anyone:

- `SUPPORT_INVITE_URL` — your own discord server. `/info` links it and the ban-appeal embed sends appeals there; leave it empty and neither surface mentions a server at all
- `ADMIN_USER_IDS` — comma-separated discord user ids that bypass rate limits and size caps

`.env.example` uses `PROD_`/`TEST_` prefixes so one file can hold two bot instances; the docker setup and the `bot:prod`/`bot:test` scripts map the chosen prefix onto the plain names above. everything else is optional and documented inline in `.env.example`.

### cloudflare r2 (optional)

set these to store and serve larger files from r2 instead of local disk:

- `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`
- `R2_PUBLIC_DOMAIN` — public domain for the bucket (e.g. `cdn.example.com`)

optional background cleanup (`R2_TEMP_UPLOADS_ENABLED`, `R2_CLEANUP_ENABLED`) deletes expired uploads on a schedule. see the [r2 storage docs](https://github.com/thedorekaczynski/gronka/wiki/R2-Storage).

## development

```bash
bun run lint          # eslint, no warnings allowed
bun run format        # prettier
bun run validate      # lock-sync + lint + format check
bun run test:safe     # full test suite (needs postgres up)
bun run test:e2e      # mocked-network download pipeline
```

plain esm javascript (no typescript). full docs, including the deploy cycle and architecture, live in the [wiki](https://github.com/thedorekaczynski/gronka/wiki).

## license

MIT
