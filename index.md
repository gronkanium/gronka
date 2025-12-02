---
layout: default
description: a discord bot that downloads media from social media and urls, then converts it to gifs. supports twitter, tiktok, instagram, youtube, reddit, facebook, and more.
image: https://cdn.discordapp.com/attachments/1335451213285822485/1440055450132414736/content.png?ex=691cc3a6&is=691b7226&hm=864a8c2f8d7ee5aaa7dac42318d3364032d9d29099057b1c7a3e0fb41a4063dd&
---

![Discord.js](https://img.shields.io/badge/Discord.js-14.14-5865F2?logo=discord&logoColor=white)
[![Add to Discord](https://img.shields.io/badge/Add_to_Discord-5865F2?logo=discord&logoColor=white)](https://discord.com/oauth2/authorize?client_id=1439329052002357599)
[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/thedorekaczynski/gronka)

a discord bot that downloads media from social media platforms and urls, then converts it to gifs. that's it.

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

yes, it can convert gifs to gifs. don't ask why, just embrace it.

## how it works

there are three parts to this thing:

1. **discord bot** - the part that lives in your server, downloads media, and does the converting
2. **r2 storage** - stores and serves videos, images, and gifs via cloudflare r2 (optional, falls back to local storage)
3. **webui** (optional) - a simple dashboard if you want to see stats

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
npm run local
```

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

everything else is optional. check `.env.example` for what you can tweak (output quality, file size limits, that kind of stuff).

### r2 storage

gronka can use cloudflare r2 for storing and serving gifs, videos, and images. when configured, files are uploaded to r2 and served via your public domain. if not configured, it falls back to local filesystem storage.

to enable r2, add these to your `.env`:

- `R2_ACCOUNT_ID` - your cloudflare account id
- `R2_ACCESS_KEY_ID` - r2 access key id
- `R2_SECRET_ACCESS_KEY` - r2 secret access key
- `R2_BUCKET_NAME` - name of your r2 bucket
- `R2_PUBLIC_DOMAIN` - public domain for your r2 bucket (e.g., cdn.gronka.p1x.dev)

r2 is optional but recommended for production deployments. files are automatically uploaded to r2 when configured, and the bot will check r2 first before downloading or converting to avoid duplicates.

### cobalt integration

gronka uses [cobalt.tools](https://cobalt.tools), a self-hosted api for downloading media from social platforms. when enabled, the `/download` command automatically detects social media urls and downloads the media directly to your storage.

supported platforms: twitter/x, tiktok, instagram, youtube, reddit, facebook, threads.

to enable cobalt, add these to your `.env`:

- `COBALT_API_URL` - url of your cobalt api instance (default: http://cobalt:9000)
- `COBALT_ENABLED` - set to `true` to enable (default: true)

downloaded media is stored in your configured storage (r2 or local). you can then convert it to gifs using `/convert`, or download without conversion using `/download`.

## using gronka

### commands

- `/download` - download media from a social media url (stores video/image without conversion)
- `/convert` - attach a file or paste a url to download and convert to gif
- `/optimize` - optimize an existing gif to reduce file size (supports custom lossy level 0-100)
- `/stats` - see storage statistics and how many files gronka has stored
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

if you want to see pretty stats:

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

the project uses eslint and prettier. run `npm run validate` before committing if you care about that stuff.

## built with

gronka uses a mix of open-source tools and services.

**core:**
- node.js 20+ - runtime environment
- discord.js 14 - discord bot library
- express.js - http server and api
- javascript - the programming language

**media processing:**
- ffmpeg - video and image conversion
- fluent-ffmpeg - node wrapper for ffmpeg commands
- cobalt api - social media platform downloads
- giflossy - gif compression and optimization

**storage and database:**
- postgresql 16 - stores operations, users, and metadata
- cloudflare r2 - file storage and cdn for converted media

**frontend:**
- svelte - webui framework
- vite - build tool and dev server

**infrastructure:**
- docker - containers and deployment
- axios - http requests

## license

MIT

