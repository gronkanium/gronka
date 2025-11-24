# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres (attempts) to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.4-prerelease] - 2025-11-24

### Added

- Discord attachment support for files under 8MB
  - Files smaller than 8MB are now sent as Discord attachments instead of URLs
  - Provides better user experience with direct file previews in Discord
  - Automatic detection based on file size using `shouldUploadToDiscord()` helper
  - All commands (download, convert, optimize) support Discord attachments
  - Enhanced storage functions return buffer and upload method information
- Stuck operations cleanup system
  - Automatic cleanup runs every 5 minutes to detect and resolve stuck operations
  - Configurable timeout (default 10 minutes) for stuck operation detection
  - Users receive DM notifications when their stuck operations are cleaned up
  - New `cleanupStuckOperations()` function in operations-tracker.js
  - Manual cleanup script: `fix-stuck-operations.js` (accessible via `npm run fix:stuck-ops`)
  - Enhanced database functions: `getStuckOperations()`, `markOperationAsFailed()`
- Fast Docker reload scripts
  - Cross-platform fast reload for development (JS wrapper, PowerShell, Bash)
  - New npm script: `docker:reload:fast` for faster iteration cycles
  - Platform detection and appropriate script execution
- Dockerfile cache strategy documentation
  - Added comments throughout Dockerfile explaining cache invalidation points
  - Documents which layers are cached and when they invalidate
  - Helps with build optimization understanding
- Log metrics test suite
  - Comprehensive tests for `getLogMetrics()` function
  - Tests component filtering, level aggregation, and edge cases

### Changed

- Storage function return format
  - `saveGif()`, `saveVideo()`, and `saveImage()` now return `{ url, buffer, method }` object
  - `url`: File URL or local path
  - `buffer`: File buffer for Discord attachments
  - `method`: 'discord' or 'r2' based on file size
  - **BREAKING**: Code using these functions must be updated to use `.url` property
- Rate limiting improvements
  - Localhost (IPv4 and IPv6) now bypasses rate limiting for development
  - Health check endpoint (`/health`) excluded from rate limiting
  - Rate limiter middleware moved after `/health` route
  - Improved skip logic for internal network requests
- Deferred download notifications
  - Updated to support Discord attachments via `AttachmentBuilder`
  - Can now send files as attachments or URLs based on size

### Fixed

- Test suite updates for new storage return format
  - Updated `storage.test.js` to use `.url` property from storage function returns
  - Fixed `database.test.js` metadata parsing (getLogs already parses JSON)

## [0.11.3-prerelease] - 2025-11-24

### Added

- Docker webui rebuild scripts
  - Added `docker:rebuild-webui` npm script
  - Cross-platform scripts (JS wrapper, bash, PowerShell) for rebuilding webui in Docker containers
  - Installs devDependencies and builds webui inside container
- Operation duration tracking in notifications
  - Automatic duration calculation and display in ntfy notifications
  - Duration formatting (ms, seconds, minutes, hours)
  - Duration display in Alerts.svelte metadata
- Stats caching improvements
  - Added 30-second cache for stats API endpoint in webui-server.js
  - Added localStorage caching (5min TTL) for error metrics and storage stats in Monitoring.svelte
  - Reduces load on main server and improves dashboard responsiveness
- User operations pagination
  - Added pagination support for user operations in UserProfile.svelte
  - Offset and limit parameters for efficient data loading
  - Real-time WebSocket updates refresh current page
- getOperation() function in operations-tracker.js for retrieving operations by ID

### Changed

- Social media URL cache behavior
  - Skip cache for social media URLs if cached result is not a GIF
  - Allows social media URLs to be processed fresh through Cobalt for conversion
  - Improves conversion quality for social media content
- Storage stats calculation improvements
  - Added mutex to prevent concurrent filesystem scans for the same storage path
  - Added 30-second timeout protection for stats calculations
  - Enhanced error handling with safe default values
  - Improved input validation for storage paths
- File size formatting improvements
  - Added comprehensive input validation (null, undefined, NaN, negative numbers)
  - Better error handling and logging for edge cases
  - Returns safe defaults instead of throwing errors
- Storage path validation
  - Enhanced getStoragePath() with input validation and error handling
  - Better error messages and logging
- Database query improvements
  - Added excludeComponentLevels parameter for filtering specific component+level combinations
  - Allows fine-grained log filtering (e.g., exclude webui INFO logs but keep ERROR/WARN)
- Operation trace improvements
  - Update 'created' step status to 'success' when execution steps exist
  - Better status tracking for operation lifecycle
- Stats endpoint improvements
  - Enhanced validation and error handling
  - Better error messages and logging
  - Safe default values on errors
- Rate limiting adjustments
  - Increased stats endpoint rate limit from 10 to 60 requests per 15min
  - Supports dashboard polling at 30s intervals
- Stats API endpoint path
  - Fixed webui-server.js to use `/api/stats` instead of `/stats`
  - Matches main server API structure
- WebUI logs filtering
  - Exclude webui INFO logs from logs list to reduce noise
  - Keep ERROR/WARN logs from webui visible for monitoring
- Error metrics endpoint
  - Don't exclude webui from error/warning counts
  - Only exclude webui INFO logs from totals/aggregations
- User operations endpoint
  - Improved database querying to fetch all operations for accurate counting
  - Better pagination support with offset and limit

### Fixed

- Stats endpoint validation and error handling
- Storage path validation edge cases
- File size formatting edge cases (null, undefined, NaN, negative numbers)
- Concurrent stats calculation race conditions
- Stats API endpoint path mismatch between webui-server and main server
- Rate limiting too strict for dashboard polling

## [0.11.2] - 2025-11-24

### Security

- Fixed insecure temporary file creation in test files
  - Replaced `os.tmpdir()` with `tmp` library for secure temporary file handling
  - Resolves CodeQL alerts #61, #60, #59 (CWE-377, CWE-378)

### Added

- Comprehensive test suite with 130 new tests
  - Logger sanitization tests (17 tests)
  - Serve-site security tests (22 tests)
  - WebUI rate limit tests (12 tests)
  - Video-processor validation tests (29 tests)
  - Docker-verify wrapper tests (12 tests)
  - Docker-copy-webui wrapper tests (12 tests)
  - Fetch-code-scanning-issues tests (22 tests)
  - Enhanced existing logger tests with sanitization (4 new tests)
- Command source tracking in operations
  - Track whether commands come from slash commands or context menus
  - Display command source in WebUI user profiles
- User metrics broadcast callback support in operations-tracker.js

### Changed

- Improved code formatting in bot.js, convert.js, download.js, database.js, optimize.js, modals.js, and webui-server.js
- Updated index.html formatting
- Enhanced operation context tracking with commandSource metadata
- Added rule to use `tmp` library for all temporary file operations

### Fixed

- Logger test: sanitization only removes control characters, not text content
- Test failures: simplified fetch-code-scanning-issues tests and fixed Linux path handling
- Stop tracking code-scanning-issues.json in git (now properly ignored)

## [0.11.1-prerelease] - 2025-11-24

### Security

- Fixed additional CodeQL security vulnerabilities

## [0.11.0-prerelease] - 2025-11-24

### Security

- Resolved all 17 CodeQL security vulnerabilities
  - Fixed log injection vulnerability by sanitizing user input in logger
  - Fixed file system race conditions in optimize command
  - Fixed insecure temporary file creation in test files using tmp package
  - Fixed HTTP-to-file access vulnerabilities in optimize.js and convert.js with path validation
  - Fixed command injection in gif-optimizer.js by using spawn instead of exec
  - Fixed 8 path injection issues in serve-site.js with path validation
  - Fixed reflected XSS in serve-site.js with HTML escaping
  - Fixed type confusion through parameter tampering
  - Added rate limiting to webui-server.js file-serving routes
  - Fixed incomplete sanitization in docker-security.test.js
- Enhanced security measures
  - Added file buffer validation with magic byte checking for gif/video files
  - Improved error handling to show specific messages to users
  - Standardized all user-facing messages to lowercase monotone style
  - Documented file size limits in command descriptions and readme

### Added

- GitHub security features
  - Added GitHub Dependabot for automated dependency updates
  - Added CodeQL security scanning workflow
  - Added dependency review workflow
  - Added fetch-code-scanning-issues.js script to fetch security alerts
- Documentation
  - Added TODO.md for tracking tasks (github templates, wiki, documentation, logs toolbar fix)

### Changed

- WebUI improvements
  - Redesigned user profile page for compact layout
    - Consolidated header, stats, and command breakdown into single section
    - Hide empty sections instead of showing large empty state blocks
    - Convert operations from cards to compact table format
    - Limit activity timeline to 10 most recent entries in compact table
    - Reduced all spacing: container gaps (2rem->1rem), padding (1.5rem->1rem), stat values (2rem->1.5rem)
    - Made media table more compact with reduced padding and font sizes
    - Improved space efficiency throughout the profile page
  - Updated to Svelte 5 with mount() API for component mounting
  - Updated command handlers, database utilities, and webui components
- DevOps
  - Optimized CI/CD workflows: skip CodeQL for dependabot, add path filters, add concurrency controls
  - Removed prettier check from github ci workflow
  - Restored escapeShellArg function in gif-optimizer.js for test compatibility
  - Added FFmpeg installation to CI workflow for both test jobs

### Dependencies

- Major dependency updates (11 packages)
  - @aws-sdk/client-s3: 3.936.0 → 3.937.0
  - @aws-sdk/lib-storage: 3.936.0 → 3.937.0
  - discord.js: 14.24.2 → 14.25.1
  - dotenv: 16.6.1 → 17.2.3 (major)
  - express: 4.21.2 → 5.1.0 (major)
  - express-rate-limit: 7.5.1 → 8.2.1 (major)
  - marked: 17.0.0 → 17.0.1
  - @sveltejs/vite-plugin-svelte: 3.1.2 → 6.2.1 (major)
  - concurrently: 8.2.2 → 9.2.1 (major)
  - svelte: 4.2.20 → 5.43.14 (major)
  - vite: 5.4.21 → 7.2.4 (major)

### Fixed

- Fixed code style issues in serve-site.js
- Fixed formatting for CI
- Fixed linting errors: add caughtErrorsIgnorePattern to eslint config, remove unused imports

### Removed

- Removed aspirations.md

## [0.10.0] - 2025-11-23

### Security

- Added comprehensive Docker security tests for vulnerability detection
  - Added 22 new security tests covering resource limits, capabilities, namespace isolation
  - Tests for path traversal, container escape prevention, docker API security
  - Added health check security, network security, and filesystem security tests
- Fixed Docker security test false positives for CI workspace paths
  - Only flag direct mounts of sensitive root directories (depth <= 1)
  - Skip checks for known CI workspace paths (/home/runner/work/, /builds/, etc.)
  - Prevents false positives when ./data resolves to CI workspace paths

### Added

- Windows PowerShell support for docker scripts
  - Created PowerShell versions of docker-up, docker-reload, and docker-restart scripts
  - Added cross-platform Node.js wrappers that detect OS and run appropriate script
  - Updated package.json to use wrappers instead of direct bash calls
  - Fixed profile argument handling in PowerShell (using array splatting)
  - Updated message text from 'may take a while' to 'will take a while'
  - Scripts now show docker compose output for better visibility
- CI/CD tests for GitHub

### Fixed

- Fixed pre-commit hook for SSH/WSL environment
- Fixed version tagging logic: only mark versions with hyphen as prerelease, not 0.x versions

### Changed

- Updated GitHub repository references from p2xai to thedorekaczynski
- Removed inspiration section from README

## [0.9.0] - 2025-11-22

### Added

- Initial tracked release
- Core Discord bot functionality
  - `/download` command for downloading media from social media platforms
  - `/convert` command for converting videos and images to GIFs
  - `/optimize` command for optimizing existing GIFs
  - `/stats` command for viewing storage statistics
  - Context menu commands: "convert to gif", "download", "optimize"
  - Support for multiple media formats (mp4, mov, webm, avi, mkv, png, jpg, jpeg, webp, gif)
- WebUI dashboard
  - Statistics and monitoring interface
  - User profiles and activity tracking
  - Operations tracking
  - Logs viewer
  - Health monitoring
  - Alerts system
- Docker support
  - Docker Compose configuration
  - Multi-service setup (app, cobalt, webui)
  - Health checks and restart policies
- R2 storage integration
  - Cloudflare R2 support for storing and serving media files
  - Automatic upload to R2 when configured
  - Fallback to local filesystem storage
  - Public domain serving via R2
- Cobalt integration
  - Self-hosted API for downloading media from social platforms
  - Support for Twitter/X, TikTok, Instagram, YouTube, Reddit, Facebook, Threads
  - Automatic media detection and download
- Local server
  - Health check endpoint
  - Stats API endpoint
  - Static HTML pages (terms, privacy)
- Database utilities
  - SQLite database for tracking operations, users, and metrics
  - Log storage and retrieval
  - User metrics tracking
- File size limits
  - GIF optimization: maximum 50mb
  - Video conversion: maximum 100mb
  - Image conversion: maximum 50mb
  - Video download: maximum 500mb
  - Image download: maximum 50mb
  - Admin bypass for downloads
- Rate limiting
  - Express rate limiting for file-serving routes
  - Admin user bypass support
- Development tools
  - ESLint and Prettier configuration
  - Husky git hooks
  - Pre-commit validation
  - Docker buildx setup for cache support

[0.11.3-prerelease]: https://github.com/thedorekaczynski/gronka/compare/v0.11.2...v0.11.3-prerelease
[0.11.2]: https://github.com/thedorekaczynski/gronka/compare/v0.11.1-prerelease...v0.11.2
[0.11.1-prerelease]: https://github.com/thedorekaczynski/gronka/compare/v0.11.0-prerelease...v0.11.1-prerelease
[0.11.0-prerelease]: https://github.com/thedorekaczynski/gronka/compare/v0.10.0...v0.11.0-prerelease
[0.10.0]: https://github.com/thedorekaczynski/gronka/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/thedorekaczynski/gronka/releases/tag/v0.9.0
