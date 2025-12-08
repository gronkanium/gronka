gronka uses multiple downloaders for social media content. cobalt.tools handles most platforms, while yt-dlp is used specifically for youtube downloads (due to better reliability and youtube's anti-bot measures).

## supported platforms

### via cobalt
- twitter/x
- tiktok
- instagram
- reddit
- facebook
- threads

### via yt-dlp
- youtube (youtube.com, youtu.be, m.youtube.com)

## setup

### step 1: deploy cobalt

cobalt can be deployed using docker:

```bash
docker run -d \
  --name cobalt \
  -p 9000:9000 \
  --restart unless-stopped \
  ghcr.io/imputnet/cobalt
```

or add it to your docker-compose.yml:

```yaml
cobalt:
  image: ghcr.io/imputnet/cobalt:latest
  container_name: cobalt
  ports:
    - '9000:9000'
  restart: unless-stopped
```

### step 2: configure gronka

add these environment variables to your `.env` file:

```env
COBALT_API_URL=http://cobalt:9000
COBALT_ENABLED=true
```

if running cobalt on a different host or port, adjust `COBALT_API_URL` accordingly.

### yt-dlp configuration (for youtube)

yt-dlp is bundled in the docker image and enabled by default. configure with these environment variables:

```env
YTDLP_ENABLED=true
YTDLP_QUALITY=bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]
```

- `YTDLP_ENABLED`: enable/disable youtube downloads (default: true)
- `YTDLP_QUALITY`: yt-dlp format string for video quality (default: 1080p max)

admin users automatically get higher quality (no height restriction).

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
3. the bot should download the media and store it

## how it works

when you use `/download` with a social media url:

1. the bot detects which platform the url is from
2. for youtube urls:
   - yt-dlp downloads the video directly
   - supports various quality options
3. for other platforms:
   - the bot sends a request to your cobalt api instance
   - cobalt downloads the media from the platform
4. the bot receives the media and stores it in your configured storage (r2 or local)
5. you receive a link to the stored file

the bot handles both video and image downloads. for platforms that return multiple images (like instagram carousels), all images are downloaded and stored.

## deferred downloads

for large files or slow downloads, the bot uses a deferred download queue:

1. the bot immediately responds that the download is queued
2. the download happens in the background
3. you receive a notification when the download completes
4. the notification includes a link to the downloaded file

this prevents discord command timeouts for long-running downloads.

## url processing

the bot tracks processed urls to avoid re-downloading the same content:

- each url is hashed and stored in a database
- if a url was already processed, the bot returns the existing file immediately
- this works across all users and servers

## troubleshooting

### cobalt not responding

- verify cobalt container is running: `docker ps | grep cobalt`
- check cobalt logs: `docker logs cobalt`
- test cobalt directly: `curl http://localhost:9000/api/info`
- verify `COBALT_API_URL` matches your cobalt instance

### downloads failing

- check cobalt logs for errors
- verify the url is from a supported platform
- some platforms may have rate limits or require authentication
- check bot logs for detailed error messages

### slow downloads

- cobalt downloads can take time depending on file size
- use deferred downloads for large files
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
