get gronka up and running in minutes.

## using docker (recommended)

```bash
# 1. Clone the repository
git clone https://github.com/thedorekaczynski/gronka.git
cd gronka

# 2. Create .env file
cp .env.example .env
# Edit .env and add your DISCORD_TOKEN and CLIENT_ID

# 3. Start the bot
docker compose up -d

# 4. Register Discord commands (one-time setup)
docker compose run --rm app npm run register-commands
```

## using docker with webui

```bash
# Start bot with webui dashboard
docker compose --profile webui up -d

# Access dashboard at http://localhost:3001
```

## local development

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your credentials

# 3. Register commands
npm run register-commands

# 4. Start bot and server
npm run local
```

## next steps

- read the [[Installation|installation guide]] for detailed setup
- check the [[Technical-Specification|technical specification]] for advanced configuration
- see [[Docker-Deployment|docker deployment]] for production deployment
