gronka uses cobalt.tools, a self-hosted api for downloading media from social platforms. when enabled, the `/download` command automatically detects social media urls and downloads the media directly to your storage.

## supported platforms

- twitter/x
- tiktok
- instagram
- youtube
- reddit
- facebook
- threads

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

### step 3: test the integration

1. start cobalt and gronka
2. use `/download` with a social media url
3. the bot should download the media and store it

## how it works

when you use `/download` with a social media url:

1. the bot detects the url is from a supported platform
2. it sends a request to your cobalt api instance
3. cobalt downloads the media from the platform
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

### unsupported platforms

if a platform isn't supported:

- check cobalt documentation for supported platforms
- cobalt may need updates for new platforms
- you can still use `/convert` with direct media urls
