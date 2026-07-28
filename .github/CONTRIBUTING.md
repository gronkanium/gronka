## Project Structure

This project consists of multiple components that can run independently or together:

- **Discord Bot** (`src/bot.js`) - Handles Discord interactions and converts files to GIFs. The bot includes a minimal HTTP server that serves `/api/stats/24h` for Jekyll site integration.
- **WebUI** (`src/webui-server.js`) - Dashboard for viewing statistics

When running in Docker, the `app` container runs both processes: `scripts/docker-entrypoint.sh` starts the bot and the webui server side by side and restarts the container if either exits. Files are stored in R2 when configured (recommended), or saved to local disk if R2 is not configured. Files are served from R2 or Discord attachments.

## Dependency Management

### Adding/Removing Dependencies

When adding or removing dependencies, always run `bun install` to update `bun.lock`:

```bash
bun add <package-name>
# or
bun add --dev <package-name>
```

**Important:** The `bun.lock` file must be committed to git. It ensures consistent dependency versions across all environments, including Docker builds.

### Checking Lock File Sync

Before committing changes, verify that `bun.lock` is in sync with `package.json`:

```bash
bun run check:sync
```

If the lock file is out of sync, fix it by running:

```bash
bun run fix:deps
```

This will update `bun.lock` to match `package.json`.

### Git Hooks

This project uses [husky](https://typicode.github.io/husky/) to automatically check lock file sync and run linting before each commit. The pre-commit hook will:

- Verify `bun.lock` is in sync with `package.json`
- Run ESLint to check code quality
- Check code formatting with Prettier

If any check fails, the commit will be blocked. Fix the issues and try again.

## Code Quality

### Linting

This project uses ESLint for code linting. Available commands:

```bash
bun run lint          # Check for linting errors (fails on warnings)
bun run lint:warn     # Check for linting errors (allows warnings)
bun run lint:fix      # Automatically fix linting errors
```

### Formatting

This project uses Prettier for code formatting. Available commands:

```bash
bun run format        # Format all files
bun run format:check  # Check if files are formatted correctly
```

### Validation

Run all checks at once:

```bash
bun run validate
```

This will check:

- Package lock file sync
- Linting errors
- Code formatting

## Docker

### Building and Running

The project uses Docker Compose with multiple services. The main app service runs both the Discord bot and local server:

```bash
bun run docker:up          # Start all services
bun run docker:down        # Stop all containers
bun run docker:reload      # Reload containers (rebuild and restart)
bun run docker:restart     # Restart all containers
bun run docker:register    # Force a re-register (the container already does this on start)
```

### Docker Services

The Docker Compose setup includes these services:

- **app** - Runs the Discord bot and the webui server in one container. Provides health checks and the stats API. Files are stored in R2 when configured (recommended) and served via the R2 public domain.
- **postgres** - Database backing user metrics, operations, processed URLs, and settings. The app waits for it to report healthy before starting.
- **cobalt** - Self-hosted API for downloading media from social platforms (Twitter/X, TikTok, Instagram, YouTube, Reddit, Facebook, Twitch clips, SoundCloud, Tumblr, Streamable, Dailymotion, Snapchat). Runs by default on port 9000
- **watchtower** - Automatically updates the cobalt image. Runs cleanup and updates every 15 minutes

All of them start with `docker compose up`. There are no Compose profiles. GIF optimization uses the `gifsicle` binary installed directly in the app image, not a separate service.

### Common Docker Commands

```bash
bun run docker:logs        # View logs for all services
bun run docker:down        # Stop all containers
bun run docker:reload      # Reload containers (rebuild and restart)
bun run docker:restart     # Restart all containers
bun run docker:register    # Force a re-register (the container already does this on start)

# Manual docker compose commands
docker compose ps           # Check container status
docker compose exec app sh  # Open shell in app container
docker compose logs -f app  # View logs for app service only (bot + webui)
```

### Troubleshooting Docker Build Issues

#### Error: bun.lock out of sync

If you see an error like:

```
error: lockfile had changes, but lockfile is frozen
```

**Solution:**

1. On your local machine, run:
   ```bash
   bun run fix:deps
   ```
2. Commit the updated `bun.lock`:
   ```bash
   git add bun.lock
   git commit -m "Update bun.lock"
   ```
3. Push and rebuild:
   ```bash
   git push
   bun run docker:reload
   ```

#### Missing Environment Variables

If you see warnings about missing environment variables:

```
WARN[0000] The "DISCORD_TOKEN" variable is not set. Defaulting to a blank string.
```

**Solution:**
Create a `.env` file or set environment variables in your `docker-compose.yml` or shell environment.

#### Build Fails During bun install

If the Docker build fails during the `bun install --frozen-lockfile` step:

1. Ensure `bun.lock` is committed and up to date
2. Check that you are using the correct Bun version (the `oven/bun` tag specified in the Dockerfile)
3. Try cleaning Docker cache:
   ```bash
   docker compose down
   docker system prune -a
   bun run docker:up
   ```

## Available Scripts

See `package.json` for a full list of available scripts. Common ones include:

### Main Entry Points

- `bun start` - Start the Discord bot (`src/bot.js`)
- `bun run webui` - Start the webui server (`src/webui-server.js`)
- `bun run local` - Run both bot and local server concurrently (useful for local development without R2)
- `bun run dev` - Start bot with watch mode (auto-restart on changes)

### Development

- `bun run register-commands` - Register Discord slash commands. The container does this on every start (`scripts/docker-entrypoint.sh`), so you only need it when running outside Docker or forcing a re-register.
- `bun run build:webui` - Build the webui frontend
- `bun run webui:dev` - Run webui in development mode with hot reload
- `bun run webui:dev:server` - Run webui server only (port 3002)
- `bun run test` - Run tests
- `bun run test:watch` - Run tests in watch mode
- `bun run migrate:storage` - Migrate storage to R2
- `bun run upload:404` - Upload 404 image to R2
- `bun run user:stats` - Generate user statistics report from database
- `bun run bot:test` - Start test bot (uses TEST\_\* prefixed environment variables)
- `bun run bot:prod` - Start prod bot (uses PROD\_\* prefixed environment variables)
- `bun run bot:test:dev` - Start test bot with hot reload (watch mode)
- `bun run bot:prod:dev` - Start prod bot with hot reload (watch mode)
- `bun run bot:register:test` - Register Discord commands for test bot
- `bun run bot:register:prod` - Register Discord commands for prod bot

### Documentation

- `bun run wiki:sync` - Sync local wiki files to GitHub Wiki (converts Obsidian-style links and pushes to GitHub)

### Wiki Documentation

The project maintains wiki documentation in two places:

1. **Local Wiki** (`wiki/` directory) - Uses Obsidian-style links (`[[Page-Name]]`) for local editing
2. **GitHub Wiki** - Public wiki accessible on GitHub, uses standard markdown links

When you update wiki files in the `wiki/` directory, sync them to GitHub Wiki using:

```bash
bun run wiki:sync
```

This script will:

- Convert Obsidian-style links (`[[Page-Name]]`) to GitHub Wiki format (`[Page-Name](Page-Name)`)
- Clone the GitHub Wiki repository
- Copy all converted files
- Commit and push changes to GitHub

**Note:** You need Git installed and appropriate permissions to push to the GitHub Wiki repository.

### Docker

- `bun run docker:up` - Start Docker containers
- `bun run docker:down` - Stop all containers
- `bun run docker:reload` - Reload containers (rebuild and restart)
- `bun run docker:restart` - Restart all containers
- `bun run docker:logs` - View logs for all services
- `bun run docker:register` - Force a re-register inside the container (done automatically on start)

### Code Quality

- `bun run check:sync` - Check if bun.lock is in sync
- `bun run lint` - Run ESLint (fails on warnings)
- `bun run lint:warn` - Run ESLint (allows warnings)
- `bun run lint:fix` - Automatically fix linting errors
- `bun run format` - Format code with Prettier
- `bun run format:check` - Check if files are formatted correctly
- `bun run validate` - Run all validation checks (sync, lint, format)
