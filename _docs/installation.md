---
title: installation
topic: getting-started
chapter: 2
description: step-by-step installation instructions for gronka
---

## prerequisites

- [ ] Ubuntu 20.04+ or Debian 11+ server
- [ ] Node.js 18+ installed
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
mkdir -p data/gifs
chmod 755 data/gifs

# 4. Configure environment
cp .env.example .env
nano .env  # Fill in tokens

# 5. Register Discord commands
node src/register-commands.js

# 6. Start services
node src/server.js &  # CDN server
node src/bot.js  # Discord bot

# 7. Setup systemd services (production)
sudo nano /etc/systemd/system/gif-bot.service
sudo nano /etc/systemd/system/gif-cdn.service
sudo systemctl enable gif-bot gif-cdn
sudo systemctl start gif-bot gif-cdn
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

# Storage
GIF_STORAGE_PATH=/var/www/gifs
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

