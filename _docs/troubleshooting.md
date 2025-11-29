---
layout: doc
title: troubleshooting
description: common issues and solutions
topic: guides
chapter: 2
---

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
- ensure message content intent is enabled

## commands not appearing

### register commands

```bash
# docker
docker compose run --rm app npm run register-commands

# local
npm run register-commands
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

- videos: 500mb maximum
- images: 50mb maximum
- gif duration: 30 seconds (configurable)

admin users can bypass these limits.

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
- threads

for unsupported platforms, use `/convert` with a direct media url.

### download timeout

large files may timeout. the bot uses deferred downloads for this:

1. download is queued
2. you receive a notification when complete
3. check bot logs for errors

## storage issues

### files not saving

check storage path permissions:

```bash
# docker
docker compose exec app ls -la /app/data

# local
ls -la ./data
```

fix permissions:

```bash
sudo chown -R $USER:$USER data
chmod -R 755 data
```

### r2 upload failures

- verify r2 credentials are correct
- check bucket name matches exactly
- ensure bucket has public access enabled
- check bot logs for r2 errors

### storage full

check disk usage:

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

should return:

```json
{"status":"ok","uptime":12345}
```

if failing, check server logs for errors.

## rate limiting

### commands rate limited

- 30-second cooldown between commands per user
- wait before using another command
- admin users bypass rate limiting

to become an admin, add your user id to `ADMIN_USER_IDS`:

```env
ADMIN_USER_IDS=your_user_id_here
```

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
sudo chown -R $USER:$USER data temp logs
chmod -R 755 data temp logs
```

### code changes not reflected

rebuild the image:

```bash
docker compose build --no-cache
docker compose up -d
```

## jekyll stats issues

### stats not updating

1. **check bot server is running:**
   ```bash
   curl http://YOUR_BOT_SERVER_LOCAL_IP:3000/health
   ```

2. **check api endpoint:**
   ```bash
   curl http://YOUR_BOT_SERVER_LOCAL_IP:3000/api/stats/24h
   # or with auth
   curl -u "username:password" http://YOUR_BOT_SERVER_LOCAL_IP:3000/api/stats/24h
   ```

3. **check network connectivity:**
   ```bash
   ping YOUR_BOT_SERVER_LOCAL_IP
   ```

4. **check file permissions:**
   ```bash
   ls -la _data/stats.json
   # ensure the script can write to _data directory
   ```

5. **check logs:**
   ```bash
   tail -f logs/jekyll-update.log
   ```

6. **check environment variables:**
   ```bash
   # verify BOT_API_URL is set correctly
   grep BOT_API_URL .env
   ```

### stats show zero or old data

1. **verify bot has processed files:**
   - check bot database has recent entries in `processed_urls` table
   - verify files were processed within the last 24 hours

2. **check time window:**
   - stats are for last 24 hours from current time
   - if no activity in last 24 hours, stats will be zero

3. **verify file was updated:**
   ```bash
   # check modification time
   ls -l _data/stats.json
   # should be recent if stats update ran
   ```

4. **check jekyll rebuild:**
   - stats file must exist before jekyll builds
   - verify `scripts/update-jekyll-site.sh` ran the stats update step

5. **verify api response:**
   ```bash
   # test the endpoint directly
   curl http://YOUR_BOT_SERVER_LOCAL_IP:3000/api/stats/24h
   ```

### authentication errors

1. **verify credentials match:**
   - `STATS_USERNAME` and `STATS_PASSWORD` on jekyll server must match bot server
   - check both `.env` files have the same values

2. **check bot server config:**
   - verify `STATS_USERNAME` and `STATS_PASSWORD` are set on bot server
   - if not set on bot server, omit them from jekyll server `.env`

3. **test with curl:**
   ```bash
   # test authentication
   curl -u "username:password" http://YOUR_BOT_SERVER_LOCAL_IP:3000/api/stats/24h
   ```

4. **check basic auth:**
   - ensure both username and password are provided if auth is enabled
   - verify no extra spaces or special characters in credentials

### script fails but build continues

this is expected behavior - the update script is designed to continue even if stats update fails. check:

1. **logs:**
   ```bash
   # review update script logs
   tail -f logs/jekyll-update.log
   # look for warning messages about stats update
   ```

2. **network issues:**
   - bot server may be temporarily unavailable
   - check bot server is running and accessible

3. **api errors:**
   - check bot server logs for api endpoint errors
   - verify `/api/stats/24h` endpoint is working

4. **last known stats:**
   - jekyll will use the last successfully updated stats file
   - check `_data/stats.json` modification time

### stats not appearing in footer

1. **check stats file exists:**
   ```bash
   cat _data/stats.json
   ```

2. **verify jekyll build:**
   ```bash
   # rebuild jekyll
   bundle exec jekyll build
   # check footer in built site
   grep "past 24 hours" _site/index.html
   ```

3. **check footer template:**
   - verify `_includes/footer.html` has the stats display code
   - check for syntax errors in liquid template

4. **verify stats data format:**
   ```bash
   # stats.json should have these fields
   cat _data/stats.json | jq .
   ```

## getting help

if you're still having issues:

1. check the logs for error messages
2. verify all configuration is correct
3. test individual components (ffmpeg, cobalt, r2)
4. check github issues for similar problems

common log locations:

- docker: `docker compose logs -f`
- local: `logs/combined.log` and `logs/error.log`
- jekyll updates: `logs/jekyll-update.log`

