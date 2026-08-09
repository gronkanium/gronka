get gronka up and running in minutes.

## using docker (recommended)

```bash
# 1. Clone the repository
git clone https://github.com/thedorekaczynski/gronka.git
cd gronka

# 2. Create .env file
cp .env.example .env
# Edit .env and add your DISCORD_TOKEN and CLIENT_ID

# 3. Create the bind-mounted cookie files (docker mounts a DIRECTORY over a missing file,
#    which makes yt-dlp and cobalt silently run unauthenticated)
touch tiktok-cookies.txt
cp cookies.example.json cookies.json

# 4. Start the bot
docker compose up -d

# 5. Register Discord commands (one-time setup)
docker compose run --rm app bun run register-commands
```

## webui dashboard

the dashboard ships inside the bot container — there is nothing extra to start. once the stack
is up it answers on http://localhost:3001 (port from `WEBUI_PORT`).

## local development

```bash
# 1. Install dependencies
bun install

# 2. Configure environment
cp .env.example .env
# Edit .env with your credentials

# 3. Register commands
bun run register-commands

# 4. Start bot and server
bun run local
```

## test and production bots

for local development, you can run separate test and production bots simultaneously:

```bash
# configure both bots in .env with TEST_* and PROD_* prefixes
# then start them separately:

bun run bot:test        # start test bot
bun run bot:prod        # start prod bot
bun run bot:register:test  # register test bot commands
bun run bot:register:prod  # register prod bot commands
```

see the [[Test-Bot|test bot documentation]] for complete setup instructions.

## next steps

- read the [[Installation|installation guide]] for detailed setup
- see [[Running-for-Free|running for free]] for the zero-cost hosting + storage path
- check the [[Technical-Specification|technical specification]] for advanced configuration
- see [[Docker-Deployment|docker deployment]] for production deployment
