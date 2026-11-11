gronka uses multiple downloaders for social media content. cobalt.tools handles most platforms, while yt-dlp is used specifically for youtube downloads (due to better reliability and youtube's anti-bot measures).

## supported platforms

### via cobalt
- twitter/x
- tiktok
- instagram
- reddit
- facebook
- twitch clips
- soundcloud
- tumblr
- streamable
- dailymotion
- snapchat

### via yt-dlp
- youtube (youtube.com, youtu.be, m.youtube.com)

## setup

### step 1: cobalt comes with the stack

`docker compose up -d --build` already builds and runs cobalt; there is nothing separate to deploy. the image is built from `docker/cobalt.Dockerfile`: upstream cobalt with a patched node and openssl, plus the same egress fence as the bot, so a site cannot redirect it to a private address. it reads its own cookie file, `cobalt-cookies.json` (see [[Cookies]]).

cobalt has no api key and holds the cookie sessions, so it is published on `127.0.0.1:9000` only; the bot reaches it inside the compose network at `http://cobalt:9000`. after changing the dockerfile, rebuild it with:

```bash
docker compose build cobalt
docker compose up -d cobalt
```

### step 2: configure gronka

`.env.example` already sets these, and they are also the defaults:

```env
COBALT_API_URL=http://cobalt:9000
COBALT_ENABLED=true
```

to use a cobalt instance elsewhere, point `COBALT_API_URL` at it and keep it off the public internet.

### yt-dlp configuration (for youtube)

yt-dlp is bundled in the docker image and enabled by default. configure with these environment variables:

```env
YTDLP_ENABLED=true
#YTDLP_QUALITY=
```

- `YTDLP_ENABLED`: enable/disable youtube downloads (default: true)
- `YTDLP_QUALITY`: yt-dlp format string for video quality. the default caps both landscape and portrait video at 1080p; a filter on height alone, like `bestvideo[height<=1080]`, rejects every portrait video

for local development without docker, install yt-dlp:

```bash
# linux/macos
pip install yt-dlp

# or with package manager
brew install yt-dlp  # macos
apt install yt-dlp   # debian/ubuntu
```

### step 3: test the integration

1. start cobalt and gronka
2. use `/download` with a social media url
3. the bot should reply with the file

## how it works

when you use `/download` with a social media url:

1. the bot detects which platform the url is from
2. for youtube urls:
   - yt-dlp downloads the video directly
   - supports various quality options
3. for other platforms:
   - the bot sends a request to your cobalt api instance
   - cobalt downloads the media from the platform
4. the bot attaches the file to its reply. a file too big for a discord attachment is uploaded to [[R2-Storage]] and linked instead, or refused when r2 is not set up

the bot handles both video and image downloads. for platforms that return multiple images (like instagram carousels), all images are downloaded and attached.

## long downloads

every `/download`, `/convert` and `/optimize` reply is deferred: discord shows the bot thinking while a worker (or the bot itself, with `MEDIA_WORKERS=false`) runs the job, and the result replaces that reply. a job has until the discord interaction expires, about 15 minutes; past that the reply says it took too long. there is no separate queue message or notification.

## url-only mode

url-only mode makes `/download` reply with the direct media url from cobalt (e.g. a video.twimg.com link) instead of downloading the file and re-uploading it to storage.

- toggle it from the webui settings page, or via the api: `PUT /api/settings/url_only_mode` with `{"value": "true"}`
- the setting is stored in the `bot_settings` database table shared between the bot and webui processes (changes take effect within ~10 seconds due to caching)

url-only mode automatically falls back to the normal download pipeline when:

- the request includes trim parameters (`start`/`end`), which require a real download
- the url is a youtube link handled by yt-dlp (no direct url to hand out)
- cobalt only offers a tunnel response (tunnel urls are only reachable inside the docker network)

## nothing is cached

the bot keeps no record of what it downloaded: every request downloads fresh, and a job's files are deleted when it ends. only a failed request leaves a record (command, full link, error and the steps tried), kept for `RETENTION_DAYS` and never tied to a user. see [[Configuration]].

## troubleshooting

### cobalt not responding

- verify cobalt container is running: `docker ps | grep cobalt`
- check cobalt logs: `docker logs cobalt`
- test cobalt directly: `curl http://localhost:9000/` answers with its version and services
- verify `COBALT_API_URL` matches your cobalt instance

### downloads failing

- check cobalt logs for errors
- verify the url is from a supported platform
- some platforms may have rate limits or require authentication
- check bot logs for detailed error messages

### slow downloads

- cobalt downloads can take time depending on file size
- a job has about 15 minutes; for a long video, `start`/`end` grab a shorter clip
- check your network connection
- verify cobalt has sufficient resources

### yt-dlp issues (youtube)

- **"yt-dlp is not installed"**: ensure yt-dlp is installed in your environment
  - docker: rebuild the image to get the latest version
  - local: `pip install --upgrade yt-dlp`
- **rate limit errors**: youtube may temporarily block requests
  - wait a few minutes before retrying
  - consider using cookies for authentication (advanced)
- **video unavailable**: the video may be private, age-restricted, or deleted
- **format errors**: try adjusting `YTDLP_QUALITY` to a simpler format like `best`

to test yt-dlp directly:

```bash
# in docker
docker exec gronka yt-dlp --version

# locally
yt-dlp --version
```

### unsupported platforms

if a platform isn't supported:

- check cobalt documentation for supported platforms
- cobalt may need updates for new platforms
- you can still use `/convert` with direct media urls
