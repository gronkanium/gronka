gronka can run entirely for free. every piece of the stack is either open source, self-hosted, or has a free tier that comfortably covers a personal bot. this page lays out the zero-cost path from nothing to a working bot in your server.

## the cost breakdown

| component                    | what it costs                                                            |
| ---------------------------- | ------------------------------------------------------------------------ |
| discord bot account          | free — create one in the developer portal                                |
| the bot itself               | free — open source, runs via docker compose                              |
| cobalt + yt-dlp + ffmpeg     | free — self-hosted inside the same compose stack, no api keys            |
| postgresql                   | free — runs as a container in the same stack                             |
| hosting                      | free if you use your own hardware or a free-tier vps                     |
| storage / cdn                | free — skip it entirely (files upload to discord) or use r2's free tier  |

no component requires a paid subscription, api key, or domain name.

## what you need

- a machine that can run docker and stay on — a spare pc, home server, raspberry pi, or a vps
- a discord account
- optionally, a cloudflare account (free) if you want r2 storage

## step 1: pick where to run it

the bot needs docker, roughly 2 gb of ram (the stack runs four containers: bot, postgres, cobalt, watchtower), and a few gb of disk. it makes only outbound connections to discord, so you do **not** need a public ip, port forwarding, or a domain — it runs fine behind any home nat.

### option a: your own hardware

any always-on machine works: a spare pc, an old laptop, a home server, or a raspberry pi 4/5 (4 gb+ recommended). install docker, and you're done paying for hosting. the only real requirement is that the machine stays on — the bot is offline whenever the machine is.

### option b: a free-tier vps

several cloud providers offer always-free tiers that can run the stack, e.g. oracle cloud's always free tier (arm-based vms with generous ram). free tiers change over time, so check current terms before committing. two caveats:

- free vps offerings are usually arm64. all images in the compose stack (node, postgres, cobalt) publish arm64 builds, so this should work, but it's less battle-tested than x86.
- some platforms (youtube especially) are more aggressive about blocking downloads from datacenter ip ranges than from residential ones. a home connection often has *better* download success than a vps.

### option c: a cheap paid vps

not free, but for completeness: any ~$5/month vps with 2 gb ram runs the stack fine if you don't want hardware at home and free tiers don't work out.

## step 2: create the discord bot (free)

creating a discord application, bot user, and invite link costs nothing — follow the discord application setup section in the [[Installation|installation guide]]. you come out of it with the two values gronka requires: `DISCORD_TOKEN` and `CLIENT_ID`.

## step 3: choose storage

### option a: no storage config at all

if you set no r2 variables, gronka uploads results directly to discord as attachments and caches files on local disk. this is completely free and needs zero setup. the tradeoff is discord's per-file upload limit (10 mb on unboosted servers, higher with server boosts) — large videos or high-quality gifs may not fit.

### option b: cloudflare r2 free tier

r2's free tier includes 10 gb of storage, 1 million class a operations (writes) and 10 million class b operations (reads) per month, and — unlike s3 — **zero egress fees**, so serving files to discord users costs nothing regardless of traffic. a personal bot stays far below these limits.

you don't need to buy a domain either: every bucket can get a free `*.r2.dev` public subdomain. use that as your `R2_PUBLIC_DOMAIN`.

follow the [[R2-Storage|r2 storage guide]] to create the bucket and api token, then set:

```env
R2_ACCOUNT_ID=your_cloudflare_account_id
R2_ACCESS_KEY_ID=your_access_key_id
R2_SECRET_ACCESS_KEY=your_secret_access_key
R2_BUCKET_NAME=gronka-media
R2_PUBLIC_DOMAIN=https://pub-xxxxxxxx.r2.dev
```

to make sure you never grow past the free 10 gb, enable temporary uploads so old files clean themselves up:

```env
R2_TEMP_UPLOADS_ENABLED=true
R2_CLEANUP_ENABLED=true
R2_TEMP_UPLOAD_TTL_HOURS=72
```

deduplication is built in (files are stored by content hash), so repeated downloads of the same media don't consume extra space.

## step 4: run it

on the machine you picked:

```bash
# 1. clone
git clone https://github.com/thedorekaczynski/gronka.git
cd gronka

# 2. configure
cp .env.example .env
# edit .env: set PROD_DISCORD_TOKEN and PROD_CLIENT_ID (plus r2 vars if using option b)

# 3. start the stack
docker compose up -d

# 4. register slash commands (one-time)
docker compose run --rm app bun run register-commands
```

invite the bot to your server with the invite url from step 2, and `/download`, `/convert`, and `/optimize` are live. see [[Quick-Start]] and [[Docker-Deployment]] for more detail on running and updating the stack.

## staying at $0

- **r2**: keep temporary uploads + cleanup enabled and the bucket stays bounded; check the r2 dashboard occasionally if your bot serves a busy server. the free tier is per-account, so an existing cloudflare account's usage counts too.
- **stats spam**: r2 class a operations are consumed by writes and lists — the defaults are fine, but if you tweak things, keep `STATS_CACHE_TTL` at its default rather than disabling it.
- **free vps terms**: always-free tiers occasionally reclaim idle machines or change terms; keep your `.env` backed up somewhere safe so you can redeploy anywhere with `git clone` + `docker compose up` in minutes. everything stateful worth keeping is either in the postgres volume or reproducible.

## troubleshooting

if something doesn't come up, `docker compose logs app --tail 50` is the first stop; see [[Troubleshooting]] for common issues.
