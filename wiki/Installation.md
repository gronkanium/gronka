Most installs should follow [Quick-Start](Quick-Start), which is `bun run setup` plus
`docker compose up -d --build`. This page is the long form: the manual steps, a bare-metal
(non-docker) run, and the prerequisites behind them.

Verify any install at any point with `bun run setup:check`, it changes nothing and reports
the toolchain, the bind-mounted files, cookies, required config and port conflicts.

---

## prerequisites

- [ ] Ubuntu 20.04+ or Debian 11+ server
- [ ] Bun 1.3+ installed
- [ ] FFmpeg installed (`sudo apt install ffmpeg`)
- [ ] Domain name configured in Cloudflare
- [ ] Discord bot created and token obtained

## installation steps

```bash
# 1. Clone/create project
mkdir gronka && cd gronka

# 2. Install dependencies
bun install

# 3. Configure environment
cp .env.example .env
nano .env  # Fill in tokens

# 5. Register Discord commands
bun src/register-commands.js

# 6. Start services (as of v0.13.0, only bot is needed - includes stats server)
bun src/bot.js  # Discord bot (includes stats HTTP server)

# optional: start webui dashboard
bun src/webui-server.js &

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
3. Copy bot token → save to `.env` as `DISCORD_TOKEN`

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

SERVER_PORT=3000
```

see [[Configuration]] for every key.

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

# prod bot credentials
PROD_DISCORD_TOKEN=your_prod_bot_token
PROD_CLIENT_ID=your_prod_bot_client_id
```

### running the bots

```bash
# start test bot
bun run bot:test

# start prod bot
bun run bot:prod

# register commands for each bot
bun run bot:register:test
bun run bot:register:prod
```

each bot uses its own postgres database (`TEST_POSTGRES_DB` and `PROD_POSTGRES_DB`).

for complete documentation, see the [[Test-Bot|test bot guide]].
