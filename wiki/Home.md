# gronka

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
- pinterest
- twitch clips
- soundcloud
- tumblr
- streamable
- dailymotion
- snapchat
- redgifs, imgur, kick, coub, rumble, newgrounds, bilibili (via yt-dlp)
- pornhub, xvideos, xhamster, redtube (via yt-dlp)
- hentaigifz (via a dedicated page-scrape extractor, not cobalt)
- danbooru, e621, e926 (via their JSON APIs, not cobalt)

each of these sources can be individually turned on or off from the webui **sources** page (in the sidebar). a turned-off source refuses `/download` with a short message instead of downloading.

you can also download media from direct urls using `/convert` with a url parameter. the bot handles videos and images from most common sources.

### converting media

convert downloaded media or files you upload to gifs:

- video formats: mp4, mov, webm, avi, mkv
- image formats: png, jpg, jpeg, webp, gif

gifs can also be converted to gifs with different quality settings or optimizations.

## getting started

- [[Quick-Start]] - get up and running in minutes
- [[Running-for-Free]] - the zero-cost setup path, from hardware to storage
- [[Installation]] - detailed installation instructions
- [[Configuration]] - configure environment variables
- [[Bot-Settings]] - live-editable settings in the webui
- [[Test-Bot]] - run separate test and production bots

## user guide

- [[Commands]] - complete command reference
- [[Docker-Deployment]] - deploy with docker
- [[Docker-Quick-Reference]] - quick docker commands
- [[R2-Storage]] - configure cloudflare r2 storage
- [[Cobalt-Integration]] - set up social media downloads
- [[Test-Bot]] - test and production bot separation

## reference

- [[API-Endpoints]] - http api endpoints
- [[Technical-Specification]] - complete technical documentation
- [[Logging-Platform]] - logging and monitoring

## troubleshooting

- [[Troubleshooting]] - common issues and solutions

## resources

- [github repository](https://github.com/thedorekaczynski/gronka)
- [issues](https://github.com/thedorekaczynski/gronka/issues)
- [changelog](https://github.com/thedorekaczynski/gronka/blob/main/CHANGELOG.md)

## how it works

gronka consists of three components:

1. **discord bot** - the part that lives in your server, downloads media, and does the converting
2. **r2 storage** - stores and serves videos, images, and gifs via cloudflare r2 (optional, falls back to local storage)
3. **webui** (optional) - a dashboard for statistics, logs, operation tracking, moderation (including user bans), and bot settings (like url-only mode)

## license

MIT
