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
- twitch clips
- soundcloud
- tumblr
- streamable
- dailymotion
- snapchat
- redgifs, imgur, kick, coub, rumble, newgrounds, niconico, bilibili (via yt-dlp)
- pornhub, xvideos, xhamster, redtube, rule34video (via yt-dlp)
- pinterest, including pin.it share links (via a dedicated extractor, not cobalt)
- threads posts: videos, photos and every slide of a carousel (read from the public post page)
- hentaigifz (via a dedicated page-scrape extractor, not cobalt)
- danbooru, e621, e926, yande.re, konachan (via their JSON APIs, not cobalt)

each of these sources can be individually turned on or off from the webui **sources** page (in the sidebar). a turned-off source refuses `/download` with a short message instead of downloading.

you can also download media from direct urls using `/convert` with a url parameter. the bot handles videos and images from most common sources.

### converting media

convert downloaded media or files you upload to gifs:

- video formats: mp4, mov, webm, avi, mkv
- image formats: png, jpg, jpeg, webp, gif

gifs can also be resized, trimmed or optimized.

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

## troubleshooting

- [[Troubleshooting]] - common issues and solutions

## resources

- [github repository](https://github.com/gronkanium/gronka)
- [issues](https://github.com/gronkanium/gronka/issues)
- [changelog](https://github.com/gronkanium/gronka/blob/master/CHANGELOG.md)

## how it works

gronka consists of three components:

1. **discord bot** - the part that lives in your server, downloads media, and does the converting
2. **r2 storage** (optional) - files too big for a discord attachment are uploaded under a random name and deleted after a few hours to days, by size
3. **webui** (optional) - health, failures, workers and settings. it shows no users: gronka keeps nothing about who uses it, and only failed requests (link, error, steps tried) are kept, for 7 days

## license

MIT
