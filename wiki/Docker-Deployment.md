deploy gronka with docker compose.

## prerequisites

- docker engine 20.10+ with docker compose 2
- a discord bot token and application id

## quick start

```bash
git clone https://github.com/gronkanium/gronka && cd gronka
bun run setup            # writes .env and the cookie files; --yes with flags for no prompts
docker compose up -d --build
docker compose logs app --tail 30
```

healthy is `bot logged in as <your bot>`. then register the slash commands once:

```bash
docker compose exec app bun run register-commands
```

commands can take up to an hour to show up everywhere.

## what runs

| service | what it is | ports |
| --- | --- | --- |
| `app` | the bot, the webui and `/health` | `3000`, `3001` |
| `worker` (2) | run media jobs from the queue | none |
| `postgres` | settings, job queue, failure records, anonymous counts | `127.0.0.1:5432` |
| `cobalt` | downloads for social sites | `127.0.0.1:9000` |

only `./temp` is mounted for media: each job works in its own folder there and deletes it when it ends. nothing else about media or users is written to disk. see [[Configuration]] for every setting and [[Cookies]] for logins to gated content.

the webui has no login: keep port `3001` on your own network.

## health checks

`app` answers `GET /health` with 200 once it is connected to discord; workers touch a heartbeat file. docker restarts either when they stop.

## updating

```bash
git pull
docker compose up -d --build --remove-orphans app worker
```

pause the queue in the webui first (workers & queue, or the `queue_paused` setting) and wait for running jobs to finish if you do not want any interrupted. a job that is interrupted is retried by another worker.

coming from a version before 3.0.0: delete `data-prod/` and `data-test/`. they held the old local media cache, which 3.0.0 no longer mounts, reads or cleans up, so the files people downloaded through the bot otherwise stay on disk.

## troubleshooting

- container will not start: `docker compose logs app`; a missing `.env` key is named in the error
- permission errors on `./temp`: `sudo chown -R $USER:$USER temp`
- ffmpeg errors: it ships in the image; rebuild with `docker compose build app`

## removing

```bash
docker compose down        # stop everything
docker compose down -v     # also delete the database
```
