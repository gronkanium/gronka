## Project Structure

This project consists of multiple components that can run independently or together:

- **Discord Bot** (`src/bot.js`) - Handles Discord interactions and converts files to GIFs
- **CDN Server** (`src/server.js`) - Serves converted GIFs and provides API endpoints
- **WebUI** (`src/webui-server.js`) - Optional dashboard for viewing statistics

When running in Docker, the main `app` service runs both the bot and CDN server together. The webui and cloudflared tunnel are optional services that can be enabled via Docker Compose profiles.

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
npm run lint          # Check for linting errors
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
npm run docker              # Start all services (app only by default)
npm run docker:rebuild     # Rebuild and start containers
npm run docker:stop        # Stop all containers
npm run docker:restart     # Restart all containers
```

### Docker Compose Profiles

Optional services are available via Docker Compose profiles:

- **webui** - Dashboard for viewing stats (runs on port 3001)
- **tunnel** - Cloudflare tunnel for exposing the CDN

To start optional services:

```bash
# Start webui
npm run docker:start:webui
# or
docker compose --profile webui up -d webui

# Start tunnel
npm run docker:start:tunnel
# or
docker compose --profile tunnel up -d cloudflared

# Start all services including profiles
docker compose --profile webui --profile tunnel up -d
```

### Common Docker Commands

```bash
npm run docker:logs        # View logs for all services
npm run docker:logs:app    # View logs for app service
npm run docker:logs:webui  # View logs for webui service
npm run docker:logs:tunnel # View logs for tunnel service
npm run docker:status      # Check container status
npm run docker:shell       # Open shell in app container
npm run docker:clean       # Stop containers and clean up
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
   npm run docker:rebuild
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
   npm run docker:clean
   npm run docker:rebuild
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
- `npm run tunnel` - Run cloudflared tunnel locally

### Docker

- `npm run docker` - Start Docker containers
- `npm run docker:rebuild` - Rebuild and start Docker containers
- `npm run docker:stop` - Stop all containers
- `npm run docker:restart` - Restart all containers
- `npm run docker:logs` - View logs for all services
- `npm run docker:status` - Check container status
- `npm run docker:clean` - Stop containers and clean up

### Code Quality

- `npm run check:sync` - Check if package-lock.json is in sync
- `npm run lint` - Run ESLint
- `npm run lint:fix` - Automatically fix linting errors
- `npm run format` - Format code with Prettier
- `npm run format:check` - Check if files are formatted correctly
- `npm run validate` - Run all validation checks (sync, lint, format)
