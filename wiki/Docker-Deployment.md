deploy gronka using docker and docker compose.

## prerequisites

- docker engine 20.10+
- docker compose 2.0+
- discord bot token and client id

## quick start

1. **create a `.env` file** in the project root:

```env
DISCORD_TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_client_id
CDN_BASE_URL=http://localhost:3000/gifs
SERVER_PORT=3000
GIF_STORAGE_PATH=./data-prod
MAX_GIF_WIDTH=720
MAX_GIF_DURATION=30
DEFAULT_FPS=15

# optional: admin user ids (comma-separated)
ADMIN_USER_IDS=123456789012345678,987654321098765432

# optional: stats endpoint authentication
STATS_USERNAME=admin
STATS_PASSWORD=your_secure_password_here

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

once running, open [http://localhost:3001](http://localhost:3001) in your browser.

**important:** the web ui port is only accessible from localhost on your host machine. it is not exposed to the internet.

### view web ui logs

```bash
docker compose logs -f webui
```

## configuration

### environment variables

| variable           | description                                            | default                      |
| ------------------ | ------------------------------------------------------ | ---------------------------- |
| `DISCORD_TOKEN`    | discord bot token                                      | _required_                   |
| `CLIENT_ID`        | discord application id                                 | _required_                   |
| `CDN_BASE_URL`     | base url for serving gifs                              | `http://localhost:3000/gifs` |
| `SERVER_PORT`      | express server port                                    | `3000`                       |
| `GIF_STORAGE_PATH` | path to gif storage                                    | `./data-prod` or `./data-test` |
| `MAX_GIF_WIDTH`    | maximum gif width                                      | `720`                        |
| `MAX_GIF_DURATION` | maximum video duration (seconds)                       | `30`                         |
| `DEFAULT_FPS`      | default frames per second                              | `15`                         |
| `ADMIN_USER_IDS`   | comma-separated discord user ids with admin privileges | _optional_                   |
| `STATS_USERNAME`   | username for basic auth on `/stats` endpoint           | _optional_ (recommended)     |
| `STATS_PASSWORD`   | password for basic auth on `/stats` endpoint           | _optional_ (recommended)     |
| `COBALT_API_URL`   | cobalt api url for social media downloads              | `http://cobalt:9000`         |
| `COBALT_ENABLED`   | enable cobalt integration                              | `true`                       |

**important:** docker deployment has limited support for `PROD_*` prefixed variables. only 4 variables support the `PROD_*` prefix in docker:

- `PROD_DISCORD_TOKEN` (falls back to `DISCORD_TOKEN`)
- `PROD_CLIENT_ID` (falls back to `CLIENT_ID`)
- `PROD_POSTGRES_DB` (falls back to `POSTGRES_DB`)
- `PROD_GIF_STORAGE_PATH` (falls back to `./data-prod/gifs`)

all other variables must use standard names (e.g., `MAX_GIF_DURATION`, not `PROD_MAX_GIF_DURATION`). this is different from local deployments where all variables support the `PROD_*` prefix. see the [[Configuration#local-vs-docker-deployment-variable-handling|configuration documentation]] for details.

### volumes

the following directories are mounted as volumes for persistence:

- `./data-prod` or `./data-test` → `/app/data` - gif storage (configured via `GIF_STORAGE_PATH`)
- `./temp` → `/app/temp` - temporary files
- `./logs` → `/app/logs` - application logs

**note:** use `./data-prod` for production and `./data-test` for testing to keep data separate.

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

### permission issues

if you encounter permission issues with mounted volumes:

```bash
# on linux/mac
sudo chown -R $USER:$USER data-prod data-test temp logs
chmod -R 755 data-prod data-test temp logs
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

## accessing restricted content

cobalt can access content requiring authentication from services like twitter, instagram, and reddit by using authentication cookies stored in a `cookies.json` file.

### purpose

some content on social media platforms requires authentication to view, even if it's publicly accessible. this includes:

- content that requires login to view
- private or protected content (if you have access)
- content that platforms restrict to authenticated users

without cookies, cobalt will return errors like `content.post.age` or `content.video.age` when attempting to access restricted content.

### setup instructions

1. **create cookies.json file:**

   copy the example file and customize it with your authentication cookies:

   ```bash
   cp cookies.example.json cookies.json
   ```

2. **obtain cookies from your browser:**

   you need to extract cookies from your browser after logging into the services you want to support. here are some methods:

   - **chrome/edge:** open developer tools (f12) → application tab → cookies → select domain → copy cookie values
   - **firefox:** open developer tools (f12) → storage tab → cookies → select domain → copy cookie values
   - **browser extensions:** use cookie export extensions to export cookies in json format

3. **populate cookies.json:**

   edit `cookies.json` and add the relevant cookies for each service. the file uses a domain-based structure where each service domain contains an array of cookie objects.

   **important:** only include cookies for services you actually use. you don't need to populate all services.

4. **file location:**

   place `cookies.json` in the project root directory (same directory as `docker-compose.yml`). the docker volume mount will make it available to the cobalt container.

5. **restart cobalt:**

   after creating or updating `cookies.json`, restart the cobalt container:

   ```bash
   docker compose restart cobalt
   ```

### configuration

the `docker-compose.yml` file is pre-configured with:

- **COOKIE_PATH environment variable:** set to `/cookies.json` (path inside the container)
- **volume mount:** `./cookies.json:/cookies.json` (mounts your local file into the container)

cobalt will automatically:
- load cookies on startup and log success/failure
- update cookies dynamically when services return new authentication cookies
- handle cookie rotation and session management

### supported services

cobalt's cookie system supports authentication for:

- **twitter:** uses guest tokens and cookie-based authentication with CSRF protection (`auth_token`, `ct0`, `guest_id`)
- **instagram:** implements web cookies with CSRF protection and bearer tokens (`sessionid`, `csrftoken`)
- **reddit:** uses OAuth token management with automatic refresh (`reddit_session`)

other services may also support cookie-based authentication. refer to the [cobalt documentation](https://github.com/imputnet/cobalt) for the latest supported services.

### error handling

when cookies are missing or invalid, cobalt will:

- return specific error codes:
  - `content.post.age` - post requires authentication
  - `content.video.age` - video requires authentication
- log warnings in the container logs about missing or invalid cookies
- attempt to use guest tokens when available (for some services)

### verifying cookies are loaded

check cobalt container logs to verify cookies loaded successfully:

```bash
docker compose logs cobalt | grep -i cookie
```

you should see messages indicating whether cookies were loaded successfully or if there were any errors.

### security considerations

**critical security notes:**

- **never commit `cookies.json` to git** - it contains sensitive authentication tokens
- the file is already in `.gitignore` to prevent accidental commits
- **file permissions:** on linux/mac, restrict access to the file:
  ```bash
  chmod 600 cookies.json
  ```
- **cookie rotation:** cookies may expire or be rotated by services. if you encounter authentication errors, update your cookies.json with fresh cookies
- **sharing:** never share your `cookies.json` file with others - it contains your personal authentication tokens

cobalt automatically updates cookies when services return new authentication cookies in response headers, helping maintain session state.

### troubleshooting

**cookies not loading:**

1. verify the file exists in the project root:
   ```bash
   ls -la cookies.json
   ```

2. check file format is valid json:
   ```bash
   cat cookies.json | jq .
   ```

3. verify volume mount in docker-compose:
   ```bash
   docker compose config | grep -A 2 cookies.json
   ```

4. check cobalt logs for errors:
   ```bash
   docker compose logs cobalt
   ```

**still getting authentication errors:**

- verify cookies are current and not expired
- ensure you're logged into the service in your browser when extracting cookies
- check that cookie names match the expected format (see `cookies.example.json`)
- some services may require additional cookies beyond the basic ones

**cookies updated but not working:**

- restart the cobalt container after updating cookies:
  ```bash
  docker compose restart cobalt
  ```

- check that the volume mount is working:
  ```bash
  docker compose exec cobalt cat /cookies.json
  ```

for more information, see the [cobalt documentation](https://github.com/imputnet/cobalt) and [cobalt wiki](https://github.com/imputnet/cobalt/wiki).

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
