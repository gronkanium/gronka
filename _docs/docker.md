---
title: docker deployment
topic: guides
chapter: 2
description: deploy gronka using docker and docker compose
---

deploy gronka using docker and docker compose.

## prerequisites

- docker engine 20.10+
- docker compose 2.0+
- discord bot token and client id
- (optional) cloudflare tunnel token for public access

## quick start

1. **create a `.env` file** in the project root:

```env
DISCORD_TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_client_id
CDN_BASE_URL=http://localhost:3000/gifs
SERVER_PORT=3000
GIF_STORAGE_PATH=./data
MAX_GIF_WIDTH=720
MAX_GIF_DURATION=30
DEFAULT_FPS=15

# optional: admin user ids (comma-separated)
ADMIN_USER_IDS=123456789012345678,987654321098765432

# optional: stats endpoint authentication
STATS_USERNAME=admin
STATS_PASSWORD=your_secure_password_here

# optional: cloudflare tunnel
CLOUDFLARE_TUNNEL_TOKEN=your_tunnel_token

# optional: cobalt api for social media downloads
COBALT_API_URL=http://cobalt:9000
COBALT_ENABLED=true
```

2. **start the application:**

```bash
docker compose up -d
```

this will:
- build the docker image with node.js and ffmpeg
- start the discord bot and express server
- mount volumes for persistent storage

3. **register discord commands:**

```bash
docker compose run --rm app npm run register-commands
```

4. **view logs:**

```bash
docker compose logs -f
```

5. **stop the application:**

```bash
docker compose down
```

## web ui dashboard

the web ui provides a localhost-only dashboard for viewing stats.

### start the web ui

```bash
docker compose --profile webui up -d
```

### access the dashboard

once running, open http://localhost:3001 in your browser.

**important:** the web ui port is only accessible from localhost on your host machine. it is not exposed to the internet.

### view web ui logs

```bash
docker compose logs -f webui
```

## cloudflare tunnel

to enable the cloudflare tunnel service:

1. **get your cloudflare tunnel token:**
   - go to cloudflare zero trust dashboard
   - create or select a tunnel
   - copy the tunnel token

2. **update `.env` file:**

   ```env
   CLOUDFLARE_TUNNEL_TOKEN=your_tunnel_token
   ```

3. **update `config/cloudflared-config.yml`:**
   - set your hostname (e.g., `cdn.yourdomain.com`)
   - the service url is already configured to point to the app container

4. **start with tunnel profile:**

   ```bash
   docker compose --profile tunnel up -d
   ```

## configuration

### environment variables

| variable                  | description                                            | default                      |
| ------------------------- | ------------------------------------------------------ | ---------------------------- |
| `DISCORD_TOKEN`           | discord bot token                                      | _required_                   |
| `CLIENT_ID`               | discord application id                                 | _required_                   |
| `CDN_BASE_URL`            | base url for serving gifs                              | `http://localhost:3000/gifs` |
| `SERVER_PORT`             | express server port                                    | `3000`                       |
| `GIF_STORAGE_PATH`        | path to gif storage                                    | `./data`                     |
| `MAX_GIF_WIDTH`           | maximum gif width                                      | `720`                        |
| `MAX_GIF_DURATION`        | maximum video duration (seconds)                       | `30`                         |
| `DEFAULT_FPS`              | default frames per second                              | `15`                         |
| `ADMIN_USER_IDS`          | comma-separated discord user ids with admin privileges | _optional_                   |
| `STATS_USERNAME`          | username for basic auth on `/stats` endpoint           | _optional_ (recommended)     |
| `STATS_PASSWORD`          | password for basic auth on `/stats` endpoint           | _optional_ (recommended)     |
| `CLOUDFLARE_TUNNEL_TOKEN` | cloudflare tunnel token                                | _optional_                   |
| `COBALT_API_URL`          | cobalt api url for social media downloads              | `http://cobalt:9000`         |
| `COBALT_ENABLED`           | enable cobalt integration                              | `true`                       |

### volumes

the following directories are mounted as volumes for persistence:

- `./data` → `/app/data` - gif storage
- `./temp` → `/app/temp` - temporary files
- `./logs` → `/app/logs` - application logs

### ports

- `3000:3000` - express cdn server
- `3001:3001` - web ui dashboard (requires `--profile webui`)
- `9000:9000` - cobalt api (internal use)

## registering discord commands

to register the discord slash commands, run:

```bash
# if container is running
docker compose exec app npm run register-commands

# if container is not running (one-off command)
docker compose run --rm app npm run register-commands
```

you should register commands:
- after first setting up the bot
- after adding new commands or modifying existing ones
- if commands are not appearing in discord

**note:** it may take up to an hour for commands to appear globally in discord, or they may appear immediately in servers where the bot is present.

## health checks

the application includes health checks:

- **application health check:** `http://localhost:3000/health`
- docker will automatically restart unhealthy containers

## troubleshooting

### container won't start

1. check logs:

   ```bash
   docker compose logs -f
   ```

2. verify environment variables:

   ```bash
   docker compose config
   ```

3. ensure `.env` file exists and contains required variables

### ffmpeg not working

ffmpeg is included in the docker image. if you encounter issues:

```bash
docker compose exec app ffmpeg -version
```

### cloudflared connection issues

1. verify tunnel token is correct
2. check cloudflared logs:

   ```bash
   docker compose logs cloudflared
   ```

3. ensure `config/cloudflared-config.yml` has correct hostname

### permission issues

if you encounter permission issues with mounted volumes:

```bash
# on linux/mac
sudo chown -R $USER:$USER data temp logs
chmod -R 755 data temp logs
```

## updating

### code changes

after making code changes, you must rebuild the image:

```bash
# rebuild and restart
docker compose build --no-cache
docker compose up -d
```

### environment variable changes

for environment variable changes, restart the container:

```bash
docker compose restart app
```

### updating from git

```bash
# pull latest code
git pull

# rebuild and restart
docker compose build --no-cache
docker compose up -d
```

## admin users

admin users can bypass rate limiting and file size/duration restrictions.

### setup

1. **get your discord user id:**
   - enable developer mode in discord (user settings → advanced → developer mode)
   - right-click on your username and select "copy user id"

2. **add to `.env` file:**

   ```env
   ADMIN_USER_IDS=your_user_id_here,another_user_id
   ```

3. **restart the container:**

   ```bash
   docker compose restart app
   ```

### admin privileges

admin users can:
- bypass the 30-second rate limit cooldown
- upload videos larger than normal limits
- upload images larger than normal limits
- convert videos longer than 30 seconds

## cleanup

to remove all containers:

```bash
docker compose down
```

to remove volumes (warning: deletes gifs):

```bash
docker compose down -v
```

to remove images:

```bash
docker compose down --rmi all
```

