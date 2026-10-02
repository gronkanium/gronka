live-editable bot settings, managed from the webui settings page. unlike the environment variables in [[Configuration]], these are stored in postgres (`bot_settings` table) and take effect without a restart or redeploy.

## how it works

open the webui (default `http://localhost:3001`) and go to **settings**. every change is saved immediately. settings are read per command through a short cache, so changes take effect within about 10 seconds.

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
- requests with `start`/`end` always download (trimming needs the real file).
- this only applies to x/twitter: other services either don't expose usable direct urls (tiktok, youtube, reddit, bluesky are proxied) or expire them within hours (instagram).

### `twitter_direct_url_fallback`

when an x/twitter download fails (for example the video is over the size or duration limit), reply with the direct media url instead of an error.

**default:** `on`

### `url_only_mode`

reply with the direct media url from cobalt instead of downloading/uploading, for every service that offers one. this is the blunt, global version of `twitter_delivery` - most users want that instead.

**default:** `off`

## limits

### `max_video_duration`

maximum video length in seconds for downloads. size is the main limit; this only catches very long videos.

**default:** `300` (5 minutes) · **range:** 30-7200

### `max_video_size_mb`

largest download in mb. oversized videos are refused before they are downloaded.

### `upload_ttl_tiers`

how long an r2 upload lives, by size: `MB:hours` pairs, e.g. `100:72,250:24,500:8,1024:2`. a file keeps the hours of the first tier it fits under. used by the cleanup job and shown in the reply. see [[R2-Storage]].

### `r2_soft_limit_gb`

new r2 uploads are refused while the bucket holds more than this. `0` turns the guard off.

## availability

### `maintenance_mode`

when on, every command replies with a maintenance notice.

**default:** `off`

### `queue_paused`

workers stop taking new media jobs; running ones finish. use it to drain before a deploy.

**default:** `off`

## bot presence

the card at the top of the settings page sets the bot's discord status (`online`/`idle`/`dnd`/`invisible`) and custom activity text. the presence is persisted and restored when the bot restarts.
