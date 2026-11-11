# test bot

run a second discord application against its own database to try changes without touching the live bot.

## setup

one `.env` holds both bots. `TEST_` keys are the test bot, `PROD_` keys the docker bot:

```env
TEST_DISCORD_TOKEN=your_test_bot_token
TEST_CLIENT_ID=your_test_bot_client_id
TEST_POSTGRES_HOST=localhost
TEST_POSTGRES_DB=gronka_test

PROD_DISCORD_TOKEN=your_prod_bot_token
PROD_CLIENT_ID=your_prod_bot_client_id
PROD_POSTGRES_DB=gronka
```

`bun run bot:test` copies `TEST_` keys onto their plain names (`TEST_DISCORD_TOKEN` becomes `DISCORD_TOKEN`) before starting. the tokens, ports, postgres, cobalt, r2, log level and a few other keys can be given a `TEST_` version this way (the list is in `scripts/bot-start.js`); every other key is shared by both bots.

## running

```bash
bun run bot:register:test      # once, and after a command changes
bun run bot:test:webui         # bot plus webui on TEST_WEBUI_PORT (3101)
bun run bot:test:dev           # restart on file changes
```

the test bot shares cobalt and the cookie files with the docker bot. it has its own database, and it never touches the docker bot's r2 bucket: it reads only the `TEST_R2_*` keys, and without them it has no r2 at all (files too big for discord are refused).

## tips

- to test uploads, point `TEST_R2_*` at a separate bucket, never the docker bot's
- the test bot keeps its data in `gronka_test` between runs; the test suites never touch it, each run gets a fresh database of its own and drops it afterwards
