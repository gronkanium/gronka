common problems and how to fix them.

## bot not responding

### check bot is running

```bash
# docker
docker compose ps

# local
ps aux | grep node
```

### check logs

```bash
# docker
docker compose logs -f app

# local
tail -f logs/combined.log
```

### verify discord connection

look for "bot logged in as" message in logs. if missing:

- check `DISCORD_TOKEN` is correct
- verify bot has proper permissions

## commands not appearing

### register commands

```bash
# docker
docker compose run --rm app bun run register-commands

# local
bun run register-commands
```

### wait for propagation

discord commands can take up to an hour to appear globally. they may appear immediately in servers where the bot is present.

### check bot permissions

ensure the bot has "use application commands" permission in your server.

## conversion failures

### ffmpeg not found

```bash
# docker (ffmpeg is included)
docker compose exec app ffmpeg -version

# local
ffmpeg -version
```

if missing, install ffmpeg:

```bash
sudo apt install ffmpeg
```

### file too large

check file size limits:

- videos: 1 gb maximum for downloads (the max download size webui setting); anything over the discord attachment limit needs [[R2-Storage]]
- images: 50mb maximum (configurable via `MAX_IMAGE_SIZE`)
- gif optimization: 50mb maximum
- gif duration: 30 seconds (configurable via `MAX_GIF_DURATION`)

### unsupported format

supported formats:

- videos: mp4, mov, webm, avi, mkv
- images: png, jpg, jpeg, webp, gif

if a format isn't working, check ffmpeg can process it:

```bash
ffmpeg -i test.mp4 -vf "fps=15,scale=480:-1" test.gif
```

## download issues

### cobalt not responding

```bash
# check cobalt is running
docker ps | grep cobalt

# check cobalt logs
docker logs cobalt

# test cobalt directly
curl http://localhost:9000/api/info
```

verify `COBALT_API_URL` matches your cobalt instance.

### url not supported

check if the platform is supported by cobalt:

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

for unsupported platforms, use `/convert` with a direct media url.

### age-restricted tiktok posts fail

cobalt has no tiktok cookie support, so age-restricted tiktok posts always fail through it. the bot falls back to yt-dlp for tiktok urls, but yt-dlp needs a logged-in session to see age-restricted content:

1. export cookies from a logged-in tiktok browser session in netscape `cookies.txt` format
2. point `YTDLP_COOKIES_PATH` at the file (in docker, save it as `./ytdlp-cookies.txt` in the project root, it's mounted automatically)

see `YTDLP_COOKIES_PATH` in [[Configuration]] for details.

### youtube video too long

`/download` caps video length with the max video duration webui setting. to grab part of a longer video, pass `start`/`end`; trimmed downloads bypass the cap.

### download timeout

large files may timeout. the bot uses deferred downloads for this:

1. download is queued
2. you receive a notification when complete
3. check bot logs for errors

## storage issues

### r2 upload failures

- verify r2 credentials are correct
- check bucket name matches exactly
- ensure bucket has public access enabled
- check bot logs for r2 errors

### storage full

jobs download into `./temp` and delete their folder when they end. check disk usage:

```bash
# docker
docker compose exec app df -h

# local
df -h
```

clean up old files or increase storage.

## server issues

### server not starting

check port is available:

```bash
# check if port is in use
lsof -i :3000

# or
netstat -tuln | grep 3000
```

change `SERVER_PORT` if port is in use.

### health check failing

test health endpoint:

```bash
curl http://localhost:3000/health
```

it answers 200 once the bot is connected to discord, 503 before that. if it never turns 200, check the bot logs.

## docker issues

### container won't start

1. check logs:

```bash
docker compose logs -f
```

2. verify environment variables:

```bash
docker compose config
```

3. ensure `.env` file exists with required variables

### permission issues

fix volume permissions:

```bash
sudo chown -R $USER:$USER temp
chmod -R 755 temp
```

### code changes not reflected

rebuild the image:

```bash
docker compose build --no-cache
docker compose up -d
```

## getting help

if you're still having issues:

1. check the logs for error messages
2. verify all configuration is correct
3. test individual components (ffmpeg, cobalt, r2)
4. check github issues for similar problems

logs go to the console only: `docker compose logs -f app worker`. the webui's issues page lists recent failures by command, site and error.
