## prerequisites

- [ ] Ubuntu 20.04+ or Debian 11+ server
- [ ] Node.js 20+ installed
- [ ] FFmpeg installed (`sudo apt install ffmpeg`)
- [ ] Domain name configured in Cloudflare
- [ ] Discord bot created and token obtained

## installation steps

```bash
# 1. Clone/create project
mkdir gronka && cd gronka

# 2. Install dependencies
npm install discord.js axios fluent-ffmpeg express dotenv

# 3. Create directories
mkdir -p data-prod/gifs data-test/gifs
chmod 755 data-prod/gifs data-test/gifs

# 4. Configure environment
cp .env.example .env
nano .env  # Fill in tokens

# 5. Register Discord commands
node src/register-commands.js

# 6. Start services (as of v0.13.0, only bot is needed - includes stats server)
node src/bot.js  # Discord bot (includes stats HTTP server)

# optional: start webui dashboard
node src/webui-server.js &

# 7. Setup systemd services (production)
sudo nano /etc/systemd/system/gif-bot.service
sudo systemctl enable gif-bot
sudo systemctl start gif-bot

# note: gif-cdn.service is no longer needed as of v0.13.0
```

## discord application setup

### step 1: create application

1. Go to [https://discord.com/developers/applications](https://discord.com/developers/applications)
2. Click "New Application"
3. Name it (e.g., "GIF Converter")
4. Accept ToS

### step 2: configure bot

1. Navigate to "Bot" section
2. Click "Add Bot"
3. **CRITICAL**: Enable "Message Content Intent" (required to read attachments)
4. Copy bot token → save to `.env` as `DISCORD_TOKEN`

### step 3: set permissions

Required permissions (use calculator or checkboxes):

- `Send Messages` (2048)
- `Attach Files` (32768)
- `Use Application Commands` (2147483648)

**Permission integer**: `2147518464`

### step 4: generate invite URL

OAuth2 → URL Generator:

- **Scopes**: `bot`, `applications.commands`
- **Permissions**: Select above permissions
- Copy URL and open in browser to add bot to server

### step 5: get application ID

General Information → Application ID → save to `.env` as `CLIENT_ID`

## environment configuration

**`.env` file**:

```bash
# Discord
DISCORD_TOKEN=YOUR_BOT_TOKEN_HERE.abcdefghijklmnopqrstuvwxyz
CLIENT_ID=987654321098765432

# Storage (use data-prod for production, data-test for testing)
GIF_STORAGE_PATH=./data-prod
MAX_STORAGE_GB=50

# CDN
CDN_BASE_URL=https://cdn.site.com/gifs
SERVER_PORT=3000

# Processing
MAX_GIF_WIDTH=720
MAX_GIF_DURATION=30
DEFAULT_FPS=15

# Cloudflare (optional, for reference)
TUNNEL_ID=abc123def-456g-789h-012i-345jkl678mno
```

**Security Notes**:

- Never commit `.env` to git (add to `.gitignore`)
- Regenerate bot token if compromised
- Use environment variables in production (not `.env` files)

## test and production bot setup

gronka supports running separate test and production bots simultaneously. this is useful for testing changes without affecting production.

### basic setup

configure your `.env` file with prefixed variables:

```bash
# test bot credentials
TEST_DISCORD_TOKEN=your_test_bot_token
TEST_CLIENT_ID=your_test_bot_client_id
TEST_GIF_STORAGE_PATH=./data-test

# prod bot credentials
PROD_DISCORD_TOKEN=your_prod_bot_token
PROD_CLIENT_ID=your_prod_bot_client_id
PROD_GIF_STORAGE_PATH=./data-prod
```

### running the bots

```bash
# start test bot
npm run bot:test

# start prod bot
npm run bot:prod

# register commands for each bot
npm run bot:register:test
npm run bot:register:prod
```

each bot uses a separate database file (`gronka-test.db` and `gronka-prod.db`) and storage directory (`data-test/` and `data-prod/`).

for complete documentation, see the [[Test-Bot|test bot guide]].
