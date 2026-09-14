get gronka up and running in minutes.

## using docker (recommended)

```bash
git clone https://github.com/thedorekaczynski/gronka.git
cd gronka
bun install

bun run setup                 # asks for your token, writes .env, creates the mounted files
docker compose up -d --build
bun run docker:register       # register the slash commands, once
```

`bun run setup` is the whole configuration step. It asks only for what it cannot work out —
bot token, application id, your Discord user id, a Postgres password — and optionally walks you
through a test bot and R2. It writes `.env` from `.env.example` and **keeps the comments**, so the
generated file still documents every remaining knob.

It also creates the three files docker bind-mounts **as files**. This matters more than it looks:
if one is missing, Docker creates a *directory* in its place, and yt-dlp/cobalt then run
unauthenticated. The failure reads as "cookies don't work", not "the mount is wrong".

Check an install at any time — it changes nothing:

```bash
bun run setup:check          # toolchain, mounted files, cookies, config, ports
bun run setup:repair         # create only the missing files; no questions
```

Healthy is `bot logged in as <name>` plus `All processes running` in
`docker compose logs app --tail 30`.

### doing it by hand

`setup` is a convenience, not a requirement — nothing depends on it having run:

```bash
cp .env.example .env          # then edit PROD_DISCORD_TOKEN, PROD_CLIENT_ID, PROD_POSTGRES_PASSWORD
cp cookies.example.json cookies.json
cp cookies.example.json cobalt-cookies.json
touch tiktok-cookies.txt
chmod 600 cookies.json cobalt-cookies.json tiktok-cookies.txt
```

Optional logins for gated content are in [Cookies](Cookies).

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
