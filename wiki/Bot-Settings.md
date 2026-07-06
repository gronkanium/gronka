live-editable bot settings, managed from the webui settings page. unlike the environment variables in [[Configuration]], these are stored in postgres (`bot_settings` table) and take effect without a restart or redeploy.

## how it works

open the webui (default `http://localhost:3001`) and go to **settings**. every change is saved immediately. most settings are read per command through a short cache, so changes take effect within about 10 seconds. two settings (`admin_user_ids` and `rate_limit_cooldown`) are instead cached inside the bot process and refresh on a one-minute interval, as noted on each.

## delivery settings

### `twitter_delivery`

how `/download` serves x/twitter videos.

**default:** `hybrid`

**options:**

- `hybrid` - replies with the direct `video.twimg.com` url only when the video is too big to attach to discord; smaller clips are downloaded and attached as usual. large videos skip the entire download + upload, saving bandwidth and r2 storage.
- `always_url` - replies with the direct url whenever cobalt offers one, never rehosting.
- `always_download` - always download and rehost (the original behavior).

**notes:**

- direct urls live only as long as the tweet does - a rehosted copy survives tweet deletion, a direct url does not. that's the trade-off `hybrid`/`always_url` make for the bandwidth savings.
- requests with `start_time`/`end_time` always download (trimming needs the real file).
- this only applies to x/twitter: other services either don't expose usable direct urls (tiktok, youtube, reddit, bluesky are proxied) or expire them within hours (instagram).

### `twitter_direct_url_fallback`

when an x/twitter download fails (for example the video is over the size or duration limit), reply with the direct media url instead of an error.

**default:** `on`

### `url_only_mode`

reply with the direct media url from cobalt instead of downloading/uploading, for every service that offers one. this is the blunt, global version of `twitter_delivery` - most users want that instead.

**default:** `off`

## limits

### `max_video_duration`

maximum video length in seconds for non-admin downloads. admins are unlimited.

**default:** `300` (5 minutes) · **range:** 30-7200

### `rate_limit_cooldown`

seconds a non-admin must wait between commands. overrides the `RATE_LIMIT` environment variable when set.

**default:** the `RATE_LIMIT` env value (10 if unset) · **range:** 1-3600

**notes:** cached in the bot process; changes apply within a minute.

## access control

### `admin_user_ids`

discord user ids with admin privileges (bypass rate limiting and size/duration caps), managed as an add/remove list in the webui. entries from the `ADMIN_USER_IDS` environment variable are shown read-only and always remain admins.

**notes:** cached in the bot process; changes apply within a minute.

### `moderation_enabled`

enforce user bans - when on, banned users are blocked from every command.

**default:** `off`

### `maintenance_mode`

when on, all commands reply with a maintenance notice for non-admin users. admins can still use the bot normally.

**default:** `off`

## storage

### `admin_uploads_expire`

apply the temporary-upload ttl cleanup ([[Configuration|`R2_TEMP_UPLOAD_TTL_HOURS`]]) to admin r2 uploads too. off means admin uploads are permanent.

**default:** `off`

**notes:** only affects uploads made after enabling; files uploaded while it was off stay permanent.

## notifications

### `ntfy_topic`

ntfy topic to push command/alert notifications to. blank disables ntfy. defaults to the `NTFY_TOPIC` environment variable.

### `ntfy_server`

ntfy server hostname, for self-hosted ntfy instances.

**default:** `ntfy.sh`

## bot presence

the card at the top of the settings page sets the bot's discord status (`online`/`idle`/`dnd`/`invisible`) and custom activity text. the presence is persisted and restored when the bot restarts.
