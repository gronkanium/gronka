# Cloudflare Pages Deployment with KV Stats

This guide explains how to deploy the Jekyll site to Cloudflare Pages with automated stats updates via Cloudflare KV.

## Overview

The deployment uses Cloudflare KV to store stats, which are:
- Written by the bot server when stats change
- Read during Cloudflare Pages build
- Displayed in the Jekyll site footer

This approach keeps your bot server secure (no public API exposure) while providing automated stats updates.

## Workflow

1. **Bot processes files** - When users convert/download files, stats are updated in the database
2. **Stats sync triggered** - After processing, bot triggers stats sync (with 5-minute debouncing)
3. **Compare with KV** - Script fetches current stats from database and compares with KV
4. **Write to KV** - Only writes to KV if stats have changed
5. **Trigger rebuild** - Calls Cloudflare Pages API to rebuild (only if stats changed)
6. **Build process** - Cloudflare Pages build script reads from KV, writes to `_data/stats.json`
7. **Jekyll builds** - Site includes fresh stats in footer

## Setup

### Step 1: Create Cloudflare KV Namespace

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Navigate to **Workers & Pages** → **KV**
3. Click **Create a namespace**
4. Name it (e.g., `gronka-stats`)
5. Copy the **Namespace ID** (you'll need this for environment variables)

### Step 2: Create Cloudflare API Token

1. Go to **My Profile** → **API Tokens**
2. Click **Create Token**
3. Use **Edit Cloudflare Workers** template or create custom token with:
   - **Account** → **Cloudflare Workers** → **Edit**
   - **Account** → **Workers KV Storage** → **Edit**
   - **Account** → **Pages** → **Edit**
4. Copy the token (you'll only see it once!)

### Step 3: Configure Bot Server Environment Variables

Add these to your `.env` file on the bot server:

```env
# Cloudflare API Configuration
CLOUDFLARE_API_TOKEN=your_api_token_here
CLOUDFLARE_ACCOUNT_ID=your_account_id_here
CLOUDFLARE_KV_NAMESPACE_ID=your_kv_namespace_id_here
CLOUDFLARE_PAGES_PROJECT_NAME=your_pages_project_name
```

**Where to find:**
- `CLOUDFLARE_API_TOKEN`: Created in Step 2
- `CLOUDFLARE_ACCOUNT_ID`: Found in Cloudflare dashboard URL or account overview
- `CLOUDFLARE_KV_NAMESPACE_ID`: From Step 1 (Namespace ID)
- `CLOUDFLARE_PAGES_PROJECT_NAME`: Name of your Cloudflare Pages project (created in Step 5)

### Step 4: Set Up Periodic Stats Sync

The bot automatically syncs stats after file processing (with debouncing), but you should also set up a periodic sync to catch any missed updates.

**Option A: Cron Job (Linux/Mac)**

Add to crontab (`crontab -e`):

```bash
# Sync stats to KV every 12 hours
0 */12 * * * cd /path/to/gronka && npm run kv:sync-stats >> logs/kv-sync.log 2>&1
```

**Option B: Systemd Timer (Linux)**

Create `/etc/systemd/system/gronka-kv-sync.timer`:

```ini
[Unit]
Description=Gronka KV Stats Sync Timer
Requires=gronka-kv-sync.service

[Timer]
OnCalendar=*-*-* 00,12:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

Create `/etc/systemd/system/gronka-kv-sync.service`:

```ini
[Unit]
Description=Gronka KV Stats Sync
After=network.target

[Service]
Type=oneshot
User=your_user
WorkingDirectory=/path/to/gronka
Environment="NODE_ENV=production"
ExecStart=/usr/bin/npm run kv:sync-stats
```

Enable and start:

```bash
sudo systemctl enable gronka-kv-sync.timer
sudo systemctl start gronka-kv-sync.timer
```

### Step 5: Create Cloudflare Pages Project

1. Go to **Workers & Pages** → **Pages**
2. Click **Create a project**
3. Connect your GitHub repository
4. Configure build settings:
   - **Framework preset**: Jekyll
   - **Build command**: `npm run kv:fetch-stats && bundle install && bundle exec jekyll build`
   - **Build output directory**: `_site`
   - **Root directory**: `/` (or leave empty)

### Step 6: Bind KV Namespace to Pages Project

1. Go to your Pages project → **Settings** → **Functions**
2. Under **KV Namespace Bindings**, click **Add binding**
3. Select your KV namespace (created in Step 1)
4. Set variable name: `KV_BINDING` or `STATS_KV`
5. Click **Save**

### Step 7: Configure Pages Environment Variables

1. Go to your Pages project → **Settings** → **Environment variables**
2. Add these variables (for build script):

```env
CLOUDFLARE_API_TOKEN=your_api_token_here
CLOUDFLARE_ACCOUNT_ID=your_account_id_here
CLOUDFLARE_KV_NAMESPACE_ID=your_kv_namespace_id_here
```

**Note:** These are used by the build script to read from KV. The API token only needs KV read permissions for the build script.

### Step 8: Deploy

1. Push your code to the `main` branch
2. Cloudflare Pages will automatically build and deploy
3. The build script will fetch stats from KV and include them in the site

## Environment Variables Summary

### Bot Server (`.env` file)

| Variable | Description | Required |
|----------|-------------|----------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with KV write and Pages deploy permissions | Yes |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID | Yes |
| `CLOUDFLARE_KV_NAMESPACE_ID` | KV namespace ID for stats | Yes |
| `CLOUDFLARE_PAGES_PROJECT_NAME` | Name of your Cloudflare Pages project | Yes |

### Cloudflare Pages (in Pages dashboard)

| Variable | Description | Required |
|----------|-------------|----------|
| `CLOUDFLARE_API_TOKEN` | API token with KV read permissions | Yes |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID | Yes |
| `CLOUDFLARE_KV_NAMESPACE_ID` | KV namespace ID | Yes |

**Plus:** KV namespace binding configured in Pages Functions settings (binding name: `KV_BINDING` or `STATS_KV`)

## How It Works

### Automatic Sync After Processing

When a user converts or downloads a file:
1. Bot processes the file successfully
2. `triggerStatsSync()` is called (with 5-minute debouncing)
3. If last sync was > 5 minutes ago, `sync-stats-to-kv.js` runs in background
4. Script compares database stats with KV stats
5. If stats changed, writes to KV and triggers rebuild

### Periodic Sync

Every 12 hours (via cron/scheduler):
1. `sync-stats-to-kv.js` runs
2. Fetches stats from database
3. Compares with KV
4. If changed, writes to KV and triggers rebuild

### Build Process

During Cloudflare Pages build:
1. `fetch-stats-from-kv.js` runs first
2. Reads stats from KV using Cloudflare API
3. Writes to `_data/stats.json` in Jekyll format
4. Jekyll build includes stats in footer
5. Site deploys with fresh stats

## Troubleshooting

### Stats Not Updating

1. **Validate configuration** - Run `npm run validate:cloudflare` to check environment variables
2. **Test connection** - Run `npm run test:cloudflare` to verify API access and permissions
3. **Check bot server logs** - Look for errors in `sync-stats-to-kv.js`
4. **Test sync manually** - Run `npm run kv:sync-stats` and check output
5. **Check KV namespace** - Verify namespace ID is correct
6. **Check API token permissions** - Ensure token has KV write and Pages deploy permissions

### Build Failing

1. **Check build logs** - Look for errors in Cloudflare Pages build logs
2. **Verify Pages environment variables** - Ensure all vars are set in Pages dashboard
3. **Test connection** - Run `npm run test:cloudflare` to verify KV read access
4. **Test fetch script** - Run `npm run kv:fetch-stats` locally
5. **Check KV binding** - Verify KV namespace is bound to Pages project

### Stats Not Appearing in Footer

1. **Check `_data/stats.json`** - Verify file exists and has correct format
2. **Check Jekyll build** - Ensure `_data/stats.json` is not excluded in `_config.yml`
3. **Check footer template** - Verify `_includes/footer.html` reads from `site.data.stats`

### Rebuild Not Triggering

1. **Check API token** - Ensure token has Pages deploy permissions
2. **Verify project name** - Check `CLOUDFLARE_PAGES_PROJECT_NAME` matches actual project name
3. **Check sync script logs** - Look for errors when triggering rebuild
4. **Test rebuild manually** - Use Cloudflare API or dashboard to trigger rebuild

## Manual Commands

```bash
# Validate Cloudflare configuration
npm run validate:cloudflare

# Test Cloudflare KV and Pages connection
npm run test:cloudflare

# Sync stats to KV manually
npm run kv:sync-stats

# Fetch stats from KV (for testing)
npm run kv:fetch-stats

# Build Jekyll site locally with KV stats
npm run kv:fetch-stats && npm run jekyll:build
```

### Validation and Testing

Before running sync or fetch commands, you can validate your configuration:

1. **Validate environment variables:**
   ```bash
   npm run validate:cloudflare
   ```
   This checks that all required Cloudflare environment variables are set in your `.env` file.

2. **Test Cloudflare connection:**
   ```bash
   npm run test:cloudflare
   ```
   This tests:
   - KV read access
   - KV write access
   - Pages project access
   
   Use this to verify your API token has correct permissions and all IDs are correct.

## Security Notes

- All API calls are **outbound only** - no inbound connections to your server
- Bot server never exposes any API endpoints
- Cloudflare API token should have minimal required permissions
- KV namespace is only accessible via Cloudflare API (not publicly exposed)
- Stats are read-only during build (no write access needed)

## Cost Considerations

- **Cloudflare KV**: Free tier includes 100,000 reads/day and 1,000 writes/day
- **Cloudflare Pages**: Free tier includes unlimited builds and deployments
- **API calls**: Minimal - only syncs when stats change (not on every file processing)

For typical usage, you'll stay well within free tier limits.

