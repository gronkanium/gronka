---
title: technical specification
topic: guides
chapter: 1
description: complete technical documentation for gronka
---

## project overview

discord bot that converts video attachments to gif format via right-click context menu. stores them on a server and returns a cdn url. videos are processed using ffmpeg, deduplicated via md5 hashing, and served through cloudflare r2. also supports optimizing existing gifs to reduce file size using configurable lossy compression.

---

## tech stack

### core technologies

- runtime: node.js v18+ (lts)
- package manager: npm or pnpm
- primary language: javascript (es6+) or typescript

### dependencies

```json
{
  "discord.js": "^14.14.1",
  "axios": "^1.6.0",
  "fluent-ffmpeg": "^2.1.2",
  "express": "^4.18.2",
  "dotenv": "^16.3.1",
  "crypto": "built-in"
}
```

### system dependencies

- ffmpeg: video processing and gif conversion

### infrastructure

- discord bot: context menu commands + message content intent
- web server: express.js serving static files
- cdn: cloudflare r2 (optional, configurable public domain)
- storage: cloudflare r2 or local filesystem for gif files
- cobalt.tools: optional api service for downloading videos from social media platforms (powers `/download` command)

---

## component specifications

### 1. discord bot (bot.js)

purpose: listen for context menu interactions, process videos, coordinate conversion

key functions:

- `handleContextMenuCommand(interaction)` - main entry point for right-click commands
- `downloadVideo(url)` - download video from discord cdn
- `generateHash(buffer)` - create md5 hash for deduplication
- `checkGifExists(hash)` - verify if gif already exists
- `respondToUser(interaction, url)` - send cdn url back to discord

discord intents required:

```javascript
GatewayIntentBits.Guilds;
GatewayIntentBits.GuildMessages;
GatewayIntentBits.MessageContent;
```

context menu command structure:

```javascript
{
  name: "Convert to GIF",
  type: ApplicationCommandType.Message,
  defaultMemberPermissions: null
}
```

flow:

1. user right-clicks message containing video
2. bot receives `InteractionCreate` event
3. extract video attachment from `targetMessage`
4. defer reply (conversion takes time)
5. download video to temp location
6. generate md5 hash of video bytes
7. check if `/data/gifs/{hash}.gif` exists
8. if exists: return existing url
9. if not: convert video → gif, save, return new url
10. clean up temp files

---

### 2. video processor (video-processor.js)

purpose: convert video files to optimized gif format using ffmpeg

key function signature:

```javascript
async function convertToGif(inputPath, outputPath, options = {})
```

default options:

```javascript
{
  width: 480,
  fps: 15,
  startTime: null,
  duration: null,
  quality: 'medium'
}
```

ffmpeg command structure:

```bash
ffmpeg -i input.mp4 \
  -vf "fps=15,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" \
  -loop 0 \
  output.gif
```

filter explanation:

- `fps=15` - reduce to 15 fps
- `scale=480:-1` - width 480px, maintain aspect ratio
- `flags=lanczos` - high-quality scaling algorithm
- `palettegen` - generate optimal 256-color palette
- `paletteuse` - apply palette for best quality
- `-loop 0` - infinite loop

optimization strategies:

- use two-pass palette generation for better color accuracy
- limit resolution to reduce file size
- lower fps for smaller files (10-20 fps is ideal)
- consider dithering for smoother gradients

error handling:

- validate input file exists
- check ffmpeg is installed (`which ffmpeg`)
- handle corrupt video files
- set timeout (max 2 minutes for long videos)

---

### 2.5. gif optimizer (gif-optimizer.js)

purpose: optimize existing gif files to reduce file size using lossy compression

key function signature:

```javascript
async function optimizeGif(inputPath, outputPath, options = {})
```

options:

```javascript
{
  lossy: 35,
  optimize: 3
}
```

lossy compression levels:

- 0-30: minimal compression, highest quality, larger files
- 30-60: balanced compression and quality (default: 35)
- 60-100: maximum compression, lower quality, smaller files

optimization levels:

- 1: fast optimization, basic compression
- 2: medium optimization, better compression
- 3: maximum optimization, best compression (slower)

implementation:

uses `giflossy` docker container (dylanninin/giflossy) which wraps `gifsicle` for gif optimization:

```bash
gifsicle --optimize=3 --lossy=80 input.gif -o output.gif
```

usage:

- slash command: `/optimize file:<attachment> lossy:<0-100>`
- context menu: right-click message → "optimize" → modal appears for lossy level
- url support: can optimize gifs from urls, with special handling for cdn.p1x.dev links (uses local file if available)

deduplication:

optimized gifs are hashed using original file + lossy level, ensuring different lossy levels produce different cached files.

error handling:

- validate input file exists and is a gif
- check docker is available
- validate lossy level range (0-100)
- handle optimization timeouts (5 minute max)
- verify output file was created

---

### 3. storage manager (storage.js)

purpose: handle file system operations for gif storage

key functions:

```javascript
async function saveGif(buffer, hash)
async function gifExists(hash)
async function getGifPath(hash)
async function cleanupTempFiles()
```

storage strategy:

- filename format: `{md5hash}.gif`
- location: `/var/www/gifs/` or configurable via env
- no subdirectories (flat structure for simplicity)
- optional: add date-based subdirs for large scale (`/2024/11/abc123.gif`)

deduplication logic:

```javascript
const hash = crypto.createHash('md5').update(videoBuffer).digest('hex');
const gifPath = `/data/gifs/${hash}.gif`;

if (
  await fs
    .access(gifPath)
    .then(() => true)
    .catch(() => false)
) {
  return { exists: true, url: `${CDN_BASE_URL}/${hash}.gif` };
}
```

disk space management (optional enhancement):

- log file sizes to database/json
- implement lru cache eviction
- set max storage limit (e.g., 50gb)
- delete least accessed gifs when limit reached

---

### 4. cdn server (deprecated as of v0.13.0)

note: the standalone cdn server (`server.js`) has been removed. files are now served directly from r2 or discord, and the bot includes a minimal stats http server for jekyll integration.

express configuration:

```javascript
const express = require('express');
const app = express();

app.use(
  '/gifs',
  express.static('/var/www/gifs', {
    maxAge: '7d',
    etag: true,
    lastModified: true,
    immutable: true,
    setHeaders: (res, path) => {
      res.set('Cache-Control', 'public, max-age=604800, immutable');
      res.set('Access-Control-Allow-Origin', '*');
    },
  })
);

app.listen(3000, '127.0.0.1');
```

performance optimizations:

- use `compression` middleware for smaller transfers
- enable http/2 in production
- consider nginx as reverse proxy for better performance
- add rate limiting to prevent abuse

monitoring endpoints:

```javascript
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/stats', (req, res) => {
  // return total gifs, disk usage, etc.
});
```

---

## api endpoints

### discord context menu command

```javascript
// user-facing (right-click menu)
Command Name: "Convert to GIF"
Type: MESSAGE
Scope: Guild + DM

// response format
{
  type: "MESSAGE",
  content: "gif created: https://cdn.site.com/gifs/abc123.gif"
}
```

### cdn endpoints

```
GET /gifs/{hash}.gif
  → returns gif file
  → headers: cache-control, etag, content-type: image/gif

GET /health
  → returns { "status": "ok", "uptime": 12345 }

GET /stats (optional)
  → returns { "total_gifs": 42, "disk_usage_formatted": "1536.00 MB" }
```

---

## error handling strategy

### 1. discord bot errors

```javascript
try {
  await convertVideo();
} catch (error) {
  console.error('[BOT ERROR]', error);
  await interaction.editReply({
    content: 'failed to convert video. please try again.',
    ephemeral: true,
  });
}
```

common errors:

- video too large (discord limit: 25mb free, 500mb nitro)
- unsupported video format
- ffmpeg timeout (video too long)
- disk space full
- network errors during download

### 2. ffmpeg errors

```javascript
ffmpeg(input)
  .on('error', (err, stdout, stderr) => {
    console.error('FFmpeg failed:', stderr);
    throw new Error('Video conversion failed');
  })
  .on('timeout', () => {
    throw new Error('Conversion took too long');
  });
```

### 3. storage errors

- check disk space before saving
- handle permission errors (`EACCES`)
- validate file write success
- implement retry logic for transient failures

---

## performance considerations

### video processing

- concurrency: process multiple videos in parallel (use queue)
- memory: large videos can exceed node.js heap → use streams
- cpu: ffmpeg is cpu-intensive → consider worker threads
- time: average conversion: 5-15 seconds for 10s video

### optimization strategies

```javascript
// use ffmpeg presets for speed
.outputOptions(['-preset', 'fast'])

// limit queue size
const queue = new PQueue({ concurrency: 3 });

// timeout long conversions
setTimeout(() => ffmpegProcess.kill(), 120000);
```

### caching

- gifs are immutable (hash-based filenames)
- cloudflare r2 provides edge caching when configured
- browser caching: 7 days via `Cache-Control`
- deduplication prevents redundant conversions

### scaling considerations

| users  | strategy                                     |
| ------ | -------------------------------------------- |
| 1-100  | single server, local storage                 |
| 100-1k | add worker processes, redis queue            |
| 1k-10k | object storage (s3), cdn, load balancer      |
| 10k+   | microservices, kubernetes, distributed queue |

---

## security considerations

### input validation

```javascript
// validate video size
if (attachment.size > 500 * 1024 * 1024) {
  throw new Error('Video too large');
}

// validate content type
const allowedTypes = ['video/mp4', 'video/quicktime', 'video/webm'];
if (!allowedTypes.includes(attachment.contentType)) {
  throw new Error('Unsupported format');
}
```

### rate limiting

```javascript
const rateLimit = new Map();

function checkRateLimit(userId) {
  const lastUse = rateLimit.get(userId);
  if (lastUse && Date.now() - lastUse < 30000) {
    throw new Error('Please wait before converting another video');
  }
  rateLimit.set(userId, Date.now());
}
```

### file system security

- run bot as non-root user
- set restrictive permissions on gif directory (755)
- validate filenames (prevent path traversal)
- limit disk usage per user (optional)

### token security

- store tokens in environment variables
- never log tokens
- rotate tokens periodically
- use least-privilege bot permissions
