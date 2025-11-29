quick reference for common docker commands.

## core commands

```bash
docker compose up -d          # start services
docker compose down           # stop all services
docker compose logs -f        # view logs (follow mode)
docker compose ps             # check container status
docker compose restart app    # restart app container
```

## additional services

for services with profiles (webui), use docker compose directly:

```bash
# start webui
docker compose --profile webui up -d

# view specific service logs
docker compose logs -f webui
```

## common tasks

### register discord commands

```bash
# if container is running
docker compose exec app npm run register-commands

# if container is not running (one-off command)
docker compose run --rm app npm run register-commands
```

### check container status

```bash
docker compose ps
```

### restart after environment variable changes

```bash
docker compose restart app
```

## troubleshooting

### container won't start

1. check logs: `docker compose logs -f`
2. verify `.env` file exists with required variables
3. check docker compose config: `docker compose config`

### service is unhealthy

1. check logs: `docker compose logs -f`
2. check health endpoint: `curl http://localhost:3000/health`
3. rebuild: `docker compose build --no-cache && docker compose up -d`

### code changes not reflected

after making code changes, rebuild:

```bash
docker compose build --no-cache
docker compose up -d
```

### permission issues

```bash
# on linux/mac
sudo chown -R $USER:$USER data-prod data-test temp logs
chmod -R 755 data-prod data-test temp logs
```

## cleanup

```bash
# stop and remove containers
docker compose down

# remove volumes (warning: deletes gifs)
docker compose down -v

# remove images
docker compose down --rmi all
```
