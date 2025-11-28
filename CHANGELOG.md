# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres (attempts) to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Refactored database.js into modular structure
  - Broke down monolithic `src/utils/database.js` (1948 lines) into focused modules organized in `src/utils/database/` subdirectory
  - Created separate modules for different database concerns:
    - `database/connection.js` - Database connection state management and shared utilities
    - `database/init.js` - Database initialization and schema management
    - `database/logs.js` - Log-related operations (insertLog, getLogs, getLogsCount, getLogComponents, getLogMetrics)
    - `database/users.js` - User-related operations (insertOrUpdateUser, getUser, getUniqueUserCount)
    - `database/processed-urls.js` - Processed URL operations (getProcessedUrl, insertProcessedUrl, getUserMedia, getUserR2Media, deleteProcessedUrl, deleteUserR2Media)
    - `database/operations.js` - Operation tracking (insertOperationLog, getOperationLogs, getOperationTrace, getRecentOperations, getStuckOperations, markOperationAsFailed)
    - `database/metrics.js` - Metrics operations (insertOrUpdateUserMetrics, getUserMetrics, getAllUsersMetrics, insertSystemMetrics, getSystemMetrics)
    - `database/alerts.js` - Alert operations (insertAlert, getAlerts, getAlertsCount)
  - Maintained backward compatibility by keeping main `src/utils/database.js` as a barrel export that re-exports all functions from submodules
  - All existing imports continue to work without modification
  - Improved code organization, maintainability, and testability
  - No breaking changes - function signatures remain identical

## [0.12.5] - 2025-11-27

### Added

- Quality parameter to `/convert` command
  - Added `quality` option to `/convert` command with choices: low, medium, high
  - Allows users to specify GIF quality preset per conversion
  - Defaults to medium quality when not specified

### Changed

- Default GIF quality changed from high back to medium
  - Quality default reverted to medium for better balance between file size and quality
  - Applies to all conversions when quality parameter is not specified
  - Configurable via `GIF_QUALITY` environment variable

### Fixed

- Code scanning issues
  - Fixed code scanning alerts and warnings
- Code cleanup
  - Removed unused imports in race-conditions test

## [0.12.4] - 2025-11-27

### Added

- GIF and video trimming functionality
  - Added `start_time` and `end_time` parameters to `/convert` and `/download` commands
  - Support for trimming GIFs and videos before processing
  - Comprehensive test coverage for trimming functionality
- Video trimming support for `/convert` command

### Changed

- CI/CD pipeline improvements
  - Restructured GitLab CI with multiple descriptive stages (setup, validate, test:utils, test:commands, test:scripts, test:integration)
  - Restructured GitHub Actions to match GitLab CI structure with segmented test execution
  - Tests now run in parallel across separate jobs for better visibility and faster feedback
  - Improved test organization and categorization
- Docker production configuration now explicitly uses data-prod directories
  - Updated docker-compose.yml to set `GRONKA_DB_PATH` using `PROD_GRONKA_DB_PATH` environment variable (defaults to `./data-prod/gronka.db`)
  - Updated docker-compose.yml to set `GIF_STORAGE_PATH` using `PROD_GIF_STORAGE_PATH` environment variable (defaults to `./data-prod/gifs`)
  - Production Docker containers now write to `data-prod` directory instead of deprecated `data` directory
  - Ensures production data is isolated from test data and prevents test users from polluting production database
- Simplified docker-up script
  - Removed container status verification loop from docker-up.ps1
  - Script now starts containers and exits immediately without verification delays
  - Faster startup experience for development
- WebUI layout improvements for better readability and visual hierarchy
  - Added max-width constraints (1400px) to main content areas to prevent edge-to-edge stretching
  - Centered content on large screens with automatic margins
  - Improved table column sizing with min/max width constraints for better readability
  - Enhanced responsive design with better breakpoint handling
  - Optimized card and section layouts across all pages (Users, Operations, Logs, Monitoring, Stats, Health)
  - Better text overflow handling with ellipsis and word wrapping
  - Improved spacing and visual hierarchy throughout the interface
- Code refactoring and cleanup
  - Replaced MAX_GIF_WIDTH and DEFAULT_FPS with GIF_QUALITY preset system
  - Cleanup of unused code and configuration inconsistencies
  - Improved code organization and maintainability

### Fixed

- Fixed useless conditional checks flagged by GitHub Advanced Security
  - Removed always-false conditionals related to `treatAsGif` variable in GIF handling code
  - Simplified code logic in download command
- Fixed missing `tmp` package in production Docker builds
  - Moved `tmp` package from devDependencies to dependencies in package.json
  - Package is required by production code (`src/commands/download.js`) but was being removed by `npm prune --production`
  - Resolves bootloop issue where containers failed to start with "Cannot find package 'tmp'" error
- Fixed webui health check 500 error
  - Created missing `data-prod/gifs` directory in Dockerfile
  - Health check endpoint now passes when storage directory exists
  - Updated Dockerfile to create both `data-prod/gifs` and `data-test/gifs` directories for future builds
- Fixed storage directory creation for test and production environments
  - Updated server health check to automatically create storage directory if it doesn't exist
  - Server now creates `data-test/gifs` or `data-prod/gifs` directories automatically on startup
  - Prevents 500 errors on `/api/health` endpoint when directories are missing
  - Works for both `bot:test:webui` and `bot:prod:webui` commands
- Fixed video trimming and file type cache validation issues
- Fixed operations tracker test failures - fixed duration calculation test and variable initialization order
- Fixed CI/CD test job failures - use npx cross-env in test jobs to fix command not found error

### Removed

- Deferred downloads feature
  - Removed deferred download queue system that was never used in practice
  - Removed deferred download notification handlers
  - Removed "try again later" button UI from rate limit error messages
  - Removed test suite for deferred download functionality (453 test lines)
  - Rate limit errors now show a simple error message instructing users to try again later
  - Removed 1556 lines of code across 7 files (queue system, notifiers, tests, and related integrations)
  - Simplifies codebase by removing unused functionality that added unnecessary complexity

## [0.12.3-beta] - 2025-11-26

### Added

- Cookie authentication support for Cobalt restricted content
  - Added cookies.example.json with Twitter, Instagram, and Reddit cookie format examples
  - Updated docker-compose.yml to enable COOKIE_PATH and volume mount for cookies.json
  - Comprehensive documentation in Docker-Deployment.md covering setup, supported services, error handling, and security considerations
  - Enables Cobalt to access content requiring authentication from social media platforms
- R2 moderation system for managing user uploads
  - New moderation page in WebUI for viewing and managing user uploads stored in R2
  - Support for filtering and searching user media by file type
  - Pagination support for user list and media display
- Comprehensive test suite additions
  - Added tests for operations tracker, deferred download notifier, and operations search APIs
  - Improved test coverage for operation duration and status tracking
- Buffer size validation for video downloads
  - Added validation to ensure video buffers meet size requirements before processing
- Info-level logging for Discord uploads
  - Enhanced logging to include URLs when files are uploaded to Discord

### Changed

- Pre-commit hook improvements
  - Hook now automatically fixes formatting and linting issues when possible
  - Improved developer experience with auto-fix capabilities
- Video download limit reduction
  - Reduced maximum video download size from 500MB to 100MB
  - Updated tests to reflect new limit
- Pagination improvements
  - Added pagination to moderation page user list
  - Improved media pagination in moderation interface
- GitHub repository URL updates
  - Updated repository references to reflect current GitHub organization

### Fixed

- Discord URL tracking in database
  - Fixed issue where Discord attachment URLs were not being saved to database when files uploaded to Discord
  - Now properly captures Discord attachment URLs for tracking
- Operation duration calculation
  - Ensured operation duration is always at least 1ms to prevent zero-duration operations
  - Fixed test timing issues related to duration calculations
- Test mocks and assertions
  - Corrected test mocks for Discord.js Collection API
  - Fixed duration assertion issues in test suite
- R2 URL database storage
  - Fixed issue where R2 URLs were being saved to database even when files were not actually uploaded to R2
  - Only saves R2 URLs when files are successfully uploaded
- Log verbosity reduction
  - Reduced unnecessary log verbosity in various components

## [0.12.2-beta] - 2025-11-25

### Added

- Discord upload support for cached GIFs
  - Cached GIFs under 8MB are now uploaded as Discord attachments instead of URLs
  - Provides better user experience with direct file previews for cached conversions
  - Automatic fallback to R2 URL if Discord upload fails
- Operations search and debug page
  - New advanced operations search endpoint with filtering capabilities
  - New OperationsDebug page in WebUI for searching and filtering operations
  - Support for filtering by operation ID, status, type, user, URL pattern, date range, duration, and file size
  - Related operations endpoint for finding operations with matching URLs

### Changed

- Default quality setting changed from medium to high
  - All new conversions now default to high quality unless user specifies otherwise
  - Applies to convert and optimize commands
- Pre-commit hook optimization
  - Hook now only checks staged files instead of all files
  - Faster commit times by skipping checks on unchanged files
  - Only runs check:sync when package files are staged
  - Only runs linting on JavaScript/TypeScript files
  - Only runs formatting checks on Prettier-supported files
- GIF quality improvements
  - Use floyd-steinberg dithering for better color accuracy
  - Improved palette generation for better visual quality
- Operations tracking enhancements
  - Multi-instance support for operations tracking (supports multiple WebUI instances)
  - Enhanced logging with detailed operation steps for optimize command
  - Better operation step tracking with metadata
- WebUI styling improvements
  - Improved log level toggle button styling and compactness
  - Better table layout and spacing in user profile operations table
  - Enhanced error display formatting
  - Improved trace step display with better empty state handling

### Fixed

- Palette generation compatibility
  - Removed stats_mode=single from palettegen to fix compatibility issues with some FFmpeg versions
- GIF optimizer logging verbosity
  - Reduced logging verbosity by changing info-level logs to debug for path conversion details

## [0.12.1-beta] - 2025-11-25

### Added

- GitHub issue templates
  - Added issue templates for bug reports, feature requests, and other common issue types

### Changed

- Reorganized webui files into structured folders
  - Improved code organization and maintainability
- Updated repository references from p2xai to thedorekaczynski
  - Updated all repository references to reflect new organization name

### Fixed

- CodeQL false positives suppression
  - Suppressed false positive alerts for log injection and network-to-file access
- CodeQL security issues
  - Resolved log injection vulnerabilities
  - Fixed network data validation issues
- CodeQL-recognized sanitization patterns
  - Applied CodeQL-recognized sanitization patterns for log injection prevention
- CodeQL security vulnerabilities and warnings
  - Resolved additional CodeQL security vulnerabilities and warnings

### Dependencies

- Bumped body-parser from 2.2.0 to 2.2.1

### Removed

- Deleted wiki-repo
  - Removed wiki repository from project structure

## [0.12.0-prerelease] - 2025-11-25

### Added

- Test and production bot support with environment variable prefixes
  - Support for `TEST_*` and `PROD_*` prefixed environment variables for running separate test and production bots
  - New `bot-start.js` script that handles TEST/PROD prefixes and maps prefixed env vars to standard names
  - `register-commands.js` now supports TEST/PROD prefixes for command registration
  - Separate database files: `gronka-test.db` and `gronka-prod.db` for isolated data storage
  - New npm scripts for bot management:
    - `bot:test` / `bot:prod` - Start test or production bot
    - `bot:test:webui` / `bot:prod:webui` - Start bot with webui server
    - `bot:test:dev` / `bot:prod:dev` - Start bot with watch mode for development
    - `bot:register:test` / `bot:register:prod` - Register Discord commands for test or production bot
  - Support for prefixed configuration variables (e.g., `TEST_ADMIN_USER_IDS`, `PROD_CDN_BASE_URL`, `TEST_R2_BUCKET_NAME`)
  - Allows running both test and production bots simultaneously with independent configurations
- Local development scripts
  - Cross-platform scripts for managing local development environment
  - Similar to docker scripts but for local development
  - Scripts for starting, stopping, restarting, and verifying local services
- Wiki documentation and cloudflared configuration
  - Added wiki documentation structure
  - Cloudflared tunnel configuration for local development

### Security

- Shell metacharacter validation in optimize command
  - Added validation to prevent command injection via file paths in gif-optimizer.js
  - Checks for dangerous shell metacharacters in input and output paths
  - Throws ValidationError if invalid characters are detected

### Fixed

- Ntfy.sh notifications now properly contain duration metadata
  - Fixed operation ID handling through the notification pipeline
  - Duration information now correctly passed to ntfy notifications
- CSS asset loading through cloudflared tunnel
  - Fixed 404 errors for CSS assets when using cloudflared tunnel
  - Updated to use relative_url for CSS assets
- Privacy and terms documentation updates
  - Updated documentation for accuracy

### Changed

- **BREAKING**: Default upload strategy changed from R2-first to Discord-first
  - Files now default to Discord attachments for better user experience
  - Falls back to R2 storage for files larger than 8MB
  - Affects all commands: convert, download, optimize
  - Provides direct file previews in Discord for smaller files
- Docker configuration updates
  - Updated docker-compose.yml with new environment variable structure
  - Added data-test and data-prod volume mounts for separate test/prod data storage
  - Updated default environment variable handling for PROD/TEST prefixes
- Jekyll posts now tracked in git
- Updated .gitignore to exclude prod/test data folders
- Improved markdown formatting across documentation files
- Removed .cloudflared/config.yml from git tracking (now in .gitignore)

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

## [0.11.2-prerelease] - 2025-11-24

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

[0.12.5]: https://github.com/thedorekaczynski/gronka/compare/v0.12.4...v0.12.5
[0.12.4]: https://github.com/thedorekaczynski/gronka/compare/v0.12.3-beta...v0.12.4
[0.12.3-beta]: https://github.com/thedorekaczynski/gronka/compare/v0.12.2-beta...v0.12.3-beta
[0.12.2-beta]: https://github.com/thedorekaczynski/gronka/compare/v0.12.1-beta...v0.12.2-beta
[0.12.1-beta]: https://github.com/thedorekaczynski/gronka/compare/v0.12.0-prerelease...v0.12.1-beta
[0.12.0-prerelease]: https://github.com/thedorekaczynski/gronka/compare/v0.11.4-prerelease...v0.12.0-prerelease
[0.11.3-prerelease]: https://github.com/thedorekaczynski/gronka/compare/v0.11.2...v0.11.3-prerelease
[0.11.2]: https://github.com/thedorekaczynski/gronka/compare/v0.11.1-prerelease...v0.11.2
[0.11.2-prerelease]: https://github.com/thedorekaczynski/gronka/compare/v0.11.1-prerelease...v0.11.2-prerelease
[0.11.1-prerelease]: https://github.com/thedorekaczynski/gronka/compare/v0.11.0-prerelease...v0.11.1-prerelease
[0.11.0-prerelease]: https://github.com/thedorekaczynski/gronka/compare/v0.10.0...v0.11.0-prerelease
[0.10.0]: https://github.com/thedorekaczynski/gronka/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/thedorekaczynski/gronka/releases/tag/v0.9.0
