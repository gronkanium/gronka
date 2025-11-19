---
layout: default
description: a discord bot that turns your videos and images into gifs. simple file conversion with support for multiple video and image formats.
image: https://cdn.discordapp.com/attachments/1335451213285822485/1440055450132414736/content.png?ex=691cc3a6&is=691b7226&hm=864a8c2f8d7ee5aaa7dac42318d3364032d9d29099057b1c7a3e0fb41a4063dd&
---

![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)
![Discord.js](https://img.shields.io/badge/Discord.js-14.14-5865F2?logo=discord&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)
![Svelte](https://img.shields.io/badge/Svelte-4.2-FF3E00?logo=svelte&logoColor=white)
[![Docs](https://img.shields.io/badge/read-docs-blue)]({{ "/docs/" | relative_url }})
[![FFmpeg](https://img.shields.io/badge/FFmpeg-007808?logo=ffmpeg&logoColor=white)](https://ffmpeg.org/)
[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/p2xai/gronka)

a discord bot that turns your videos and images into gifs. that's it. that's the bot.

## what it does

gronka takes video files or images you send in discord and converts them to gifs. no fancy features, no bloat, just straightforward file conversion. 

it supports most common video formats (mp4, mov, webm, avi, mkv) and image formats (png, jpg, jpeg, webp, gif). yes, it can convert gifs to gifs. don't ask why, just embrace it.

## how it works

there are three parts to this thing:

1. **discord bot** - the part that lives in your server and does the converting
2. **cdn server** - serves up the gifs after they're made
3. **webui** (optional) - a simple dashboard if you want to see stats

## getting started

### running it locally

you'll need node.js 20+ and ffmpeg installed. then:

```bash
git clone https://github.com/p2xai/gronka.git
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

## using gronka

### commands

- `/convert` - attach a file or paste a url to convert it
- `/stats` - see how many gifs gronka has made
- right-click a message → apps → "convert to gif" - quick convert from any message

### the cdn

gronka hosts the gifs it makes. you can hit these endpoints:

- `GET /health` - is it alive?
- `GET /stats` - storage info
- `GET /gifs/{hash}.gif` - your actual gif
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
npm run server         # start the cdn
npm run local          # run both at once
npm run dev            # bot with hot reload
npm run lint           # check code style
npm run format         # auto-format code
```

the project uses eslint and prettier. run `npm run validate` before committing if you care about that stuff.

## inspiration

this is basically a spiritual successor to esmbot. i needed something simple that just converts files to gifs without all the extra stuff.

## license

MIT

