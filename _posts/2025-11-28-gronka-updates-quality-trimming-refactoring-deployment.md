---
layout: post
title: "gronka updates: quality controls, trimming, refactoring, and deployment guide"
date: 2025-11-28
description: Comprehensive guide to recent gronka updates including quality parameter for GIF conversion, video and GIF trimming functionality, code refactoring improvements, media format handling, testing strategy, WebUI enhancements, best practices, and Docker deployment deep dive.
author: thedorekaczynski
tags:
  - features
  - release
  - technical
  - quality
  - trimming
  - refactoring
  - architecture
  - testing
  - webui
  - docker
  - deployment
  - best-practices
  - media-formats
  - gif-conversion
  - discord-bot
---

> **update (december 2025)**: some configuration examples in this post reference `GRONKA_DB_PATH`, a sqlite-related environment variable. as of version 0.14.0, sqlite has been removed and gronka now exclusively uses postgresql. replace any `GRONKA_DB_PATH` references with postgresql configuration (`POSTGRES_DB`, `POSTGRES_HOST`, etc.).

# gronka updates: quality controls, trimming, refactoring, and deployment guide

this post covers recent updates to gronka, including new features in versions 0.12.4 and 0.12.5-nightly. we'll dive into quality controls for gif conversion, trimming functionality, code architecture improvements, media format handling, testing strategies, webui enhancements, best practices, and docker deployment.

## introduction

gronka has seen significant improvements in recent releases, focusing on user experience, code quality, and deployment reliability. version 0.12.4 introduced trimming functionality and webui improvements, while 0.12.5-nightly added quality presets and major code refactoring.

this guide covers everything from new features to technical implementation details, helping you understand what's changed and how to make the most of gronka's capabilities.

## quality parameter for `/convert` command

version 0.12.5-nightly introduced a quality parameter to the `/convert` command, giving you control over gif quality and file size.

### quality presets

the quality parameter offers three presets:

- **low** - fastest processing, smaller file sizes, acceptable quality for quick conversions
- **medium** - balanced quality and file size (default)
- **high** - best visual quality, larger files, slower processing

### how quality affects output

quality presets control the dithering algorithm used during gif conversion:

- **low** uses `bayer:bayer_scale=5` - fast bayer dithering optimized for speed
- **medium** uses `sierra2_4a` - balanced sierra dithering for good quality
- **high** uses `floyd_steinberg:diff_mode=rectangle` - slowest but highest quality floyd-steinberg dithering

dithering is the process of simulating colors that aren't in the gif's 256-color palette. higher quality dithering produces smoother gradients and better color transitions, but takes longer to process.

### when to use each preset

- use **low** for quick previews, memes, or when file size is critical
- use **medium** for most conversions (default) - good balance for general use
- use **high** for important content, detailed animations, or when quality matters more than file size

### technical implementation

the quality parameter is integrated into the two-pass gif conversion process:

1. **pass 1**: generates a 256-color palette from the video
2. **pass 2**: applies the palette with the selected dithering algorithm

the dithering algorithm is applied during the second pass using ffmpeg's `paletteuse` filter. the quality preset determines which dithering method is used, affecting both processing time and output quality.

### examples

```bash
# use high quality for important conversions
/convert file:<video> quality:high

# use low quality for quick previews
/convert file:<video> quality:low

# medium is the default, so you can omit it
/convert file:<video>
```

the default quality was changed from high back to medium in 0.12.5-nightly for better balance between file size and quality. you can still override this per-conversion using the quality parameter.

## trimming functionality

version 0.12.4 added trimming support for both videos and gifs, allowing you to extract specific segments before conversion.

### how trimming works

trimming uses `start_time` and `end_time` parameters to specify the segment you want:

- `start_time` - when to start (in seconds)
- `end_time` - when to end (in seconds)

you can provide both parameters, or just one:

- only `start_time`: trims from that point to the end of the video
- only `end_time`: trims from the beginning to that point
- both: trims the specified range

`end_time` must be greater than `start_time` if both are provided.

### video trimming

when trimming videos before conversion, the video is trimmed first, then converted to gif. this is more efficient than converting the entire video and trimming the gif afterward.

the trimming process:

1. validates the time parameters against the video duration
2. uses ffmpeg to extract the specified segment
3. converts the trimmed segment to gif

video trimming uses frame-accurate re-encoding with h.264 codec to ensure accurate trim points, even when they don't align with keyframes.

### gif trimming

gifs can also be trimmed directly, maintaining the gif format without re-conversion. this is useful when you want to shorten an existing gif.

gif trimming:

1. uses ffmpeg to seek to the start time
2. extracts the specified duration
3. maintains gif format and quality settings
4. preserves the infinite loop behavior

### use cases

- extract the best part of a long video
- create short gifs from longer content
- remove unwanted segments from videos or gifs
- create multiple gifs from different parts of the same video

### examples

```bash
# trim video from 10 seconds to 20 seconds, then convert
/convert file:<video> start_time:10 end_time:20

# trim from 30 seconds to the end
/convert file:<video> start_time:30

# trim first 15 seconds
/convert file:<video> end_time:15
```

### technical implementation

trimming is implemented using ffmpeg with different approaches for videos vs gifs:

**video trimming** (`trim-video.js`):
- uses input option `-ss` for fast seeking to start time
- re-encodes with h.264/aac for frame-accurate trimming
- uses `-t` output option for duration control
- ensures valid output files even when trim points don't align with keyframes

**gif trimming** (`trim-gif.js`):
- uses input option `-ss` for seeking
- maintains gif codec (`-c:v gif`)
- preserves gif-specific flags (`-gifflags +transdiff`)
- uses `-t` output option for duration

both implementations validate input files, check for ffmpeg installation, and handle errors gracefully.

## code refactoring: modular architecture

version 0.12.5-nightly included major code refactoring, breaking down large monolithic files into focused, maintainable modules.

### database.js refactoring

the original `database.js` file was 1948 lines, handling all database operations in one place. it's now organized into focused modules:

- `database/connection.js` - database connection state management
- `database/init.js` - database initialization and schema management
- `database/logs.js` - log-related operations (insertLog, getLogs, getLogsCount, etc.)
- `database/users.js` - user-related operations (insertOrUpdateUser, getUser, etc.)
- `database/processed-urls.js` - processed url operations (getProcessedUrl, insertProcessedUrl, etc.)
- `database/operations.js` - operation tracking (insertOperationLog, getOperationLogs, etc.)
- `database/metrics.js` - metrics operations (insertOrUpdateUserMetrics, getUserMetrics, etc.)
- `database/alerts.js` - alert operations (insertAlert, getAlerts, etc.)
- `database/temporary-uploads.js` - temporary upload management

the main `database.js` file is now a barrel export that re-exports all functions from submodules, maintaining backward compatibility. all existing imports continue to work without modification.

### video-processor.js refactoring

the original `video-processor.js` file was 549 lines, handling all video processing operations. it's now organized into focused modules:

- `video-processor/utils.js` - shared utilities (validateNumericParameter, checkFFmpegInstalled)
- `video-processor/convert-to-gif.js` - video to gif conversion
- `video-processor/convert-image-to-gif.js` - image to gif conversion
- `video-processor/trim-video.js` - video trimming functionality
- `video-processor/trim-gif.js` - gif trimming functionality
- `video-processor/metadata.js` - video metadata extraction

like database.js, the main `video-processor.js` file is a barrel export maintaining backward compatibility.

### benefits of modular architecture

- **maintainability** - each module has a single, clear responsibility
- **testability** - easier to test individual modules in isolation
- **code organization** - related functionality is grouped together
- **readability** - smaller files are easier to understand
- **collaboration** - multiple developers can work on different modules without conflicts

### backward compatibility

all refactoring maintained backward compatibility through barrel exports. existing code that imports from `database.js` or `video-processor.js` continues to work without changes. the refactoring is transparent to consumers of these modules.

### impact on development

the modular structure makes it easier to:

- locate specific functionality
- understand code relationships
- add new features without touching unrelated code
- write focused tests for individual modules
- review code changes in pull requests

## how gronka handles different media formats

gronka supports a wide range of input formats and handles them appropriately based on their type.

### supported input formats

**video formats:**
- mp4 (h.264, h.265)
- mov (quicktime)
- webm (vp8, vp9)
- avi (various codecs)
- mkv (matroska)

**image formats:**
- png
- jpg/jpeg
- webp
- gif (can be converted to gif, or trimmed if already a gif)

### conversion paths

gronka handles different conversion scenarios:

1. **video to gif** - uses two-pass palette generation with ffmpeg
2. **image to gif** - converts static images to animated gifs (single frame)
3. **gif to gif** - can optimize, trim, or re-process existing gifs
4. **gif trimming** - trims gifs while maintaining format

### format detection

gronka detects file formats through:

- file extensions
- content-type headers (for attachments)
- magic bytes (file signatures)
- mime type detection

the bot validates file types before processing and rejects unsupported formats with clear error messages.

### processing pipeline

the conversion process follows this pipeline:

1. **validation** - checks file type, size, and format
2. **download** - retrieves file from url or attachment
3. **trimming** (optional) - trims video/gif if time parameters provided
4. **conversion** - converts to gif using appropriate method
5. **optimization** (optional) - applies lossy compression if requested
6. **storage** - stores result in local storage or r2
7. **response** - returns gif link to user

### technical challenges

handling multiple formats presents several challenges:

- **codec compatibility** - different video codecs require different ffmpeg handling
- **color space conversion** - ensuring accurate color representation in gifs
- **frame rate handling** - converting variable frame rate videos to fixed frame rate gifs
- **audio removal** - gifs don't support audio, so it must be stripped
- **palette optimization** - generating optimal 256-color palettes for different content types

gronka handles these challenges through ffmpeg's extensive codec support and careful parameter selection.

### edge cases

special handling for edge cases:

- **very short videos** (< 1 second) - handled gracefully with minimum duration checks
- **very long videos** - duration limits prevent excessive processing time
- **large files** - size limits prevent memory issues
- **corrupted files** - validation catches issues before processing
- **unsupported codecs** - clear error messages guide users

## testing strategy

gronka includes a comprehensive test suite with 130+ tests covering commands, utilities, and integration scenarios.

### test organization

tests are organized by category:

- `test/commands/` - command handler tests
- `test/utils/` - utility function tests
- `test/scripts/` - script tests
- `test/integration/` - integration tests

each category is further organized by functionality, making it easy to find and run specific test suites.

### test coverage

the test suite covers:

- **command handling** - all slash commands and context menu actions
- **video processing** - conversion, trimming, optimization
- **database operations** - all database functions
- **storage operations** - file handling and r2 integration
- **rate limiting** - abuse prevention
- **error handling** - edge cases and error scenarios
- **integration** - end-to-end workflows

### ci/cd integration

tests run automatically in ci/cd pipelines:

- **github actions** - runs on every push and pull request
- **gitlab ci** - runs on merge requests and main branch

both pipelines are structured with multiple stages:

- **setup** - installs dependencies
- **validate** - runs linting and format checks
- **test:utils** - runs utility tests
- **test:commands** - runs command tests
- **test:scripts** - runs script tests
- **test:integration** - runs integration tests

tests run in parallel across separate jobs for faster feedback and better visibility into which areas are failing.

### test execution

run tests locally using:

```bash
# run all tests
npm run test:safe

# run tests in watch mode
npm run test:safe:watch
```

the `test:safe` script ensures proper environment variables are set to prevent tests from writing to production data.

### how tests ensure reliability

the comprehensive test suite:

- catches regressions before they reach production
- validates new features work as expected
- ensures backward compatibility during refactoring
- documents expected behavior through test cases
- provides confidence when making changes

tests must pass before code can be merged, ensuring only working code reaches production.

## webui improvements

version 0.12.4 included significant webui improvements focused on readability, visual hierarchy, and responsive design.

### layout improvements

**max-width constraints:**
- main content areas limited to 1400px width
- prevents edge-to-edge stretching on large screens
- content automatically centered with margins

**content centering:**
- all pages use consistent max-width containers
- content centered on large screens
- better use of screen real estate

### responsive design

**breakpoint handling:**
- mobile: < 480px
- tablet: 768px - 1024px
- desktop: > 1024px

**responsive components:**
- cards adapt to screen size
- tables scroll horizontally on mobile
- navigation collapses on small screens
- touch-friendly button sizes (minimum 44px)

### table improvements

**column sizing:**
- min/max width constraints for better readability
- text overflow handled with ellipsis
- word wrapping for long content
- horizontal scrolling on mobile

**visual hierarchy:**
- consistent spacing between elements
- clear visual separation between sections
- improved readability

### visual hierarchy

**spacing:**
- consistent padding and margins
- better separation between sections
- improved card layouts

**typography:**
- responsive font sizes
- better text contrast
- improved readability

### pages updated

all webui pages received improvements:

- **users** - better table layout and user information display
- **operations** - improved operation tracking and status display
- **logs** - better log filtering and display
- **monitoring** - improved metrics visualization
- **stats** - better statistics presentation
- **health** - clearer health status display

### user experience

the improvements result in:

- easier navigation on all screen sizes
- better readability of data
- more professional appearance
- consistent experience across pages
- faster information scanning

## best practices

here are some tips for getting the best results from gronka.

### choosing quality settings

**for quick previews:**
- use `quality:low` for fast conversions
- acceptable quality for testing or memes

**for general use:**
- use `quality:medium` (default) for most conversions
- good balance of quality and file size

**for important content:**
- use `quality:high` for best visual quality
- worth the extra processing time for final output

### when to use `/convert` vs `/download`

**use `/convert` when:**
- you want to convert media to gif immediately
- you need to trim video before conversion
- you have a direct file url or attachment

**use `/download` when:**
- you want to download from social media platforms
- you need the original file without conversion
- you'll convert later with `/convert`

### quality vs file size trade-offs

**file size considerations:**
- higher quality = larger files
- use `optimize:true` to reduce file size after conversion
- adjust `lossy` parameter (0-100) for fine control
- lower quality presets produce smaller files

**quality considerations:**
- high quality preserves details and smooth gradients
- medium quality is good for most content
- low quality is acceptable for simple content

### common workflows

**quick meme creation:**
```
1. /download url:<social-media-url>
2. /convert file:<downloaded-file> quality:low
```

**high-quality conversion:**
```
1. /convert file:<video> quality:high optimize:true
```

**trimmed conversion:**
```
1. /convert file:<video> start_time:10 end_time:20 quality:medium
```

**optimize existing gif:**
```
1. /optimize file:<gif> lossy:50
```

### performance considerations

**processing time:**
- high quality takes longer than low quality
- trimming adds processing time
- optimization adds a second processing step
- larger files take longer to process

**rate limiting:**
- 30-second cooldown between commands per user
- admins bypass rate limiting
- plan your workflow to avoid waiting

**file size limits:**
- videos: 500mb maximum (configurable)
- images: 50mb maximum
- gif duration: 30 seconds maximum

## docker deployment deep dive

gronka is designed for docker deployment, with comprehensive configuration options and best practices.

### production setup

**docker compose configuration:**

the `docker-compose.yml` file defines multiple services:

- **app** - main gronka bot and server
- **cobalt** - social media downloader service
- **giflossy** - gif optimization service
- **watchtower** - automatic cobalt updates

**environment variables:**

production configuration uses prefixed variables:

```bash
PROD_DISCORD_TOKEN=your_production_token
PROD_CLIENT_ID=your_production_client_id
PROD_GIF_STORAGE_PATH=./data-prod/gifs
```

this allows running test and production bots simultaneously with separate configurations.

### data directory management

**production vs test data:**

- production data: `./data-prod/` directory
- test data: `./data-test/` directory
- complete isolation between environments

**directory structure:**

```
data-prod/
  ├── gronka.db          # production database
  └── gifs/              # production gif storage

data-test/
  ├── gronka-test.db     # test database
  └── gifs/              # test gif storage
```

this separation prevents test users from polluting production data and allows safe testing.

### container architecture

**app container:**
- runs bot and server together
- exposes ports 3000 (api) and 3001 (webui)
- mounts data directories as volumes
- health check endpoint for monitoring

**cobalt container:**
- self-hosted social media downloader
- automatically updated by watchtower
- optional cookie authentication for restricted content
- read-only filesystem for security

**giflossy container:**
- used for gif optimization via docker exec
- shares data directories with app container
- network access for optimization requests

**watchtower container:**
- monitors and updates cobalt image
- runs every 15 minutes (900 seconds)
- automatic cleanup of old images

### environment variable handling

**local vs docker deployment:**

environment variables work differently in local vs docker:

- **local**: uses `.env` file or environment variables directly
- **docker**: uses `docker-compose.yml` environment section
- **prefixed variables**: allow separate test/prod configurations

**important variables:**

```bash
# discord configuration
DISCORD_TOKEN / PROD_DISCORD_TOKEN
CLIENT_ID / PROD_CLIENT_ID

# storage configuration
GIF_STORAGE_PATH / PROD_GIF_STORAGE_PATH

# r2 storage (optional)
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET_NAME
R2_PUBLIC_DOMAIN

# cobalt integration
COBALT_API_URL
COBALT_ENABLED
COOKIE_PATH

# webui configuration
WEBUI_PORT
STATS_USERNAME
STATS_PASSWORD
```

### troubleshooting common issues

**container won't start:**
- check environment variables are set
- verify docker has enough resources
- check logs: `docker compose logs app`

**database errors:**
- ensure data directories exist and are writable
- check file permissions on mounted volumes
- verify database path is correct

**cobalt connection issues:**
- verify cobalt container is running: `docker compose ps`
- check network connectivity: `docker compose exec app ping cobalt`
- verify `COBALT_API_URL` matches container name

**storage issues:**
- check mounted volume permissions
- verify storage path is correct
- ensure directories exist before starting

**webui not accessible:**
- verify port 3001 is exposed and not blocked
- check `WEBUI_PORT` environment variable
- verify webui is enabled in configuration

### best practices for deployment

**security:**
- use strong passwords for webui authentication
- keep environment variables secure (don't commit to git)
- regularly update docker images
- use read-only filesystems where possible

**monitoring:**
- set up health check monitoring
- monitor container resource usage
- track error rates and response times
- log important events

**backups:**
- regularly backup `data-prod/` directory
- backup database file separately
- test restore procedures
- keep multiple backup copies

**updates:**
- test updates in test environment first
- use version tags for docker images
- monitor for breaking changes
- read changelog before updating

**resource management:**
- monitor disk space usage
- clean up old files regularly
- set appropriate file size limits
- monitor memory and cpu usage

**networking:**
- use docker networks for service communication
- expose only necessary ports
- use reverse proxy for webui if needed
- configure firewall rules appropriately

## conclusion

recent gronka updates have focused on improving user experience, code quality, and deployment reliability. the new quality parameter gives you control over gif output, trimming functionality makes it easier to extract the perfect segment, and code refactoring improves maintainability.

the comprehensive test suite ensures reliability, webui improvements enhance usability, and docker deployment makes it easy to run gronka in production.

### what's next

gronka continues to evolve with regular updates and improvements. upcoming features may include:

- additional quality options
- more trimming controls
- performance optimizations
- new media format support
- enhanced webui features

### resources

- [github repository](https://github.com/gronkanium/gronka)
- [documentation](https://github.com/gronkanium/gronka/wiki)
- [changelog](https://github.com/gronkanium/gronka/blob/main/CHANGELOG.md)
- [docker deployment guide](https://github.com/gronkanium/gronka/wiki/Docker-Deployment)
- [configuration guide](https://github.com/gronkanium/gronka/wiki/Configuration)

stay updated by following the repository and checking the changelog for new releases.

