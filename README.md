# gronka

![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)
![Discord.js](https://img.shields.io/badge/Discord.js-14.14-5865F2?logo=discord&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)
[![Add to Discord](https://img.shields.io/badge/Add_to_Discord-5865F2?logo=discord&logoColor=white)](https://discord.com/oauth2/authorize?client_id=1439329052002357599)
[![Docs](https://img.shields.io/badge/read-docs-blue)](https://github.com/thedorekaczynski/gronka/wiki)
[![FFmpeg](https://img.shields.io/badge/FFmpeg-007808?logo=ffmpeg&logoColor=white)](https://ffmpeg.org/)
[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/thedorekaczynski/gronka)
[![wakatime](https://wakatime.com/badge/github/thedorekaczynski/gronka.svg)](https://wakatime.com/badge/github/thedorekaczynski/gronka)

a discord bot that downloads media from social media platforms and urls, then converts it to gifs.

## what it does

gronka downloads videos and images from social media platforms or direct urls, stores them, and can convert them to gifs.

### downloading media

download media from social platforms using the `/download` command:

- twitter/x
- tiktok
- instagram
- youtube
- reddit
- facebook
- threads

you can also download media from direct urls using `/convert` with a url parameter. the bot handles videos and images from most common sources.

### converting media

convert downloaded media or files you upload to gifs:

- video formats: mp4, mov, webm, avi, mkv
- image formats: png, jpg, jpeg, webp, gif

gifs can also be converted to gifs with different quality settings or optimizations.

## how it works

gronka consists of three components:

1. **discord bot** - the part that lives in your server, downloads media, and does the converting
2. **r2 storage** - stores and serves videos, images, and gifs via cloudflare r2 (optional, falls back to local storage)
3. **webui** (optional) - a simple dashboard to view statistics

## getting started

### running it locally

you'll need node.js 20+ and ffmpeg installed. then:

```bash
git clone https://github.com/thedorekaczynski/gronka.git
cd gronka
npm install
cp .env.example .env
```

edit `.env` and add your discord token and client id. then:

```bash
npm run register-commands
npm run local:up
```

#### local development suite

the project includes a comprehensive local development suite similar to the docker scripts:

```bash
npm run local:up        # start all services (bot, server, cobalt)
npm run local:down      # stop all services
npm run local:logs      # view logs from all services
npm run local:restart   # restart all services
npm run local:verify    # verify all services are running
npm run local:register  # register discord commands (uses default bot)
```

#### running test and prod bots

you can run both test and prod bots simultaneously for local development. configure them in your `.env` file:

```bash
# test bot credentials
TEST_DISCORD_TOKEN=your_test_bot_token
TEST_CLIENT_ID=your_test_bot_client_id

# prod bot credentials
PROD_DISCORD_TOKEN=your_prod_bot_token
PROD_CLIENT_ID=your_prod_bot_client_id
```

then use the bot-specific scripts:

```bash
npm run bot:test        # start test bot
npm run bot:prod        # start prod bot
npm run bot:test:dev    # start test bot with watch mode
npm run bot:prod:dev    # start prod bot with watch mode
npm run bot:register:test  # register commands for test bot
npm run bot:register:prod  # register commands for prod bot
```

you can also use prefixed environment variables for bot-specific configuration (e.g., `TEST_ADMIN_USER_IDS`, `PROD_CDN_BASE_URL`).

### using docker

```bash
# create your .env file first
docker compose up -d

# register discord commands (only need to do this once)
docker compose run --rm app npm run register-commands
```

## configuration

you need these two things in your `.env`:

- `DISCORD_TOKEN` - get this from the discord developer portal
- `CLIENT_ID` - same place

for running test and prod bots simultaneously, you can also use:

- `TEST_DISCORD_TOKEN` / `TEST_CLIENT_ID` - test bot credentials
- `PROD_DISCORD_TOKEN` / `PROD_CLIENT_ID` - prod bot credentials

everything else is optional. you can also use prefixed versions of any config var (e.g., `TEST_ADMIN_USER_IDS`, `PROD_CDN_BASE_URL`) for bot-specific configuration.

### r2 storage

gronka can use cloudflare r2 for storing and serving gifs, videos, and images. when configured, files are uploaded to r2 and served via your public domain. if not configured, it falls back to local filesystem storage.

to enable r2, add these to your `.env`:

- `R2_ACCOUNT_ID` - your cloudflare account id
- `R2_ACCESS_KEY_ID` - r2 access key id
- `R2_SECRET_ACCESS_KEY` - r2 secret access key
- `R2_BUCKET_NAME` - name of your r2 bucket
- `R2_PUBLIC_DOMAIN` - public domain for your r2 bucket (e.g., cdn.gronka.p1x.dev)

r2 is optional but recommended for production deployments. files are automatically uploaded to r2 when configured, and the bot will check r2 first before downloading or converting to avoid duplicates.

optional: you can enable automatic cleanup of r2 uploads after a configurable time period (default: 72 hours) to manage storage costs. see the [r2 storage documentation](/wiki/R2-Storage#temporary-uploads) for details.

### cobalt integration

gronka uses [cobalt.tools](https://cobalt.tools), a self-hosted api for downloading media from social platforms. when enabled, the `/download` command automatically detects social media urls and downloads the media directly to your storage.

supported platforms: twitter/x, tiktok, instagram, youtube, reddit, facebook, threads.

to enable cobalt, add these to your `.env`:

- `COBALT_API_URL` - url of your cobalt api instance (default: http://cobalt:9000)
- `COBALT_ENABLED` - set to `true` to enable (default: true)

downloaded media is stored in your configured storage (r2 or local). you can then convert it to gifs using `/convert`, or download without conversion using `/download`.

### optimization settings

when using `/optimize`, you can specify a lossy compression level:

- range: 0-100 (default: 35)
- lower values (0-30): less compression, higher quality, larger files
- medium values (30-60): balanced compression and quality
- higher values (60-100): more compression, lower quality, smaller files

for context menu optimization, a modal will appear to let you enter the lossy level.

### file size limits

gronka has file size limits to ensure system stability and prevent abuse:

- **gif optimization** (`/optimize`): maximum 50mb
- **video conversion** (`/convert`): maximum 100mb for video files
- **image conversion** (`/convert`): maximum 50mb for image files
- **video download** (`/download`): maximum 100mb
- **image download** (`/download`): maximum 50mb

when a file exceeds these limits, you'll receive a clear error message indicating which limit was exceeded and what the maximum size is for that file type. admins can bypass these limits for downloads, but conversion and optimization limits still apply for security reasons.

## using gronka

### commands

- `/download` - download media from a social media url (stores video/image without conversion)
- `/convert` - attach a file or paste a url to download and convert to gif (supports quality preset: low/medium/high, and optional optimization)
- `/optimize` - optimize an existing gif to reduce file size (supports custom lossy level 0-100)
- `/stats` - see storage statistics and how many files gronka has stored
- `/info` - view bot information, system status, and configuration
- right-click a message → apps → "convert to gif" - quick convert from any message
- right-click a message → apps → "download" - download media from message urls
- right-click a message → apps → "optimize" - optimize a gif from any message

### storage

gronka stores all downloaded media: videos, images, and gifs. when using r2, files are served directly from your r2 public domain. when using local storage, files are stored on disk and can be served via the local server endpoints:

- `GET /health` - is it alive?
- `GET /stats` - storage info
- `GET /gifs/{hash}.gif` - serve stored gifs (local storage only)
- `GET /videos/{hash}.{ext}` - serve stored videos (local storage only)
- `GET /images/{hash}.{ext}` - serve stored images (local storage only)
- `GET /` - api info

### dashboard

to view the statistics dashboard:

```bash
docker compose --profile webui up -d webui
```

then go to `http://localhost:3001`

## development

useful commands:

```bash
npm start              # start the bot
npm run server         # start the local server (only needed if not using r2)
npm run local          # run both at once
npm run dev            # bot with hot reload
npm run lint           # check code style
npm run format         # auto-format code
```

the project uses eslint and prettier. run `npm run validate` before committing to ensure code quality.

## license

MIT
