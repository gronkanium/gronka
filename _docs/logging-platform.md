---
layout: doc
title: logging platform
permalink: /docs/logging-platform/
topic: guides
chapter: 7
description: centralized logging, monitoring, and metrics dashboard
---

# logging platform

gronka now includes a built-in logging platform for viewing, searching, and monitoring logs in real-time. this replaces the need to manually check the database or rely on ntfy.sh notifications.

## features

- **real-time log streaming** - logs appear instantly via websocket
- **advanced filtering** - filter by component, log level, time range
- **full-text search** - search through log messages
- **metrics dashboard** - view error rates, warnings, and trends
- **pagination** - easily browse through historical logs
- **log retention** - all logs stored in postgresql database
- **docker logs viewer** - optional dozzle integration for container logs

## accessing the logging platform

the logging platform is integrated into the webui dashboard:

1. start the webui service:
   ```bash
   docker compose --profile webui up
   ```

2. access the webui at [http://localhost:3001](http://localhost:3001)

3. click the "logs" tab to view application logs

4. click the "metrics" tab to view log metrics and statistics

## logs viewer

### filters

the logs viewer provides several filtering options:

- **component filter** - filter by service component (bot, server, webui, etc.)
- **level toggles** - show/hide logs by level (error, warn, info, debug)
- **search** - full-text search through log messages
- **auto-scroll** - automatically show new logs as they arrive

### log levels

logs are color-coded by severity:

- **error** (red) - critical errors that need attention
- **warn** (yellow) - warnings and potential issues
- **info** (green) - informational messages
- **debug** (gray) - detailed debugging information

### pagination

navigate through logs using the pagination controls at the bottom:

- **previous/next** - move between pages
- **page info** - shows current range and total count

### real-time updates

when auto-scroll is enabled and you're on the first page, new logs appear instantly via websocket connection. the connection status is shown in the top-right corner:

- **● live** (green) - connected and receiving updates
- **○ disconnected** (gray) - reconnecting

## metrics dashboard

the metrics dashboard provides insights into your application's health:

### key metrics

- **errors (last hour)** - critical errors in the past 60 minutes
- **errors (last 24h)** - total errors in the past day
- **warnings (last hour)** - warnings in the past 60 minutes
- **warnings (last 24h)** - total warnings in the past day
- **total logs (24h)** - all logs generated in the past day

### logs by level

bar chart showing the distribution of logs by level (error, warn, info, debug) over the past 24 hours.

### logs by component

breakdown of log volume by component/service, helping identify which parts of the system are most active.

### error timeline

24-hour timeline showing error frequency by hour, helping identify patterns and peak error times.

## api endpoints

the logging platform exposes several api endpoints:

### get logs

```
GET /api/logs
```

query parameters:
- `component` - filter by component name
- `level` - filter by level (comma-separated for multiple)
- `search` - search in messages
- `startTime` - start timestamp (unix ms)
- `endTime` - end timestamp (unix ms)
- `limit` - max results (default: 100)
- `offset` - pagination offset (default: 0)

example:
```bash
curl "http://localhost:3001/api/logs?level=ERROR,WARN&limit=50"
```

### get log metrics

```
GET /api/logs/metrics
```

query parameters:
- `timeRange` - time range in milliseconds (default: 24 hours)

example:
```bash
curl "http://localhost:3001/api/logs/metrics"
```

### get components

```
GET /api/logs/components
```

returns list of all unique component names.

## docker logs viewer (dozzle)

for viewing raw docker container logs, gronka includes optional dozzle integration:

### starting dozzle

```bash
docker compose --profile logs up
```

this starts both the webui and dozzle services.

### accessing dozzle

open [http://localhost:8080](http://localhost:8080) in your browser.

dozzle provides:
- real-time container log streaming
- multi-container view
- log search and filtering
- no configuration required

### which to use?

- **webui logs** - structured application logs stored in database, with search, filtering, and metrics
- **dozzle** - raw docker container output, useful for debugging container issues

use webui logs for application monitoring and dozzle for container-level debugging.

## database storage

all logs are stored in the postgresql database in the `logs` table:

```sql
CREATE TABLE logs (
  id SERIAL PRIMARY KEY,
  timestamp BIGINT NOT NULL,
  component TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata TEXT
);
```

indexes are created for efficient querying:
- `timestamp` - fast time-range queries
- `component` - fast component filtering
- `level` - fast level filtering
- `(component, timestamp)` - optimized for common queries

## log retention

by default, all logs are retained indefinitely. if you need to clean up old logs:

### manual cleanup

```bash
# connect to postgresql database
psql -h localhost -U gronka -d gronka

# delete logs older than 30 days
DELETE FROM logs WHERE timestamp < EXTRACT(EPOCH FROM NOW() - INTERVAL '30 days')::BIGINT * 1000;

# analyze to update statistics
ANALYZE logs;
```

### automated cleanup (future)

log rotation and automatic cleanup will be added in a future release.

## configuration

logging is configured via environment variables:

```bash
# log level (DEBUG, INFO, WARN, ERROR)
LOG_LEVEL=INFO

# log directory for file-based logs
LOG_DIR=./logs

# disable database logging (for tests)
SKIP_DB_INIT=false
```

## troubleshooting

### logs not appearing

1. check database initialization:
   ```bash
   # verify logs table exists
   psql -h localhost -U gronka -d gronka -c "SELECT COUNT(*) FROM logs;"
   ```

2. check log level:
   ```bash
   # ensure LOG_LEVEL is not too restrictive
   echo $LOG_LEVEL
   ```

3. verify webui connection:
   - check websocket status in logs viewer (top-right)
   - check browser console for errors

### websocket disconnected

1. check webui server is running:
   ```bash
   docker compose ps webui
   ```

2. check network connectivity:
   ```bash
   # test websocket endpoint
   curl -i -N -H "Connection: Upgrade" \
     -H "Upgrade: websocket" \
     http://localhost:3001/api/ws
   ```

3. check logs for errors:
   ```bash
   docker compose logs webui
   ```

### dozzle not starting

1. check docker socket permissions:
   ```bash
   # on linux, ensure socket is accessible
   ls -l /var/run/docker.sock
   ```

2. start with logs profile:
   ```bash
   docker compose --profile logs up
   ```

## performance

the logging platform is designed for minimal performance impact:

- **async writes** - log writes don't block application code
- **indexed queries** - database queries are optimized with indexes
- **pagination** - large result sets are paginated
- **efficient storage** - postgresql connection pooling for concurrent access

typical performance:
- log write: <1ms
- log query (100 results): <10ms
- metrics query: <50ms

## security

log data may contain sensitive information. secure your logging platform:

1. **restrict access** - only expose webui on trusted networks
2. **use authentication** - configure `STATS_USERNAME` and `STATS_PASSWORD`
3. **sanitize logs** - gronka automatically sanitizes control characters and ansi codes
4. **secure docker socket** - dozzle has read-only access to docker socket

## integration

the logging platform can be integrated with external tools:

### prometheus

export metrics for prometheus monitoring (future feature).

### grafana

visualize logs in grafana using postgresql data source (future feature).

### alerting

set up alerts based on error rates (future feature).

## further reading

- [api endpoints](/docs/api-endpoints/)
- [docker deployment](/docs/docker/)
- [troubleshooting](/docs/troubleshooting/)

