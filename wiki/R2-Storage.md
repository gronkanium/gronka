gronka can put files that are too big for a discord attachment on cloudflare r2 and reply with a link. without r2 those files are refused; everything that fits is attached straight to discord either way, and nothing is kept on disk.

## setup

### step 1: create r2 bucket

1. go to cloudflare dashboard â†’ r2
2. click "create bucket"
3. choose a bucket name (e.g., `gronka-media`)
4. select a location (optional, defaults to auto)

### step 2: create r2 api token

1. go to r2 â†’ manage r2 api tokens
2. click "create api token"
3. set permissions:
   - object read and write
   - bucket name: your bucket name
4. copy the access key id and secret access key

### step 3: configure public access

1. go to r2 â†’ your bucket â†’ settings
2. enable public access
3. create a custom domain or use the r2.dev subdomain
4. note your public domain (e.g., `cdn.example.com`)

### step 4: configure gronka

add these environment variables to your `.env` file:

```env
R2_ACCOUNT_ID=your_cloudflare_account_id
R2_ACCESS_KEY_ID=your_access_key_id
R2_SECRET_ACCESS_KEY=your_secret_access_key
R2_BUCKET_NAME=gronka-media
R2_PUBLIC_DOMAIN=cdn.example.com
```

you can find your account id in the cloudflare dashboard url or in the r2 overview page.

## how it works

1. a file that fits discord's attachment limit is attached and never touches r2
2. a bigger one is uploaded under a random name (`videos/<32 hex chars>.mp4`), so a link says nothing about the file and cannot be worked out from it
3. nothing is deduplicated or recorded: the same link sent twice is processed twice
4. with `R2_CLEANUP_ENABLED=true`, a cleanup job lists the bucket every `R2_CLEANUP_INTERVAL_MS` and deletes each object once it is older than its size tier allows (the "upload lifetime tiers" webui setting: 72 hours up to 100 MB, then shorter for bigger files). the reply tells the user how long the link lasts
5. the "r2 soft limit" webui setting refuses new uploads while the bucket is over it

objects carry no metadata beyond their content type. a public bucket is readable by anyone who has a link, which is why the names are random.
