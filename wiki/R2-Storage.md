gronka can use cloudflare r2 for storing and serving gifs, videos, and images. when configured, files are uploaded to r2 and served via your public domain. if not configured, it falls back to local filesystem storage.

## why use r2

r2 provides several advantages over local storage:

- scalable storage without managing disk space
- global cdn distribution for faster access
- automatic deduplication across all files
- no egress fees (unlike s3)
- seamless integration with cloudflare

## setup

### step 1: create r2 bucket

1. go to cloudflare dashboard → r2
2. click "create bucket"
3. choose a bucket name (e.g., `gronka-media`)
4. select a location (optional, defaults to auto)

### step 2: create r2 api token

1. go to r2 → manage r2 api tokens
2. click "create api token"
3. set permissions:
   - object read and write
   - bucket name: your bucket name
4. copy the access key id and secret access key

### step 3: configure public access

1. go to r2 → your bucket → settings
2. enable public access
3. create a custom domain or use the r2.dev subdomain
4. note your public domain (e.g., `cdn.gronka.p1x.dev`)

### step 4: configure gronka

add these environment variables to your `.env` file:

```env
R2_ACCOUNT_ID=your_cloudflare_account_id
R2_ACCESS_KEY_ID=your_access_key_id
R2_SECRET_ACCESS_KEY=your_secret_access_key
R2_BUCKET_NAME=gronka-media
R2_PUBLIC_DOMAIN=https://cdn.gronka.p1x.dev
```

you can find your account id in the cloudflare dashboard url or in the r2 overview page.

## how it works

when r2 is configured:

1. files are uploaded to r2 immediately after processing
2. the bot checks r2 first before downloading or converting to avoid duplicates
3. files are served directly from your r2 public domain
4. local storage is still used as a cache for faster access

when r2 is not configured:

1. files are stored locally in the `data` directory
2. files are served via the local express server
3. deduplication still works using file hashes

## file organization

files in r2 are organized by type:

- `gifs/{hash}.gif` - converted gif files
- `videos/{hash}.{ext}` - original video files
- `images/{hash}.{ext}` - image files

each file is named using its md5 hash, ensuring automatic deduplication.

## migration

to migrate existing local files to r2:

1. ensure r2 is configured in your `.env`
2. restart the bot
3. existing files will be uploaded to r2 as they are accessed
4. you can also use the migration script: `npm run migrate:storage`

## troubleshooting

### files not uploading

- verify r2 credentials are correct
- check bucket name matches exactly
- ensure bucket has public access enabled
- check bot logs for r2 errors

### files not accessible

- verify public domain is configured correctly
- check dns settings if using custom domain
- ensure bucket public access is enabled
- verify file paths match the expected format

### high r2 costs

r2 charges for storage and class a operations (list, write). to reduce costs:

- enable r2 usage cache: `STATS_CACHE_TTL=300000` (5 minutes)
- avoid frequent stats commands
- use local storage for development
- enable temporary uploads with automatic cleanup (see below)

## temporary uploads

gronka supports automatic cleanup of r2 uploads after a configurable time period. when enabled, files uploaded to r2 are tracked and automatically deleted after the ttl expires.

### how it works

when temporary uploads are enabled:

1. all new r2 uploads are tracked in the database with an expiration timestamp
2. a background cleanup job runs periodically (default: every hour)
3. expired files are automatically deleted from r2
4. files are only deleted when all uploads referencing that file have expired (reference counting)

existing files uploaded before enabling this feature are not tracked and remain permanent (grandfathered).

### configuration

to enable temporary uploads, add these to your `.env`:

```env
# enable temporary upload tracking
R2_TEMP_UPLOADS_ENABLED=true

# ttl in hours (default: 72)
R2_TEMP_UPLOAD_TTL_HOURS=72

# enable background cleanup job
R2_CLEANUP_ENABLED=true

# cleanup interval in milliseconds (default: 3600000 = 1 hour)
R2_CLEANUP_INTERVAL_MS=3600000

# cleanup log level: 'minimal', 'detailed', or 'debug' (default: 'detailed')
R2_CLEANUP_LOG_LEVEL=detailed
```

### important notes

- both `R2_TEMP_UPLOADS_ENABLED` and `R2_CLEANUP_ENABLED` must be `true` for automatic deletion to work
- tracking can be enabled without cleanup (files tracked but not deleted) for monitoring
- cleanup requires tracking to be enabled
- default ttl is 72 hours (3 days)
- files uploaded before enabling remain permanent
- if the same file is uploaded multiple times, each upload has its own ttl
- files are only deleted when all uploads referencing them have expired

### troubleshooting temporary uploads

if files are not being deleted:

- verify both `R2_TEMP_UPLOADS_ENABLED=true` and `R2_CLEANUP_ENABLED=true`
- check bot logs for cleanup job errors
- verify cleanup job is running (check logs for "starting r2 cleanup job")
- check database for failed deletions: files with `deletion_failed > 0` need manual review

if cleanup job is failing:

- check r2 credentials and permissions
- verify bucket name is correct
- check logs for specific error messages
- failed deletions are retried on each cleanup run
