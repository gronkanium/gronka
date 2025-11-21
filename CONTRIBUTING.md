## Project Structure

This project consists of multiple components that can run independently or together:

- **Discord Bot** (`src/bot.js`) - Handles Discord interactions and converts files to GIFs
- **CDN Server** (`src/server.js`) - Serves converted GIFs and provides API endpoints
- **WebUI** (`src/webui-server.js`) - Optional dashboard for viewing statistics

When running in Docker, the main `app` service runs both the bot and CDN server together. The webui is an optional service that can be enabled via Docker Compose profiles.

## Dependency Management

### Adding/Removing Dependencies

When adding or removing dependencies, always run `npm install` to update `package-lock.json`:

```bash
npm install <package-name>
# or
npm install --save-dev <package-name>
```

**Important:** The `package-lock.json` file must be committed to git. It ensures consistent dependency versions across all environments, including Docker builds.

### Checking Lock File Sync

Before committing changes, verify that `package-lock.json` is in sync with `package.json`:

```bash
npm run check:sync
```

If the lock file is out of sync, fix it by running:

```bash
npm run fix:deps
```

This will update `package-lock.json` to match `package.json`.

### Git Hooks

This project uses [husky](https://typicode.github.io/husky/) to automatically check lock file sync and run linting before each commit. The pre-commit hook will:

- Verify `package-lock.json` is in sync with `package.json`
- Run ESLint to check code quality
- Check code formatting with Prettier

If any check fails, the commit will be blocked. Fix the issues and try again.

## Code Quality

### Linting

This project uses ESLint for code linting. Available commands:

```bash
npm run lint          # Check for linting errors (fails on warnings)
npm run lint:warn     # Check for linting errors (allows warnings)
npm run lint:fix      # Automatically fix linting errors
```

### Formatting

This project uses Prettier for code formatting. Available commands:

```bash
npm run format        # Format all files
npm run format:check  # Check if files are formatted correctly
```

### Validation

Run all checks at once:

```bash
npm run validate
```

This will check:

- Package lock file sync
- Linting errors
- Code formatting

## Docker

### Building and Running

The project uses Docker Compose with multiple services. The main app service runs both the Discord bot and CDN server:

```bash
npm run docker:up          # Start all services (app only by default)
npm run docker:down        # Stop all containers
npm run docker:reload      # Reload containers (rebuild and restart)
npm run docker:restart     # Restart all containers
npm run docker:register    # Register Discord commands in container
```

### Docker Services

The Docker Compose setup includes several services:

- **app** - Main service running both the Discord bot and CDN server
- **cobalt** - Self-hosted API for downloading media from social platforms (Twitter/X, TikTok, Instagram, YouTube, Reddit, Facebook, Threads). Runs by default on port 9000
- **giflossy** - Service used for GIF optimization via docker exec. Used internally by the bot for the `/optimize` command
- **watchtower** - Automatically updates the cobalt image. Runs cleanup and updates every 15 minutes
- **webui** - Optional dashboard for viewing statistics (requires profile, runs on port 3001)

All services except `webui` start automatically when running `docker compose up`. The `webui` service requires a profile to be enabled.

### Docker Compose Profiles

Only the `webui` service uses Docker Compose profiles. All other services (app, cobalt, giflossy, watchtower) start automatically when running `docker compose up`.

To start the optional webui service:

```bash
# Start webui
docker compose --profile webui up -d webui

# Start all services including webui
docker compose --profile webui up -d
```

### Common Docker Commands

```bash
npm run docker:logs        # View logs for all services
npm run docker:down        # Stop all containers
npm run docker:reload      # Reload containers (rebuild and restart)
npm run docker:restart     # Restart all containers
npm run docker:register    # Register Discord commands in container

# Manual docker compose commands
docker compose ps           # Check container status
docker compose exec app sh  # Open shell in app container
docker compose logs -f app  # View logs for app service only
docker compose logs -f webui # View logs for webui service only
```

### Troubleshooting Docker Build Issues

#### Error: package-lock.json out of sync

If you see an error like:

```
npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync
```

**Solution:**

1. On your local machine, run:
   ```bash
   npm run fix:deps
   ```
2. Commit the updated `package-lock.json`:
   ```bash
   git add package-lock.json
   git commit -m "Update package-lock.json"
   ```
3. Push and rebuild:
   ```bash
   git push
   npm run docker:reload
   ```

#### Missing Environment Variables

If you see warnings about missing environment variables:

```
WARN[0000] The "DISCORD_TOKEN" variable is not set. Defaulting to a blank string.
```

**Solution:**
Create a `.env` file or set environment variables in your `docker-compose.yml` or shell environment.

#### Build Fails During npm ci

If the Docker build fails during the `npm ci` step:

1. Ensure `package-lock.json` is committed and up to date
2. Check that you're using the correct Node version (Node 20 as specified in Dockerfile)
3. Try cleaning Docker cache:
   ```bash
   docker compose down
   docker system prune -a
   npm run docker:up
   ```

## Available Scripts

See `package.json` for a full list of available npm scripts. Common ones include:

### Main Entry Points

- `npm start` - Start the Discord bot (`src/bot.js`)
- `npm run server` - Start the CDN server (`src/server.js`)
- `npm run webui` - Start the webui server (`src/webui-server.js`)
- `npm run local` - Run both bot and server concurrently
- `npm run dev` - Start bot with watch mode (auto-restart on changes)

### Development

- `npm run register-commands` - Register Discord slash commands
- `npm run build:webui` - Build the webui frontend
- `npm run webui:dev` - Run webui in development mode with hot reload
- `npm run webui:dev:server` - Run webui server only (port 3002)
- `npm run test` - Run tests
- `npm run test:watch` - Run tests in watch mode
- `npm run migrate:storage` - Migrate storage to R2
- `npm run upload:404` - Upload 404 image to R2
- `npm run user:stats` - Generate user statistics report from database

### Documentation

- `npm run jekyll:serve` - Serve the Jekyll documentation site (port 5173)
- `npm run jekyll:build` - Build the Jekyll documentation site

### Docker

- `npm run docker:up` - Start Docker containers
- `npm run docker:down` - Stop all containers
- `npm run docker:reload` - Reload containers (rebuild and restart)
- `npm run docker:restart` - Restart all containers
- `npm run docker:logs` - View logs for all services
- `npm run docker:register` - Register Discord commands in container

### Code Quality

- `npm run check:sync` - Check if package-lock.json is in sync
- `npm run lint` - Run ESLint (fails on warnings)
- `npm run lint:warn` - Run ESLint (allows warnings)
- `npm run lint:fix` - Automatically fix linting errors
- `npm run format` - Format code with Prettier
- `npm run format:check` - Check if files are formatted correctly
- `npm run validate` - Run all validation checks (sync, lint, format)
