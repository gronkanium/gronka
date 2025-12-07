# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres (attempts) to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.14.2] - 2025-12-05

### Changed

- optimized Dockerfile with multi-stage build to reduce image size and build time
  - separated builder stage (with build tools) from runtime stage (production-only dependencies)
  - replaced docker-ce-cli package installation with lightweight Docker CLI binary copy from official Docker image
  - eliminated unnecessary Docker repository setup (gnupg, lsb-release, curl for repo key)
  - build tools (python3, make, g++) no longer included in final runtime image
  - devDependencies automatically excluded through stage separation
  - improved layer caching strategy for faster rebuilds
  - no functional changes, fully backward compatible

## [0.14.0] - 2025-12-03

### Removed

- **BREAKING**: Removed all SQLite database support
  - SQLite is no longer supported as a database backend
  - PostgreSQL is now the only supported database
  - Removed `GRONKA_DB_PATH` environment variable (no longer needed with PostgreSQL)
  - Removed `DATABASE_TYPE` environment variable (no longer needed - always PostgreSQL)
  - Removed SQLite-related code from `scripts/bot-start.js`
  - Removed SQLite references from `docker-compose.yml`
  - Removed SQLite references from test scripts in `package.json`
  - Removed legacy file-based database path logic
  - Test/prod database isolation now done via PostgreSQL database names (`TEST_POSTGRES_DB` vs `POSTGRES_DB`)
  - Migration: users must migrate to PostgreSQL before upgrading to v0.14.0 (see v0.13.0 changelog for migration script)

### Changed

- Simplified database configuration
  - Database configuration now exclusively uses PostgreSQL connection parameters
  - Test mode detection simplified to use `NODE_ENV` instead of database file paths
  - Removed database file path checks from `src/utils/logger.js` and `src/utils/operations-tracker.js`

### Documentation

- Updated all documentation to remove SQLite references
  - Removed `GRONKA_DB_PATH` configuration from all wiki pages
  - Updated blog posts with SQLite deprecation notices
  - Clarified that PostgreSQL is now required
  - Updated configuration examples to show PostgreSQL-only setup

### Added

- Enhanced clean-slate reset script to wipe PostgreSQL databases
  - Updated `scripts/reset-clean-slate.js` to drop all PostgreSQL tables when PostgreSQL is configured
  - Script now handles both database types: drops PostgreSQL tables and deletes SQLite database files
  - Added `wipePostgresDatabase()` function that connects to PostgreSQL and drops all tables in correct order
  - Supports both `DATABASE_URL` and individual PostgreSQL connection parameters
  - Gracefully handles cases where PostgreSQL is not configured or connection fails
  - Updated messaging to clearly indicate both databases are being wiped
- Minimal HTTP stats server built into bot process
  - Bot now includes a lightweight Express server for `/api/stats/24h` endpoint
  - Only serves stats endpoint for Jekyll site integration
  - No file serving - all files served from R2 or Discord
  - Supports basic authentication via `STATS_USERNAME` and `STATS_PASSWORD`
  - Configurable via `SERVER_PORT` and `SERVER_HOST` environment variables

### Changed

- **BREAKING**: Removed standalone server.js and simplified architecture
  - Architecture reduced from 3 processes to 2 processes (bot + webui)
  - Removed `src/server.js` - functionality moved to bot process
  - Bot process now includes minimal HTTP server for stats endpoint only
  - WebUI now calculates stats directly from database and filesystem instead of proxying HTTP requests
  - Docker healthcheck changed from HTTP check to process-based check
  - Updated all startup scripts: `docker-entrypoint.sh`, `bot-start.js`, `local-up.js`, `local-verify.js`
  - Removed `npm run server` script from package.json
  - Files no longer served via HTTP - only from R2 or Discord attachments
  - Migration: existing deployments will automatically work with new architecture, no manual changes needed
- Removed `MAIN_SERVER_URL` configuration variable
  - WebUI no longer needs `MAIN_SERVER_URL` environment variable
  - Stats and health data calculated directly instead of via HTTP proxy
  - Simplified configuration and eliminated port mismatch issues
  - Removed from `webuiConfig` in `src/utils/config.js`
- Simplified server configuration
  - `SERVER_PORT` and `SERVER_HOST` now only used for bot's minimal stats HTTP server
  - Removed unused `CORS_ORIGIN` from server config
  - Configuration is now focused on stats endpoint only

### Documentation

- Updated wiki documentation for new architecture
  - Rewrote `wiki/API-Endpoints.md` to reflect new stats-only HTTP server
  - Updated `wiki/Configuration.md` with simplified server configuration
  - Updated `wiki/Installation.md` to remove server.js startup instructions
  - Updated `wiki/Technical-Specification.md` to mark CDN server as deprecated
  - Updated `wiki/Jekyll-Stats.md` to reflect bot's built-in stats endpoint
  - Added migration notes and version information throughout documentation

### Fixed

- Fixed PostgreSQL test failures after SQLite to PostgreSQL migration
  - Fixed timestamp comparison issues by switching from strict equality to approximate matching (1 second tolerance)
  - Fixed duplicate key violations in logs by ensuring unique timestamps and component names for each test
  - Fixed user count mismatches by using unique user IDs per test run to prevent conflicts with previous test data
  - Fixed connection handling in `insertProcessedUrl` to gracefully handle closed database connections
  - Added cache invalidation in test setup to prevent stale data from previous test runs
  - Updated test files: `test/utils/database.test.js`, `test/utils/user-tracking.test.js`, `test/utils/log-metrics.test.js`
  - Updated database function: `src/utils/database/processed-urls-pg.js` for better error handling
- Fixed WebUI "invalid date" errors for timestamps after PostgreSQL migration
  - PostgreSQL's `postgres.js` library returns BIGINT values as strings instead of numbers
  - WebUI was showing "invalid date" because `new Date(timestamp)` failed when timestamp was a string
  - Created helper functions in `src/utils/database/helpers-pg.js` to convert timestamp fields from strings to numbers
  - Updated all PostgreSQL query functions to convert timestamps before returning:
    - `logs-pg.js` - Converts `timestamp` in `getLogs()` and `getLogMetrics()`
    - `alerts-pg.js` - Converts `timestamp` in `getAlerts()` and `insertAlert()`
    - `operations-pg.js` - Converts `timestamp` in `getOperationLogs()`, `getOperationTrace()`, and `getRecentOperations()` (including nested timestamps in performance metrics steps)
    - `metrics-pg.js` - Converts `timestamp` in `getSystemMetrics()`, `getLatestSystemMetrics()`, and `last_command_at`/`updated_at` in `getUserMetrics()` and `getAllUsersMetrics()`
    - `users-pg.js` - Converts `first_used` and `last_used` in `getUser()`
    - `processed-urls-pg.js` - Converts `processed_at` in `getProcessedUrl()`, `getUserMedia()`, and `getUserR2Media()`
  - All timestamps are now returned as numbers, allowing `new Date()` to parse them correctly
  - WebUI now displays timestamps correctly instead of showing "invalid date"
- Fixed WebUI API empty responses after Postgres migration
  - Fixed critical async/await bug in `src/webui-server/index.js` where `getRecentOperations()` was called without `await` during server startup
  - Operations were not loading from Postgres database at startup, causing empty responses
  - Added proper validation to ensure operations array is valid before processing
  - Enhanced error handling in route handlers (`users.js`, `logs.js`, `metrics.js`) with null/undefined checks
  - Added comprehensive error logging with stack traces for debugging database query failures
  - All endpoints now properly handle async database queries and return correct data types (arrays/numbers instead of empty objects)
  - WebUI API endpoints now return proper JSON responses with data instead of empty `{}` objects

## [0.13.0] - 2025-12-01

### Added

- PostgreSQL database support with SQLite deprecation path
  - Complete PostgreSQL migration implementation
  - Database abstraction layer to route to PostgreSQL
  - PostgreSQL connection pooling and async query support
  - New PostgreSQL-specific modules in `src/utils/database/`:
    - `connection-pg.js` - PostgreSQL connection management
    - `init-pg.js` - PostgreSQL schema initialization
    - `logs-pg.js`, `users-pg.js`, `operations-pg.js`, `metrics-pg.js`, `alerts-pg.js`, `processed-urls-pg.js`, `temporary-uploads-pg.js` - PostgreSQL implementations
  - Migration script: `scripts/migrate-sqlite-to-postgres.js` for seamless data migration
  - PostgreSQL debugging and testing utilities:
    - `scripts/debug-postgres-queries.js` - Query debugging tool
    - `scripts/reset-postgres-sequences.js` - Sequence reset utility
    - `scripts/test-database-wrapper.js` - Database wrapper testing
    - `scripts/test-get24HourStats.js` - Stats testing utility
    - `scripts/test-getAllUsersMetrics.js` - Metrics testing utility
  - **Note**: SQLite was deprecated in this version and removed completely in v0.14.0

### Changed

- **Critical fix**: Fixed async database write issues
  - Resolved critical bug where code was still using synchronous SQLite writes even after switching to PostgreSQL
  - Updated all database operations to use async PostgreSQL API consistently
  - Fixed database operation failures caused by sync/async mismatch
  - All webui-server routes and operations now use async database calls
  - Operations tracker and stats utilities updated for PostgreSQL async support
- Updated all tests to use async database API
  - Fixed test failures caused by synchronous database calls
  - Updated `test/utils/database.test.js`, `test/utils/user-tracking.test.js`, `test/utils/log-metrics.test.js`, `test/utils/logger.test.js`, `test/utils/logger-sanitization.test.js`, `test/webui-server-operations.test.js`
  - All tests now properly await async database operations
  - Added defensive assertions to `test/utils/operations-tracker.test.js` for better reliability

### Dependencies

- Security updates (from dependabot PR #12):
  - `@aws-sdk/client-s3`: `3.937.0` → `3.940.0`
  - `@aws-sdk/lib-storage`: `3.937.0` → `3.940.0`
  - `better-sqlite3`: `12.4.6` → `12.5.0` (removed in v0.14.0)
  - `lucide-svelte`: `0.554.0` → `0.555.0`
  - `prettier`: `3.6.2` → `3.7.3`
  - `svelte`: `5.43.14` → `5.45.2`
  - `vite`: `7.2.4` → `7.2.6`

### Deprecated

- SQLite database support (removed completely in v0.14.0)
  - All users should migrate to PostgreSQL using the provided migration script
  - `GRONKA_DB_PATH` environment variable (replaced by PostgreSQL connection parameters)
  - `DATABASE_TYPE` environment variable (PostgreSQL becomes the only option)

### Fixed

- Fixed failing CI test in `operations-tracker.test.js`
  - Added defensive assertions to ensure operation and step exist before accessing properties
  - Improved test reliability with better error messages

## [0.13.0-prerelease] - 2025-11-30

### Added

- Cloudflare KV and Pages integration for stats
  - Cloudflare KV storage for stats synchronization
  - Automated stats sync from bot server to Cloudflare KV
  - Cloudflare Pages build integration to fetch stats from KV
  - New scripts: `sync-stats-to-kv.js`, `fetch-stats-from-kv.js`
  - Validation and testing scripts: `validate-cloudflare-config.js`, `test-cloudflare-kv.js`
  - New npm scripts: `kv:sync-stats`, `kv:fetch-stats`, `validate:cloudflare`, `test:cloudflare`
  - Comprehensive documentation in `wiki/Cloudflare-Pages-Deployment.md`
  - Stats automatically update in Jekyll site footer via Cloudflare Pages builds

### Changed

- Refactored webui-server.js into modular structure
  - Broke down monolithic `src/webui-server.js` into focused modules organized in `src/webui-server/` subdirectory
  - Created separate modules for different webui concerns:
    - `webui-server/app.js` - Express app setup and configuration
    - `webui-server/index.js` - Main entry point and server startup
    - `webui-server/cache/` - Caching utilities (crypto-cache, stats-cache)
    - `webui-server/middleware/` - Express middleware (security, static file serving)
    - `webui-server/operations/` - Operation-related utilities (enrichment, reconstruction, storage)
    - `webui-server/routes/` - API route handlers (alerts, logs, metrics, moderation, operations, proxy, users)
    - `webui-server/utils/` - Utility functions (auth, validation)
    - `webui-server/websocket/` - WebSocket server implementation (broadcast, handlers, server)
  - Maintained backward compatibility by keeping main `src/webui-server.js` as a thin wrapper that imports from the modular structure
  - All existing npm scripts and imports continue to work without modification
  - Improved code organization, maintainability, and testability
  - No breaking changes - API and functionality remain identical

## [0.12.5] - 2025-11-29

### Added

- Quality parameter to `/convert` command
- Jekyll site footer statistics display
  - 24-hour activity statistics displayed in Jekyll site footer
  - Shows unique users, total files processed, and total data processed in the past 24 hours
  - Automatic stats polling via `scripts/update-jekyll-stats.js`
  - Integration with `scripts/update-jekyll-site.sh` to update stats before each build
  - New API endpoint `/api/stats/24h` for fetching 24-hour activity statistics
  - New environment variable `BOT_API_URL` for configuring bot server API URL
  - Stats display with proper singular/plural grammar handling
  - Graceful error handling - site builds even if stats update fails
  - Added `quality` option to `/convert` command with choices: low, medium, high
  - Allows users to specify GIF quality preset per conversion
  - Defaults to medium quality when not specified

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
- Refactored video-processor.js into modular structure
  - Broke down monolithic `src/utils/video-processor.js` (549 lines) into focused modules organized in `src/utils/video-processor/` subdirectory
  - Created separate modules for different video processing operations:
    - `video-processor/utils.js` - Shared utilities (validateNumericParameter, checkFFmpegInstalled)
    - `video-processor/convert-to-gif.js` - Video to GIF conversion
    - `video-processor/convert-image-to-gif.js` - Image to GIF conversion
    - `video-processor/trim-video.js` - Video trimming functionality
    - `video-processor/trim-gif.js` - GIF trimming functionality
    - `video-processor/metadata.js` - Video metadata extraction
  - Maintained backward compatibility by keeping main `src/utils/video-processor.js` as a barrel export that re-exports all functions from submodules
  - All existing imports continue to work without modification
  - Improved code organization, maintainability, and testability
  - No breaking changes - function signatures remain identical
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

[0.13.0]: https://github.com/gronkanium/gronka/compare/v0.13.0-prerelease...v0.13.0
[0.12.5]: https://github.com/gronkanium/gronka/compare/v0.12.4...v0.12.5
[0.12.4]: https://github.com/gronkanium/gronka/compare/v0.12.3-beta...v0.12.4
[0.12.3-beta]: https://github.com/gronkanium/gronka/compare/v0.12.2-beta...v0.12.3-beta
[0.12.2-beta]: https://github.com/gronkanium/gronka/compare/v0.12.1-beta...v0.12.2-beta
[0.12.1-beta]: https://github.com/gronkanium/gronka/compare/v0.12.0-prerelease...v0.12.1-beta
[0.12.0-prerelease]: https://github.com/gronkanium/gronka/compare/v0.11.4-prerelease...v0.12.0-prerelease
[0.11.3-prerelease]: https://github.com/gronkanium/gronka/compare/v0.11.2...v0.11.3-prerelease
[0.11.2]: https://github.com/gronkanium/gronka/compare/v0.11.1-prerelease...v0.11.2
[0.11.2-prerelease]: https://github.com/gronkanium/gronka/compare/v0.11.1-prerelease...v0.11.2-prerelease
[0.11.1-prerelease]: https://github.com/gronkanium/gronka/compare/v0.11.0-prerelease...v0.11.1-prerelease
[0.11.0-prerelease]: https://github.com/gronkanium/gronka/compare/v0.10.0...v0.11.0-prerelease
[0.10.0]: https://github.com/gronkanium/gronka/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/gronkanium/gronka/releases/tag/v0.9.0

## [Unreleased]

### Added

- ci: optimize gitlab ci and add postgresql readiness check ([4390d2b](https://github.com/gronkanium/gronka/commit/4390d2b426a2396c2d3592550ad6d58cff957b5d)) - [`.github/workflows/ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.github/workflows/ci.yml), [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml)
- ci: add postgresql service to gitlab ci and github actions test jobs ([d336689](https://github.com/gronkanium/gronka/commit/d33668964067cea93038a60ebe16a342b0a33dd0)) - [`.github/workflows/ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.github/workflows/ci.yml), [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml)
- feat: postgres db ([d2536df](https://github.com/gronkanium/gronka/commit/d2536dfad01f472f1588df197e971ebe377d3d3f)) - [`docker-compose.yml`](https://github.com/gronkanium/gronka/blob/HEAD/docker-compose.yml), [`package-lock.json`](https://github.com/gronkanium/gronka/blob/HEAD/package-lock.json), [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json), [`scripts/migrate-sqlite-to-postgres.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/migrate-sqlite-to-postgres.js), [`src/utils/database.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database.js) (+16 more)
- Revert "feat: add adaptive FPS calculation and fps parameter to convert command" ([f759087](https://github.com/gronkanium/gronka/commit/f759087faa85e0f500a58b161faa37df590f5ab1)) - [`src/commands/convert.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/convert.js), [`src/register-commands.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/register-commands.js), [`src/utils/video-processor.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/video-processor.js), [`src/utils/video-processor/fps-calculator.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/video-processor/fps-calculator.js)
- feat: add adaptive FPS calculation and fps parameter to convert command ([37b018b](https://github.com/gronkanium/gronka/commit/37b018bf4af8cc5dc9adc484fdfe2fb2e378a23e)) - [`src/commands/convert.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/convert.js), [`src/register-commands.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/register-commands.js), [`src/utils/video-processor.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/video-processor.js), [`src/utils/video-processor/fps-calculator.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/video-processor/fps-calculator.js)
- feat: add webui-server implementation ([3af13c2](https://github.com/gronkanium/gronka/commit/3af13c29021fa017da67b5f56691201a70a6bd63)) - [`src/webui-server/app.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui-server/app.js), [`src/webui-server/cache/crypto-cache.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui-server/cache/crypto-cache.js), [`src/webui-server/cache/stats-cache.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui-server/cache/stats-cache.js), [`src/webui-server/index.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui-server/index.js), [`src/webui-server/middleware/security.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui-server/middleware/security.js) (+16 more)
- feat: add Cloudflare KV and Pages integration for stats ([32fe0ad](https://github.com/gronkanium/gronka/commit/32fe0ad890e2384a4a6e3c343bb7ac74f8093e1d)) - [`.gitignore`](https://github.com/gronkanium/gronka/blob/HEAD/.gitignore), [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json), [`scripts/test-cloudflare-kv.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/test-cloudflare-kv.js), [`scripts/validate-cloudflare-config.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/validate-cloudflare-config.js), [`wiki/Cloudflare-Pages-Deployment.md`](https://github.com/gronkanium/gronka/blob/HEAD/wiki/Cloudflare-Pages-Deployment.md)
- feat: add Cloudflare Pages deployment with KV stats sync ([93cb519](https://github.com/gronkanium/gronka/commit/93cb519caa619008d6f978f99a9e17231be2712e)) - [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json), [`scripts/fetch-stats-from-kv.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/fetch-stats-from-kv.js), [`scripts/sync-stats-to-kv.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/sync-stats-to-kv.js), [`src/commands/convert.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/convert.js), [`src/commands/download.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/download.js) (+2 more)
- docs: add R2 expiration policy (72 hours) to clean slate reset post ([f4335b1](https://github.com/gronkanium/gronka/commit/f4335b1da231547d098a819bc007329df9c8665a)) - [`_posts/2025-11-29-clean-slate-reset.md`](https://github.com/gronkanium/gronka/blob/HEAD/_posts/2025-11-29-clean-slate-reset.md)
- feat: add clean slate reset script and announcement blog post ([b2ba19d](https://github.com/gronkanium/gronka/commit/b2ba19d0326ae79476ccc25826d674ff41b6ec3f)) - [`_posts/2025-11-29-clean-slate-reset.md`](https://github.com/gronkanium/gronka/blob/HEAD/_posts/2025-11-29-clean-slate-reset.md), [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json), [`scripts/reset-clean-slate.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/reset-clean-slate.js)
- docs: add jekyll-stats to wiki sidebar and jekyll docs ([76ec860](https://github.com/gronkanium/gronka/commit/76ec86090f4c9e99daac917bbbe0b3a7f6a939a8)) - [`_docs/jekyll-stats.md`](https://github.com/gronkanium/gronka/blob/HEAD/_docs/jekyll-stats.md), [`package-lock.json`](https://github.com/gronkanium/gronka/blob/HEAD/package-lock.json), [`wiki/_Sidebar.md`](https://github.com/gronkanium/gronka/blob/HEAD/wiki/_Sidebar.md)
- feat: add 24-hour stats to Jekyll footer ([ee2486f](https://github.com/gronkanium/gronka/commit/ee2486f2344fd6c649011dbe7313f6fd1f509038)) - [`_data/stats.json`](https://github.com/gronkanium/gronka/blob/HEAD/_data/stats.json), [`_includes/footer.html`](https://github.com/gronkanium/gronka/blob/HEAD/_includes/footer.html), [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json), [`scripts/update-jekyll-stats.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/update-jekyll-stats.js), [`src/server.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/server.js) (+1 more)
- feat: comprehensive requests tracking and web UI improvements ([d717ff4](https://github.com/gronkanium/gronka/commit/d717ff4873dc8d418c27f24a867c54dfb9eb5e14)) - [`_posts/2025-11-28-gronka-updates-quality-trimming-refactoring-deployment.md`](https://github.com/gronkanium/gronka/blob/HEAD/_posts/2025-11-28-gronka-updates-quality-trimming-refactoring-deployment.md), [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json), [`scripts/build-webui.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/build-webui.js), [`scripts/docker-copy-webui.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/docker-copy-webui.js), [`src/commands/convert.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/convert.js) (+6 more)
- feat: add Jekyll YAML validation to prevent blog post syntax errors ([ab622ff](https://github.com/gronkanium/gronka/commit/ab622ff3eb19a0642e1959c5b50ace329e6a5d3e)) - [`.husky/pre-commit`](https://github.com/gronkanium/gronka/blob/HEAD/.husky/pre-commit), [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json), [`scripts/validate-jekyll-yaml.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/validate-jekyll-yaml.js)
- add comprehensive blog post covering recent gronka updates ([cba213d](https://github.com/gronkanium/gronka/commit/cba213de111aa5da5ca169a46527d6a18b8d3a48)) - [`_posts/2025-11-28-gronka-updates-quality-trimming-refactoring-deployment.md`](https://github.com/gronkanium/gronka/blob/HEAD/_posts/2025-11-28-gronka-updates-quality-trimming-refactoring-deployment.md)
- Merge branch 'feature/r2-temporary-uploads' into 'main' ([9cea79f](https://github.com/gronkanium/gronka/commit/9cea79fa5a44240786f782bf6fd2ca2683585253))
- ci: add path-based filtering to skip tests for docs-only changes ([7ddacf0](https://github.com/gronkanium/gronka/commit/7ddacf015b13d50d633d1813128e4c3cf57dafa0)) - [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml)
- feat: add R2 temporary uploads with automatic cleanup and improve GIF quality ([a0eab75](https://github.com/gronkanium/gronka/commit/a0eab75eef22c811ff592fda7eef0f10772e0f46)) - [`.env.example`](https://github.com/gronkanium/gronka/blob/HEAD/.env.example), [`README.md`](https://github.com/gronkanium/gronka/blob/HEAD/README.md), [`_posts/2025-11-27-r2-upload-expiration.md`](https://github.com/gronkanium/gronka/blob/HEAD/_posts/2025-11-27-r2-upload-expiration.md), [`src/bot.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/bot.js), [`src/commands/convert.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/convert.js) (+14 more)
- feat: enhance docker-reload script and add documentation includes ([6b2d88c](https://github.com/gronkanium/gronka/commit/6b2d88c74f330ddf0b380fd19b738147f72789dc)) - [`.prettierignore`](https://github.com/gronkanium/gronka/blob/HEAD/.prettierignore), [`CHANGELOG.md`](https://github.com/gronkanium/gronka/blob/HEAD/CHANGELOG.md), [`_includes/command-card.html`](https://github.com/gronkanium/gronka/blob/HEAD/_includes/command-card.html), [`_includes/commands-list.html`](https://github.com/gronkanium/gronka/blob/HEAD/_includes/commands-list.html), [`_includes/doc-nav.html`](https://github.com/gronkanium/gronka/blob/HEAD/_includes/doc-nav.html) (+4 more)
- feat: add structured data for blog and docs pages ([77bf665](https://github.com/gronkanium/gronka/commit/77bf66545cfbbd4b8b02cb9124283d70aa04a378)) - [`.gitignore`](https://github.com/gronkanium/gronka/blob/HEAD/.gitignore), [`_includes/structured-data.html`](https://github.com/gronkanium/gronka/blob/HEAD/_includes/structured-data.html)
- feat: improve SEO with Twitter cards, structured data, and meta tags ([59c8987](https://github.com/gronkanium/gronka/commit/59c8987e23165f7e4ea60d1824776f49d2789abf)) - [`_config.yml`](https://github.com/gronkanium/gronka/blob/HEAD/_config.yml), [`blog/index.html`](https://github.com/gronkanium/gronka/blob/HEAD/blog/index.html)
- add blog post about future r2 upload expiration policy ([2921c89](https://github.com/gronkanium/gronka/commit/2921c894f4bfc1028a04705af45c899913828798)) - [`_posts/2025-11-26-r2-upload-expiration.md`](https://github.com/gronkanium/gronka/blob/HEAD/_posts/2025-11-26-r2-upload-expiration.md)
- feat: make rate limit configurable via RATE_LIMIT env var ([e7f0335](https://github.com/gronkanium/gronka/commit/e7f0335102a674169bc804b2ec75a94f5fa00b6e)) - [`.env.example`](https://github.com/gronkanium/gronka/blob/HEAD/.env.example), [`src/commands/convert.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/convert.js), [`src/commands/download.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/download.js), [`src/commands/optimize.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/optimize.js), [`src/utils/config.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/config.js) (+1 more)

### Changed

- Merge pull request #16 from gronkanium/migrate-to-gronkanium-org ([aae8ef1](https://github.com/gronkanium/gronka/commit/aae8ef172d7edc56220c14ddffff1af51ae64682))
- chore: migrate github repository to gronkanium organization ([99d1d2d](https://github.com/gronkanium/gronka/commit/99d1d2d8e2a98a1adb8704e69f49f5fa13cf9f0b)) - [`.github/ISSUE_TEMPLATE/config.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.github/ISSUE_TEMPLATE/config.yml), [`CHANGELOG.md`](https://github.com/gronkanium/gronka/blob/HEAD/CHANGELOG.md), [`Dockerfile`](https://github.com/gronkanium/gronka/blob/HEAD/Dockerfile), [`README.md`](https://github.com/gronkanium/gronka/blob/HEAD/README.md), [`_includes/footer.html`](https://github.com/gronkanium/gronka/blob/HEAD/_includes/footer.html) (+13 more)
- blog: 50 authorized users milestone and postgres migration ([5707d52](https://github.com/gronkanium/gronka/commit/5707d52c36a4c6be4e315104eb757880d7698a97)) - [`Gemfile.lock`](https://github.com/gronkanium/gronka/blob/HEAD/Gemfile.lock), [`_posts/2025-12-02-50-users-postgres-migration.md`](https://github.com/gronkanium/gronka/blob/HEAD/_posts/2025-12-02-50-users-postgres-migration.md), [`_sass/minima.scss`](https://github.com/gronkanium/gronka/blob/HEAD/_sass/minima.scss), [`_sass/minima/_base.scss`](https://github.com/gronkanium/gronka/blob/HEAD/_sass/minima/_base.scss), [`assets/images/50-users-milestone.png`](https://github.com/gronkanium/gronka/blob/HEAD/assets/images/50-users-milestone.png) (+3 more)
- Merge pull request #14 from thedorekaczynski/cf-pages-test ([a6f845c](https://github.com/gronkanium/gronka/commit/a6f845c0461012903085c3172b1e51edd17c52cf))
- docs: update documentation for index and terms pages ([fc68573](https://github.com/gronkanium/gronka/commit/fc68573d2bf8bd93c71ccb3d46463be2b0a57e8b)) - [`index.md`](https://github.com/gronkanium/gronka/blob/HEAD/index.md), [`terms.md`](https://github.com/gronkanium/gronka/blob/HEAD/terms.md)
- optimize quality presets for reduced file sizes ([1b9a4bc](https://github.com/gronkanium/gronka/commit/1b9a4bcaf3f3bfc5f652fdb2448424d98377d700)) - [`src/utils/video-processor/convert-image-to-gif.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/video-processor/convert-image-to-gif.js), [`src/utils/video-processor/convert-to-gif.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/video-processor/convert-to-gif.js), [`src/utils/video-processor/trim-video.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/video-processor/trim-video.js)
- Merge pull request #13 from thedorekaczynski/dependabot/npm_and_yarn/express-5.2.1 ([5253815](https://github.com/gronkanium/gronka/commit/525381561a6d1e83375b475dd6ffcfbead21b2c3))
- deps(deps): bump express from 5.1.0 to 5.2.1 ([19b169c](https://github.com/gronkanium/gronka/commit/19b169c4c0927fb947aaf6510de88cda7a9c6a17)) - [`package-lock.json`](https://github.com/gronkanium/gronka/blob/HEAD/package-lock.json), [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json)
- forgor ([9470112](https://github.com/gronkanium/gronka/commit/94701122d8eeacfd70d661c8a0706e013683c72c))
- chore: bump version to 0.13.0 and update changelog ([8315fb2](https://github.com/gronkanium/gronka/commit/8315fb20097e8c52a7c27864a2dfbf6013691a05)) - [`CHANGELOG.md`](https://github.com/gronkanium/gronka/blob/HEAD/CHANGELOG.md), [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json)
- docs: update changelog for 0.13.0-prerelease with webui modularization and Cloudflare KV integration ([e077ff1](https://github.com/gronkanium/gronka/commit/e077ff1ae797948d3c86cd6cd6134f53b646d450)) - [`CHANGELOG.md`](https://github.com/gronkanium/gronka/blob/HEAD/CHANGELOG.md)
- chore: bump version to 0.13.0-prerelease ([e4601be](https://github.com/gronkanium/gronka/commit/e4601bebed3ad9858ab0399d359e19e6de62bfc6)) - [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json)
- style: format and lint codebase ([fbd7197](https://github.com/gronkanium/gronka/commit/fbd7197e8d9cf7af0ae5bbba2a124d9be25faf31)) - [`scripts/test-cloudflare-kv.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/test-cloudflare-kv.js), [`scripts/validate-cloudflare-config.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/validate-cloudflare-config.js)
- perf: comprehensive performance optimizations ([64eac8f](https://github.com/gronkanium/gronka/commit/64eac8f9521a71d082cf79f9ae1a6991c938d04e)) - [`src/bot.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/bot.js), [`src/commands/optimize.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/optimize.js), [`src/utils/database/connection.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database/connection.js), [`src/utils/database/init.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database/init.js), [`src/utils/database/logs.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database/logs.js) (+5 more)
- chore: update docker reload script, operations tracker, and webui server ([9fc5d74](https://github.com/gronkanium/gronka/commit/9fc5d745ba80a2598198f765e38288ee64634ef8)) - [`src/utils/operations-tracker.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/operations-tracker.js), [`src/webui-server.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui-server.js)
- chore: bump version to 0.12.5 and update changelog for release ([96f0458](https://github.com/gronkanium/gronka/commit/96f0458baf3006b16e61ac9804c868fb67345394)) - [`CHANGELOG.md`](https://github.com/gronkanium/gronka/blob/HEAD/CHANGELOG.md), [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json)
- chore: update docker config, ci, and webui components ([af16e24](https://github.com/gronkanium/gronka/commit/af16e240cf177a1e68198e4e8110183bfcee9511)) - [`.dockerignore`](https://github.com/gronkanium/gronka/blob/HEAD/.dockerignore), [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml), [`_posts/2025-11-29-clean-slate-reset.md`](https://github.com/gronkanium/gronka/blob/HEAD/_posts/2025-11-29-clean-slate-reset.md), [`scripts/docker-reload-fast.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/docker-reload-fast.js)
- chore: commit all remaining uncommitted files ([232efb9](https://github.com/gronkanium/gronka/commit/232efb9906f63fe0972c176a710ea90296c99178))
- test: verify hook ([3fbdf29](https://github.com/gronkanium/gronka/commit/3fbdf29d6767b3a86fbf8cf3b710bccb75aa2767)) - [`test-file.txt`](https://github.com/gronkanium/gronka/blob/HEAD/test-file.txt)
- refactor: only run Jekyll YAML validation when blog posts are staged ([d5fc3e5](https://github.com/gronkanium/gronka/commit/d5fc3e5948402969e99ad26540cd870064836703)) - [`.husky/pre-commit`](https://github.com/gronkanium/gronka/blob/HEAD/.husky/pre-commit)
- docs: document environment variable discrepancy between bot:prod:webui and docker:up ([0cdcbdf](https://github.com/gronkanium/gronka/commit/0cdcbdf1b1d8e7f3695df1354ab2f6ed0c3bb589)) - [`wiki/Configuration.md`](https://github.com/gronkanium/gronka/blob/HEAD/wiki/Configuration.md), [`wiki/Docker-Deployment.md`](https://github.com/gronkanium/gronka/blob/HEAD/wiki/Docker-Deployment.md)
- docs: update wiki and documentation for data-prod/data-test and test bot ([d43f63e](https://github.com/gronkanium/gronka/commit/d43f63e4e1c610e50446a7eb4a3a2fcfde607401)) - [`wiki/Configuration.md`](https://github.com/gronkanium/gronka/blob/HEAD/wiki/Configuration.md), [`wiki/Docker-Deployment.md`](https://github.com/gronkanium/gronka/blob/HEAD/wiki/Docker-Deployment.md), [`wiki/Docker-Quick-Reference.md`](https://github.com/gronkanium/gronka/blob/HEAD/wiki/Docker-Quick-Reference.md), [`wiki/Home.md`](https://github.com/gronkanium/gronka/blob/HEAD/wiki/Home.md), [`wiki/Installation.md`](https://github.com/gronkanium/gronka/blob/HEAD/wiki/Installation.md) (+6 more)
- chore: bump version to 0.12.5-nightly and update changelog ([18d4d8c](https://github.com/gronkanium/gronka/commit/18d4d8ce3de2302a5c57a7ccdecb776ec8f7259a)) - [`CHANGELOG.md`](https://github.com/gronkanium/gronka/blob/HEAD/CHANGELOG.md), [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json)
- update r2 upload expiration blog post date and content ([5c1af24](https://github.com/gronkanium/gronka/commit/5c1af244fd81d0ff17da700352fcbb86cc914555)) - [`_posts/2025-11-26-r2-upload-expiration.md`](https://github.com/gronkanium/gronka/blob/HEAD/_posts/2025-11-26-r2-upload-expiration.md), [`_posts/2025-11-27-r2-upload-expiration.md`](https://github.com/gronkanium/gronka/blob/HEAD/_posts/2025-11-27-r2-upload-expiration.md)
- test: improve rate limit test and make test scripts accept file arguments ([4740f4f](https://github.com/gronkanium/gronka/commit/4740f4fd9ccaba01df6c0347b8d52da614b63183)) - [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json), [`test/utils/rate-limit.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/rate-limit.test.js)
- docs: update TODO.md to reflect completed refactorings ([aa4253e](https://github.com/gronkanium/gronka/commit/aa4253e547c64ba0eed2c986df2646b209d881ac)) - [`TODO.md`](https://github.com/gronkanium/gronka/blob/HEAD/TODO.md)
- Merge branch 'refactor/database-modular-structure' into 'main' ([6769c14](https://github.com/gronkanium/gronka/commit/6769c141fdea78ff722b5194d687fa2b243da670))
- Merge remote-tracking branch 'gitlab/main' into refactor/database-modular-structure ([a5764bc](https://github.com/gronkanium/gronka/commit/a5764bcb9f27975fba03fc7bb094b73628083dda))
- style: apply prettier formatting to video-processor modules ([3512560](https://github.com/gronkanium/gronka/commit/3512560438a7eb4a63346a23d10f3615f3102e5d))
- refactor: break down video-processor.js into modular structure ([f4c9ea0](https://github.com/gronkanium/gronka/commit/f4c9ea03472513efc726fa80eb40983220f91084)) - [`src/utils/video-processor.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/video-processor.js), [`src/utils/video-processor/convert-image-to-gif.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/video-processor/convert-image-to-gif.js), [`src/utils/video-processor/convert-to-gif.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/video-processor/convert-to-gif.js), [`src/utils/video-processor/metadata.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/video-processor/metadata.js), [`src/utils/video-processor/trim-gif.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/video-processor/trim-gif.js) (+2 more)

### Removed

- refactor: remove docs from jekyll site, use github wiki exclusively ([badc59a](https://github.com/gronkanium/gronka/commit/badc59a4e3e63eda6ab80c3e738d6aa0c2c7352f)) - [`README.md`](https://github.com/gronkanium/gronka/blob/HEAD/README.md), [`_data/navigation.yml`](https://github.com/gronkanium/gronka/blob/HEAD/_data/navigation.yml), [`_posts/2025-11-24-development-cycle.md`](https://github.com/gronkanium/gronka/blob/HEAD/_posts/2025-11-24-development-cycle.md), [`_posts/2025-11-28-gronka-updates-quality-trimming-refactoring-deployment.md`](https://github.com/gronkanium/gronka/blob/HEAD/_posts/2025-11-28-gronka-updates-quality-trimming-refactoring-deployment.md)
- chore: remove sqlite support and deprecate legacy env vars (v0.14.0) ([eaa7bf7](https://github.com/gronkanium/gronka/commit/eaa7bf7d49e7853a838caefed9958fb0338895f0)) - [`CHANGELOG.md`](https://github.com/gronkanium/gronka/blob/HEAD/CHANGELOG.md), [`Dockerfile`](https://github.com/gronkanium/gronka/blob/HEAD/Dockerfile), [`_posts/2025-11-28-gronka-updates-quality-trimming-refactoring-deployment.md`](https://github.com/gronkanium/gronka/blob/HEAD/_posts/2025-11-28-gronka-updates-quality-trimming-refactoring-deployment.md), [`docker-compose.yml`](https://github.com/gronkanium/gronka/blob/HEAD/docker-compose.yml), [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json) (+12 more)
- test: remove sqlite references from test files, use postgresql ([42114be](https://github.com/gronkanium/gronka/commit/42114be7b3adc92176898abb93a8527c96a2d47f)) - [`test/utils/cobalt-queue.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/cobalt-queue.test.js), [`test/utils/database.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/database.test.js), [`test/utils/log-metrics.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/log-metrics.test.js), [`test/utils/logger-sanitization.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/logger-sanitization.test.js), [`test/utils/logger.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/logger.test.js) (+3 more)
- test: remove test file ([9cb79ed](https://github.com/gronkanium/gronka/commit/9cb79edac455f20d2b67d2b3aada12e9cdf14058)) - [`test-file.txt`](https://github.com/gronkanium/gronka/blob/HEAD/test-file.txt)
- remove deprecated data directory ([536fe6d](https://github.com/gronkanium/gronka/commit/536fe6d538d0112d83cc2335d52ef0c4491c810f)) - [`docker-compose.yml`](https://github.com/gronkanium/gronka/blob/HEAD/docker-compose.yml), [`eslint.config.js`](https://github.com/gronkanium/gronka/blob/HEAD/eslint.config.js), [`scripts/bot-start.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/bot-start.js), [`scripts/user-stats.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/user-stats.js), [`test/docker-security.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/docker-security.test.js) (+1 more)

### Fixed

- fix: add WEBUI_PORT=3101 to GitHub Actions test jobs ([9d5d579](https://github.com/gronkanium/gronka/commit/9d5d57965822237b9a8f5af4a5afb22448c65be3)) - [`.github/workflows/ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.github/workflows/ci.yml)
- fix: handle index conflicts in postgres initialization ([0fcffaf](https://github.com/gronkanium/gronka/commit/0fcffaf8b1928d14e52a05ec27d3381b5e382d43)) - [`src/utils/database/init.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database/init.js)
- fix: handle both type and table conflicts in postgres initialization ([bb7b734](https://github.com/gronkanium/gronka/commit/bb7b7348777256479ea3ff82e40d48a1c9863301)) - [`src/utils/database/init.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database/init.js), [`src/utils/database/test-helpers.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database/test-helpers.js)
- fix: drop table before type in postgres conflict handling ([e26d728](https://github.com/gronkanium/gronka/commit/e26d72811f6e3889e37332b128b99419ba5fb580)) - [`src/utils/database/init.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database/init.js)
- fix: handle postgres type conflicts in database initialization ([6ccfeec](https://github.com/gronkanium/gronka/commit/6ccfeecd5b0b5b11f0f5b51543b40cb1bfce126e)) - [`src/utils/database/init-pg.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database/init-pg.js), [`src/utils/database/init.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database/init.js)
- fix: remove _redirects and _headers to fix redirect loop on privacy/terms pages ([97d2898](https://github.com/gronkanium/gronka/commit/97d2898cacafc53eca4438b30615f891fe6f008d)) - [`.eslintignore`](https://github.com/gronkanium/gronka/blob/HEAD/.eslintignore), [`_headers`](https://github.com/gronkanium/gronka/blob/HEAD/_headers), [`_redirects`](https://github.com/gronkanium/gronka/blob/HEAD/_redirects), [`eslint.config.js`](https://github.com/gronkanium/gronka/blob/HEAD/eslint.config.js), [`index.md`](https://github.com/gronkanium/gronka/blob/HEAD/index.md) (+16 more)
- fix: add cloudflare pages routing configuration for /docs/ path ([c20d0ad](https://github.com/gronkanium/gronka/commit/c20d0ad15a7109acacbc59c17d3cf7403ce00862)) - [`_config.yml`](https://github.com/gronkanium/gronka/blob/HEAD/_config.yml), [`_headers`](https://github.com/gronkanium/gronka/blob/HEAD/_headers), [`_redirects`](https://github.com/gronkanium/gronka/blob/HEAD/_redirects)
- fix: cap gif fps to 30fps maximum to fix duration doubling on 60fps videos ([bb618cb](https://github.com/gronkanium/gronka/commit/bb618cbbee1e75e8a4bedeeaf8fdad93a31c73e5)) - [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json), [`src/commands/convert.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/convert.js), [`wiki/Technical-Specification.md`](https://github.com/gronkanium/gronka/blob/HEAD/wiki/Technical-Specification.md)
- fix: configure postgres service with explicit credentials in ci ([b07816e](https://github.com/gronkanium/gronka/commit/b07816e0511e005814207c32bb3fab9a5ece393f)) - [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml)
- fix: add missing await for getRecentOperations in backfill script ([abd994a](https://github.com/gronkanium/gronka/commit/abd994a58a28472a4af7cd94b640660cce84712e)) - [`scripts/backfill-operation-urls.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/backfill-operation-urls.js)
- fix ai blog post and gemfile dependencies updates, fix prod/test variables in connection.js ([7059944](https://github.com/gronkanium/gronka/commit/70599441533b4297849cd04a5ea294e25d9075d8)) - [`_posts/2025-12-02-50-users-postgres-migration.md`](https://github.com/gronkanium/gronka/blob/HEAD/_posts/2025-12-02-50-users-postgres-migration.md), [`src/utils/database/connection.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database/connection.js)
- fix: add bigdecimal gem for ruby 3.4+ compatibility ([f8bdedb](https://github.com/gronkanium/gronka/commit/f8bdedbc1ebd5a9cb90e5fe8e455d6b8632266b2)) - [`Gemfile`](https://github.com/gronkanium/gronka/blob/HEAD/Gemfile), [`Gemfile.lock`](https://github.com/gronkanium/gronka/blob/HEAD/Gemfile.lock)
- fix: add missing await keywords to async database calls ([c9799cb](https://github.com/gronkanium/gronka/commit/c9799cb4b88e87f362a0e4c27b4f069c37d194b2)) - [`scripts/backfill-operation-urls.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/backfill-operation-urls.js), [`src/utils/ntfy-notifier.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/ntfy-notifier.js), [`src/webui-server/operations/enrichment.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui-server/operations/enrichment.js), [`src/webui-server/operations/reconstruction.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui-server/operations/reconstruction.js), [`src/webui-server/websocket/handlers.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui-server/websocket/handlers.js)
- fix: kv:sync-stats now correctly fetches from production database ([cea8bd8](https://github.com/gronkanium/gronka/commit/cea8bd87879afc94f16f206a04d79e65b6e0b378)) - [`scripts/sync-stats-to-kv.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/sync-stats-to-kv.js), [`scripts/test-stats-fetch.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/test-stats-fetch.js), [`src/utils/database/connection.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database/connection.js), [`src/utils/database/stats.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database/stats.js)
- fix: suppress verbose postgresql notice logs in test mode ([128bbfc](https://github.com/gronkanium/gronka/commit/128bbfc39abd367103ccdfd8f40a6fa9d48d0921)) - [`src/utils/database/connection.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database/connection.js)
- fix: install postgresql-client in gitlab ci before postgres readiness check ([1c93dcf](https://github.com/gronkanium/gronka/commit/1c93dcf715c023cce7a8c3a05551029f37067d71)) - [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml)
- fix: resolve database initialization race condition in parallel tests ([dba26c8](https://github.com/gronkanium/gronka/commit/dba26c8442a3cd9ba4d5e9d71bc54b0ff28b8a1c)) - [`src/utils/database/init.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database/init.js)
- fix: resolve postgresql test race conditions with unique timestamps and components ([3d00352](https://github.com/gronkanium/gronka/commit/3d003520ae2a9468ccc548178b70265cb91b03bc)) - [`package-lock.json`](https://github.com/gronkanium/gronka/blob/HEAD/package-lock.json), [`src/utils/database.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database.js), [`src/utils/database/init-pg.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database/init-pg.js), [`src/utils/database/init.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database/init.js), [`src/utils/database/test-helpers.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database/test-helpers.js) (+8 more)
- fix: ensure tests are written to test table, ensure admin id is passed to commands ([1cb57a2](https://github.com/gronkanium/gronka/commit/1cb57a201928844f4a8eb6f487302f170f51dacc)) - [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json), [`src/commands/convert.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/convert.js), [`src/commands/download.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/download.js), [`src/commands/optimize.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/optimize.js), [`src/utils/database/connection.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database/connection.js) (+3 more)
- fix: PostgreSQL test failures after SQLite migration ([32863cb](https://github.com/gronkanium/gronka/commit/32863cb2e8471fa00776d6ed823cb278dabab6a8)) - [`CHANGELOG.md`](https://github.com/gronkanium/gronka/blob/HEAD/CHANGELOG.md), [`TODO.md`](https://github.com/gronkanium/gronka/blob/HEAD/TODO.md), [`docker-compose.yml`](https://github.com/gronkanium/gronka/blob/HEAD/docker-compose.yml), [`package-lock.json`](https://github.com/gronkanium/gronka/blob/HEAD/package-lock.json), [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json) (+44 more)
- fix: add defensive assertions to step duration test ([e6a7a2b](https://github.com/gronkanium/gronka/commit/e6a7a2b614685d9eef621bc39e83e3f5013b4068)) - [`test/utils/operations-tracker.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/operations-tracker.test.js)
- Merge branch 'postgres-cleanup-async-fixes' into 'main' ([d5576dd](https://github.com/gronkanium/gronka/commit/d5576dd096b0fb05944ee51be7f6739d88b8a374))
- feat: finalize postgres migration, clean up sqlite paths, and fix async writes ([cc1f3d6](https://github.com/gronkanium/gronka/commit/cc1f3d671d452b39f449d05006ba262fe1de7b2a)) - [`_data/stats.json`](https://github.com/gronkanium/gronka/blob/HEAD/_data/stats.json), [`scripts/bot-start.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/bot-start.js), [`scripts/debug-postgres-queries.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/debug-postgres-queries.js), [`scripts/migrate-sqlite-to-postgres.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/migrate-sqlite-to-postgres.js), [`scripts/reset-postgres-sequences.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/reset-postgres-sequences.js) (+14 more)
- fix: ensure operation logs are flushed in tests ([5aee09e](https://github.com/gronkanium/gronka/commit/5aee09e3ff5fc0be6dff94261f0758e1b543e2e1)) - [`test/webui-server-operations.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/webui-server-operations.test.js)
- fix: add Docker daemon wait and retry logic for create-release pipeline ([4ba43aa](https://github.com/gronkanium/gronka/commit/4ba43aae06d94c1443733377eb9f1bbdc75bf7d7)) - [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml)
- fix: only rate limit users after successful operations ([75d06b3](https://github.com/gronkanium/gronka/commit/75d06b3b3f1a4b7032d37ebc450ea52999dd8bea)) - [`src/utils/rate-limit.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/rate-limit.js), [`test/utils/rate-limit.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/rate-limit.test.js)
- fix: add WSL2 mount error handling to Docker reload scripts ([d9b8408](https://github.com/gronkanium/gronka/commit/d9b8408b73a14863f53b45324e4054cf3b13096a)) - [`Dockerfile`](https://github.com/gronkanium/gronka/blob/HEAD/Dockerfile), [`eslint.config.js`](https://github.com/gronkanium/gronka/blob/HEAD/eslint.config.js), [`functions/api/stats.js`](https://github.com/gronkanium/gronka/blob/HEAD/functions/api/stats.js), [`scripts/backfill-operation-urls.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/backfill-operation-urls.js), [`scripts/docker-backfill-urls.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/docker-backfill-urls.js) (+8 more)
- fix: add improved Jekyll site update script with enhanced error handling ([61e3c27](https://github.com/gronkanium/gronka/commit/61e3c27f0b676277be2f7f10a9b22e387a95e694)) - [`scripts/update-jekyll-site.sh`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/update-jekyll-site.sh)
- fix: improve error handling in Jekyll site update script ([78f580e](https://github.com/gronkanium/gronka/commit/78f580e933f83bc4648d676513824832f94728fc)) - [`_data/stats.json`](https://github.com/gronkanium/gronka/blob/HEAD/_data/stats.json)
- fix: update user-stats script to use proper database utilities ([3688a95](https://github.com/gronkanium/gronka/commit/3688a956feae51007bfaf7bae0a9fdcdfbe0a4c4)) - [`scripts/user-stats.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/user-stats.js)
- docs: fix documentation inconsistencies from systematic review ([580054b](https://github.com/gronkanium/gronka/commit/580054b192bd383de9bfffc51387850b9b7c6598)) - [`CHANGELOG.md`](https://github.com/gronkanium/gronka/blob/HEAD/CHANGELOG.md), [`CONTRIBUTING.md`](https://github.com/gronkanium/gronka/blob/HEAD/CONTRIBUTING.md), [`README.md`](https://github.com/gronkanium/gronka/blob/HEAD/README.md), [`_docs/api-endpoints.md`](https://github.com/gronkanium/gronka/blob/HEAD/_docs/api-endpoints.md), [`_docs/configuration.md`](https://github.com/gronkanium/gronka/blob/HEAD/_docs/configuration.md) (+8 more)
- fix jekyll stats pipeline, gitignore backup file ([aa91aa4](https://github.com/gronkanium/gronka/commit/aa91aa4e045bb9bb9a76f124f4cd0c869759fe0b)) - [`.gitignore`](https://github.com/gronkanium/gronka/blob/HEAD/.gitignore), [`_data/stats.json`](https://github.com/gronkanium/gronka/blob/HEAD/_data/stats.json), [`_includes/footer.html`](https://github.com/gronkanium/gronka/blob/HEAD/_includes/footer.html), [`scripts/update-jekyll-stats.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/update-jekyll-stats.js)
- fix: convert pre-commit hook to LF line endings and allow committing hooks ([3da6687](https://github.com/gronkanium/gronka/commit/3da66871700cfd05b9d889adfe9d21177ad3e030)) - [`.gitignore`](https://github.com/gronkanium/gronka/blob/HEAD/.gitignore)
- fix: restore accidentally deleted blog post ([ffb79fb](https://github.com/gronkanium/gronka/commit/ffb79fbbbdf659482b0f3575f4b0f0ac1fc80625)) - [`_posts/2025-11-28-gronka-updates-quality-trimming-refactoring-deployment.md`](https://github.com/gronkanium/gronka/blob/HEAD/_posts/2025-11-28-gronka-updates-quality-trimming-refactoring-deployment.md)
- fix: quote YAML title in blog post to prevent parsing error ([c5b0259](https://github.com/gronkanium/gronka/commit/c5b025924a1250b36785aa08fc0ebe4ba3c16862)) - [`_posts/2025-11-28-gronka-updates-quality-trimming-refactoring-deployment.md`](https://github.com/gronkanium/gronka/blob/HEAD/_posts/2025-11-28-gronka-updates-quality-trimming-refactoring-deployment.md)
- docs: document all environment variables with TEST_ and PROD_ prefix support ([957a8e6](https://github.com/gronkanium/gronka/commit/957a8e6f8dca00fc7b292a16f60b418fd4010445)) - [`scripts/bot-start.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/bot-start.js), [`wiki/Configuration.md`](https://github.com/gronkanium/gronka/blob/HEAD/wiki/Configuration.md), [`wiki/Test-Bot.md`](https://github.com/gronkanium/gronka/blob/HEAD/wiki/Test-Bot.md)
- fix: convert remaining plain URLs to hyperlinks and standardize repository URLs ([94913b8](https://github.com/gronkanium/gronka/commit/94913b83e7fb05743524741508ed368df49455d6)) - [`_docs/logging-platform.md`](https://github.com/gronkanium/gronka/blob/HEAD/_docs/logging-platform.md), [`_docs/quick-start.md`](https://github.com/gronkanium/gronka/blob/HEAD/_docs/quick-start.md), [`wiki/Logging-Platform.md`](https://github.com/gronkanium/gronka/blob/HEAD/wiki/Logging-Platform.md)
- fix: convert plain URLs to hyperlinks in documentation ([877debb](https://github.com/gronkanium/gronka/commit/877debb0f298cac27112072b6978bfc2337ef35c)) - [`_docs/configuration.md`](https://github.com/gronkanium/gronka/blob/HEAD/_docs/configuration.md), [`_docs/docker.md`](https://github.com/gronkanium/gronka/blob/HEAD/_docs/docker.md), [`_docs/installation.md`](https://github.com/gronkanium/gronka/blob/HEAD/_docs/installation.md), [`wiki/Configuration.md`](https://github.com/gronkanium/gronka/blob/HEAD/wiki/Configuration.md), [`wiki/Docker-Deployment.md`](https://github.com/gronkanium/gronka/blob/HEAD/wiki/Docker-Deployment.md) (+1 more)

### Security

- Merge pull request #15 from gronkanium/dependabot/npm_and_yarn/security-updates-ca74dbbcdd ([762e5be](https://github.com/gronkanium/gronka/commit/762e5be82c625a8d2607bef24d1722c16b338369))
- deps(deps): bump the security-updates group with 4 updates ([006449b](https://github.com/gronkanium/gronka/commit/006449b27c52fe4686895d638ae0a9d59af99b7f)) - [`package-lock.json`](https://github.com/gronkanium/gronka/blob/HEAD/package-lock.json), [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json)
- Merge branch 'dependabot-security-updates-pr12' into 'main' ([8451703](https://github.com/gronkanium/gronka/commit/845170312ea6b11cf9d945862ade09a50940e30b))
- chore: apply dependabot security-updates from github pr #12 ([1a3f86b](https://github.com/gronkanium/gronka/commit/1a3f86b2ffd29383b84e8d616e02c2bbb53ee7d2)) - [`package-lock.json`](https://github.com/gronkanium/gronka/blob/HEAD/package-lock.json), [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json), [`test/utils/database.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/database.test.js), [`test/utils/log-metrics.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/log-metrics.test.js), [`test/utils/logger-sanitization.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/logger-sanitization.test.js) (+3 more)

## [Unreleased]

### Added

- refactor: update quality defaults to medium and add quality parameter to convert command ([5712e05](https://github.com/gronkanium/gronka/commit/5712e059e58d42fa52fed8bc1b09cd43d4e2f0dc)) - [`docker-compose.yml`](https://github.com/gronkanium/gronka/blob/HEAD/docker-compose.yml), [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json), [`src/commands/convert.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/convert.js), [`src/register-commands.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/register-commands.js), [`src/utils/config.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/config.js) (+2 more)
- feat: add JUnit test reports to GitLab CI and GitHub Actions ([94a163f](https://github.com/gronkanium/gronka/commit/94a163f0d764e37aed98fc939354332c2b1b2fe5)) - [`.github/workflows/ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.github/workflows/ci.yml), [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml), [`package-lock.json`](https://github.com/gronkanium/gronka/blob/HEAD/package-lock.json), [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json)
- Add test:clean script and reorder FFmpeg checks in video processor ([2e071cd](https://github.com/gronkanium/gronka/commit/2e071cd5714e55f76763c8e47c0cd63d20cabb11)) - [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json), [`scripts/test-clean.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/test-clean.js), [`src/utils/video-processor.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/video-processor.js)
- feat: add GIF trimming functionality to download command ([13f0a4d](https://github.com/gronkanium/gronka/commit/13f0a4d25f5493c400e9f42db5ed3f3ebc8c6f53)) - [`src/commands/download.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/download.js), [`src/utils/storage.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/storage.js), [`src/utils/video-processor.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/video-processor.js), [`test/utils/storage.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/storage.test.js), [`test/utils/video-processor.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/video-processor.test.js)
- test: add comprehensive tests for video and gif trimming functionality ([3348ce2](https://github.com/gronkanium/gronka/commit/3348ce2e29c57a3ce9055bac01e7121292f90f05)) - [`test/commands/convert.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/commands/convert.test.js), [`test/commands/download.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/commands/download.test.js)
- feat: add start_time and end_time parameters to /convert and /download commands ([5d11a15](https://github.com/gronkanium/gronka/commit/5d11a15b183ef92c9107e779b2b3fd01c7b38635)) - [`CHANGELOG.md`](https://github.com/gronkanium/gronka/blob/HEAD/CHANGELOG.md), [`_data/commands.yml`](https://github.com/gronkanium/gronka/blob/HEAD/_data/commands.yml), [`src/commands/convert.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/convert.js), [`src/commands/download.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/download.js), [`src/register-commands.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/register-commands.js) (+1 more)
- Merge pull request #10 from thedorekaczynski/feature/add-discord-footer-link ([32f365d](https://github.com/gronkanium/gronka/commit/32f365dbabc53df97f9a1799f2f730e067806b1d))
- feat: add clickable Discord server footer link to /info command embed with comprehensive community engagement enhancement for user support and feature request facilitation through seamless hyperlink integration in Discord embed footer text using markdown link syntax for optimal user experience and community interaction improvement ([00b39ce](https://github.com/gronkanium/gronka/commit/00b39ceb4682fb4851c611324224e2c1f932ba3c)) - [`src/commands/info.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/info.js)
- feat: implement comprehensive mobile responsive design system ([0c792a9](https://github.com/gronkanium/gronka/commit/0c792a9858ea4a6655256c8b7b0271664dda53ca)) - [`src/webui/App.svelte`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui/App.svelte), [`src/webui/components/ResponsiveCard.svelte`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui/components/ResponsiveCard.svelte), [`src/webui/components/ResponsiveFilterPanel.svelte`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui/components/ResponsiveFilterPanel.svelte), [`src/webui/components/ResponsiveGrid.svelte`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui/components/ResponsiveGrid.svelte), [`src/webui/components/ResponsiveSearchBar.svelte`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui/components/ResponsiveSearchBar.svelte) (+12 more)
- Revert " Remove deferred downloads feature\ ([cf834bb](https://github.com/gronkanium/gronka/commit/cf834bb751c8866cf0a5f005867ec92728d8efa9)) - [`CHANGELOG.md`](https://github.com/gronkanium/gronka/blob/HEAD/CHANGELOG.md), [`_posts/2025-11-20-cobalt-rate-limits.md`](https://github.com/gronkanium/gronka/blob/HEAD/_posts/2025-11-20-cobalt-rate-limits.md), [`src/bot.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/bot.js), [`src/commands/download.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/download.js), [`src/utils/cobalt.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/cobalt.js) (+6 more)
- Remove deferred downloads feature ([cfce4be](https://github.com/gronkanium/gronka/commit/cfce4be8cc088e0becb461ecf90561c94606b049)) - [`CHANGELOG.md`](https://github.com/gronkanium/gronka/blob/HEAD/CHANGELOG.md), [`_posts/2025-11-20-cobalt-rate-limits.md`](https://github.com/gronkanium/gronka/blob/HEAD/_posts/2025-11-20-cobalt-rate-limits.md), [`src/bot.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/bot.js), [`src/commands/download.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/download.js), [`src/utils/cobalt.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/cobalt.js) (+6 more)
- feat: add wiki sync script to sync local wiki to GitHub Wiki ([3a0bdc0](https://github.com/gronkanium/gronka/commit/3a0bdc016b47027f5e3580d4922926237cf95847)) - [`CONTRIBUTING.md`](https://github.com/gronkanium/gronka/blob/HEAD/CONTRIBUTING.md), [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json), [`scripts/convert-wiki-links.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/convert-wiki-links.js), [`scripts/sync-wiki-to-github.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/sync-wiki-to-github.js)
- feat: add cookie authentication support for cobalt restricted content ([7d4e73a](https://github.com/gronkanium/gronka/commit/7d4e73a926d57b5818aafb741970d5a0c92d5153)) - [`.gitignore`](https://github.com/gronkanium/gronka/blob/HEAD/.gitignore), [`cookies.example.json`](https://github.com/gronkanium/gronka/blob/HEAD/cookies.example.json), [`docker-compose.yml`](https://github.com/gronkanium/gronka/blob/HEAD/docker-compose.yml), [`wiki/Docker-Deployment.md`](https://github.com/gronkanium/gronka/blob/HEAD/wiki/Docker-Deployment.md)
- test: add comprehensive tests for operations tracker, deferred download notifier, and operations search APIs ([41efa19](https://github.com/gronkanium/gronka/commit/41efa19a3cbd1c315c1c31577ed22742f8aa4e7e)) - [`test/utils/deferred-download-notifier.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/deferred-download-notifier.test.js), [`test/utils/operations-tracker.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/operations-tracker.test.js), [`test/webui-server-operations.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/webui-server-operations.test.js)
- feat: add info-level logging for Discord uploads with URLs ([be55fb3](https://github.com/gronkanium/gronka/commit/be55fb35c5463baa524ab3ca85cc097c873f6615)) - [`src/bot.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/bot.js), [`src/commands/convert.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/convert.js), [`src/commands/download.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/download.js), [`src/commands/optimize.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/optimize.js), [`src/utils/deferred-download-notifier.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/deferred-download-notifier.js)
- feat: add pagination to moderation page user list and improve media pagination ([5eacce3](https://github.com/gronkanium/gronka/commit/5eacce348967cd484e7eb84675de24671f8bbbe9)) - [`src/webui/pages/Moderation.svelte`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui/pages/Moderation.svelte)
- feat: add r2 moderation system for managing user uploads ([bd1b72b](https://github.com/gronkanium/gronka/commit/bd1b72b4a94212a0692d8bc9903128a9a84697f6)) - [`src/utils/database.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database.js), [`src/utils/r2-storage.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/r2-storage.js), [`src/webui-server.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui-server.js), [`src/webui/App.svelte`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui/App.svelte), [`src/webui/pages/Moderation.svelte`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui/pages/Moderation.svelte)
- feat: add buffer size validation and lower video download limit to 100MB ([0cf5b11](https://github.com/gronkanium/gronka/commit/0cf5b11992d38085f359f3cf22aee86a7ef81daa)) - [`src/utils/cobalt.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/cobalt.js), [`src/utils/config.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/config.js), [`src/utils/file-downloader.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/file-downloader.js)
- feat: add anime girls to webui ([39196fb](https://github.com/gronkanium/gronka/commit/39196fbc4a30c3bb175d8d0a1098548bf4bc17fa)) - [`src/webui/assets/anime-girl-peek.png`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui/assets/anime-girl-peek.png), [`src/webui/assets/left-anime-girl-peek.png`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui/assets/left-anime-girl-peek.png)
- feat: add Discord upload support for cached GIFs ([727d179](https://github.com/gronkanium/gronka/commit/727d17976f3b6b7e8e24ad9c6bd368d28c087949)) - [`src/utils/r2-storage.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/r2-storage.js)
- swap blog post navigation: newer posts on left, older posts on right ([dd3efa2](https://github.com/gronkanium/gronka/commit/dd3efa25515cce0fa844a6e8b88dadbfc5175148)) - [`_layouts/post.html`](https://github.com/gronkanium/gronka/blob/HEAD/_layouts/post.html), [`assets/css/components.css`](https://github.com/gronkanium/gronka/blob/HEAD/assets/css/components.css)
- feat: add github issue templates ([9ef7c0f](https://github.com/gronkanium/gronka/commit/9ef7c0f5d801fc024b722da65d21653bd2fbabb2)) - [`.github/ISSUE_TEMPLATE/bug_report.md`](https://github.com/gronkanium/gronka/blob/HEAD/.github/ISSUE_TEMPLATE/bug_report.md), [`.github/ISSUE_TEMPLATE/config.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.github/ISSUE_TEMPLATE/config.yml), [`.github/ISSUE_TEMPLATE/feature_request.md`](https://github.com/gronkanium/gronka/blob/HEAD/.github/ISSUE_TEMPLATE/feature_request.md), [`.github/ISSUE_TEMPLATE/question.md`](https://github.com/gronkanium/gronka/blob/HEAD/.github/ISSUE_TEMPLATE/question.md), [`.prettierignore`](https://github.com/gronkanium/gronka/blob/HEAD/.prettierignore)

### Changed

- chore: update changelog with 100 commit(s) ([9708dd3](https://github.com/gronkanium/gronka/commit/9708dd302e16b0bc2eed54686f6b996d00f9f3a5)) - [`CHANGELOG.md`](https://github.com/gronkanium/gronka/blob/HEAD/CHANGELOG.md)
- Update README.md ([9e266ca](https://github.com/gronkanium/gronka/commit/9e266caeecc6723e15e9aad0eea58699097e6896)) - [`README.md`](https://github.com/gronkanium/gronka/blob/HEAD/README.md)
- refactor: break down database.js into modular structure ([0a576be](https://github.com/gronkanium/gronka/commit/0a576be095cfb2753d54eb3ae7207b9641c9ff11)) - [`CHANGELOG.md`](https://github.com/gronkanium/gronka/blob/HEAD/CHANGELOG.md), [`src/utils/database.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database.js), [`src/utils/database/alerts.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database/alerts.js), [`src/utils/database/connection.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database/connection.js), [`src/utils/database/init.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database/init.js) (+6 more)
- refactor: break down database.js into modular structure ([321a7f5](https://github.com/gronkanium/gronka/commit/321a7f5a92d0ab27dd6bfe69f98e1bf35722e3ab)) - [`CHANGELOG.md`](https://github.com/gronkanium/gronka/blob/HEAD/CHANGELOG.md), [`src/utils/database.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database.js), [`src/utils/database/alerts.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database/alerts.js), [`src/utils/database/connection.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database/connection.js), [`src/utils/database/init.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/database/init.js) (+6 more)
- refactor: migrate docker scripts from shell to node.js ([8e35485](https://github.com/gronkanium/gronka/commit/8e3548502335fe7f4682b3a07c35c3394b68ccb7)) - [`.env.example`](https://github.com/gronkanium/gronka/blob/HEAD/.env.example), [`TODO.md`](https://github.com/gronkanium/gronka/blob/HEAD/TODO.md), [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json), [`scripts/docker-copy-webui.sh`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/docker-copy-webui.sh), [`scripts/docker-rebuild-webui.sh`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/docker-rebuild-webui.sh) (+8 more)
- refactor: convert docker scripts to pure Node.js for cross-platform compatibility ([ccf5ed0](https://github.com/gronkanium/gronka/commit/ccf5ed083421f1b77810933a39490357f448cad0)) - [`scripts/docker-copy-webui.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/docker-copy-webui.js), [`scripts/docker-copy-webui.ps1`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/docker-copy-webui.ps1), [`scripts/docker-rebuild-webui.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/docker-rebuild-webui.js), [`scripts/docker-rebuild-webui.ps1`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/docker-rebuild-webui.ps1), [`scripts/docker-reload-fast.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/docker-reload-fast.js) (+10 more)
- chore: prepare 0.12.5 stable release ([e91cbcd](https://github.com/gronkanium/gronka/commit/e91cbcd89e365c16a30820496a6f006d5faf49c0)) - [`CHANGELOG.md`](https://github.com/gronkanium/gronka/blob/HEAD/CHANGELOG.md), [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json), [`test/commands/convert.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/commands/convert.test.js), [`test/utils/config.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/config.test.js), [`test/utils/video-processor.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/video-processor.test.js)
- chore: ignore update script and config directory in git ([18ed7a8](https://github.com/gronkanium/gronka/commit/18ed7a866e0cb98fad23a9d6058acdc888a0e4cd)) - [`.gitignore`](https://github.com/gronkanium/gronka/blob/HEAD/.gitignore)
- Update .gitlab-ci.yml file ([80d9408](https://github.com/gronkanium/gronka/commit/80d94088446611c6f9739c279416552c453d12c9)) - [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml)
- Update .gitlab-ci.yml file ([ed5342a](https://github.com/gronkanium/gronka/commit/ed5342a3e22d4103f186fffb45b2b38210cecad3)) - [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml)
- Update .gitlab-ci.yml file ([5dd0223](https://github.com/gronkanium/gronka/commit/5dd0223f66074d894dd8fd6769e84471e872b130)) - [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml)
- Merge pull request #11 from thedorekaczynski/sync/gitlab-to-github-commits ([c5dfd48](https://github.com/gronkanium/gronka/commit/c5dfd4842d9adb539a7253295557bbe8379c4a9d))
- chore: bump version to 0.12.4 and update changelog ([13e24ff](https://github.com/gronkanium/gronka/commit/13e24ff2e4c7dd71732a0b89514537fb6e3afef4)) - [`CHANGELOG.md`](https://github.com/gronkanium/gronka/blob/HEAD/CHANGELOG.md), [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json)
- ci: restructure GitHub Actions to match GitLab CI stages and test segmentation ([c81e347](https://github.com/gronkanium/gronka/commit/c81e3475a56981a5a9a643f06ea54cc23c5cc93a)) - [`.github/workflows/ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.github/workflows/ci.yml)
- ci: enhance gitlab ci with multiple descriptive stages ([8608307](https://github.com/gronkanium/gronka/commit/8608307cdcfa9b31aa58c879555cc994907fc89e)) - [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml)
- Update .gitlab-ci.yml file ([200d312](https://github.com/gronkanium/gronka/commit/200d312fabbac97e79fbf7c6917eb7b9e20a7ac4)) - [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml)
- Merge branch 'refactor/cleanup-unused-code' into 'main' ([085b866](https://github.com/gronkanium/gronka/commit/085b8668690c11fb97e34ed2b93b7db0e6ec5082))
- refactor: replace MAX_GIF_WIDTH and DEFAULT_FPS with GIF_QUALITY preset system ([f8ceaee](https://github.com/gronkanium/gronka/commit/f8ceaeef69670ebbab5df3e1146374ee9ee4600a)) - [`.env.example`](https://github.com/gronkanium/gronka/blob/HEAD/.env.example), [`.gitignore`](https://github.com/gronkanium/gronka/blob/HEAD/.gitignore), [`Dockerfile`](https://github.com/gronkanium/gronka/blob/HEAD/Dockerfile), [`docker-compose.dev.yml`](https://github.com/gronkanium/gronka/blob/HEAD/docker-compose.dev.yml), [`scripts/migrate-gifs-to-r2.js`](https://github.com/gronkanium/gronka/blob/HEAD/scripts/migrate-gifs-to-r2.js) (+5 more)
- improve webui layout with max-width constraints and better responsive design ([eb91060](https://github.com/gronkanium/gronka/commit/eb91060e5dab1ee43074c5fc76fd30307065278a)) - [`CHANGELOG.md`](https://github.com/gronkanium/gronka/blob/HEAD/CHANGELOG.md), [`src/webui/App.svelte`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui/App.svelte), [`src/webui/components/ResponsiveCard.svelte`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui/components/ResponsiveCard.svelte), [`src/webui/components/ResponsiveTable.svelte`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui/components/ResponsiveTable.svelte), [`src/webui/pages/Health.svelte`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui/pages/Health.svelte) (+6 more)
- refactor: rename CI/CD test jobs to ci-pipeline ([9029a73](https://github.com/gronkanium/gronka/commit/9029a7310dd0b9324f751bf829688717c62c2493)) - [`.github/workflows/ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.github/workflows/ci.yml), [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml)
- ync badges between jekyll site and readme ([7f61b88](https://github.com/gronkanium/gronka/commit/7f61b88e2eb42d18b38e313cf5f29adc83811dc9)) - [`CHANGELOG.md`](https://github.com/gronkanium/gronka/blob/HEAD/CHANGELOG.md), [`README.md`](https://github.com/gronkanium/gronka/blob/HEAD/README.md), [`index.md`](https://github.com/gronkanium/gronka/blob/HEAD/index.md)
- chore: bump version to 0.12.3-beta and update changelog ([c17d30f](https://github.com/gronkanium/gronka/commit/c17d30f1d76f5dab0360b8cf0c1fd28a304b9ac7)) - [`CHANGELOG.md`](https://github.com/gronkanium/gronka/blob/HEAD/CHANGELOG.md), [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json)
- limit how far it goes or something idk ([9a908ab](https://github.com/gronkanium/gronka/commit/9a908ab3d1ff5dc9a9a0e54b0146b48983a5699f)) - [`src/webui/pages/Alerts.svelte`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui/pages/Alerts.svelte)
- chore: ignore build artifact src/public/index.html ([2db8d4f](https://github.com/gronkanium/gronka/commit/2db8d4f46968205195ae506626b0a4b57301ad31)) - [`.gitignore`](https://github.com/gronkanium/gronka/blob/HEAD/.gitignore), [`src/public/index.html`](https://github.com/gronkanium/gronka/blob/HEAD/src/public/index.html)
- chore: complete merge ([2312274](https://github.com/gronkanium/gronka/commit/23122740c37727833fd9a48aaf2564a751c7f5a9))
- update github url ([b662176](https://github.com/gronkanium/gronka/commit/b6621764ea4789a4d53a2a8ea96dd228bbfb17c8)) - [`index.md`](https://github.com/gronkanium/gronka/blob/HEAD/index.md)
- chore: bump version to 0.12.2-beta and update changelog ([70a85c7](https://github.com/gronkanium/gronka/commit/70a85c70402a19a00a73a8f75c39d2c389244142)) - [`CHANGELOG.md`](https://github.com/gronkanium/gronka/blob/HEAD/CHANGELOG.md), [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json)
- chore: update webui build artifacts ([67adf82](https://github.com/gronkanium/gronka/commit/67adf82e97effe8ba86b6df39a9aa3fde5f0e3bd)) - [`src/public/index.html`](https://github.com/gronkanium/gronka/blob/HEAD/src/public/index.html)
- improve: enhance operations tracking with multi-instance support and better logging ([688cf08](https://github.com/gronkanium/gronka/commit/688cf08c4276d27c44336d94f0f34396f1950fee)) - [`src/utils/operations-tracker.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/operations-tracker.js)
- change: update default quality from medium to high ([0f7db66](https://github.com/gronkanium/gronka/commit/0f7db66efafc204bcc0f1b496e3311651d10b101)) - [`src/commands/config.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/config.js), [`src/commands/convert.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/convert.js), [`src/commands/optimize.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/optimize.js), [`src/public/index.html`](https://github.com/gronkanium/gronka/blob/HEAD/src/public/index.html), [`src/utils/gif-optimizer.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/gif-optimizer.js) (+8 more)
- improve: optimize pre-commit hook to only check staged files ([7052879](https://github.com/gronkanium/gronka/commit/7052879efdd00c3b04c338334aaf33e2539ad91c)) - [`.husky/pre-commit`](https://github.com/gronkanium/gronka/blob/HEAD/.husky/pre-commit)
- improve gif quality: use floyd-steinberg dithering and better palette generation ([2aeaca5](https://github.com/gronkanium/gronka/commit/2aeaca584aa2b03fd14678edeee57805b5420b4b)) - [`src/commands/convert.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/convert.js), [`src/utils/video-processor.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/video-processor.js)
- chore: bump version to 0.12.1-beta and update changelog ([c08b4d4](https://github.com/gronkanium/gronka/commit/c08b4d4c9c01bd0888800838cdba05cf462d3cff)) - [`CHANGELOG.md`](https://github.com/gronkanium/gronka/blob/HEAD/CHANGELOG.md), [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json), [`src/utils/cobalt.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/cobalt.js)
- refactor: reorganize webui files into structured folders ([ee67494](https://github.com/gronkanium/gronka/commit/ee6749435b996baeb19c771f6fcb93169c01b51f)) - [`src/webui/Alerts.svelte`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui/Alerts.svelte), [`src/webui/App.svelte`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui/App.svelte), [`src/webui/App.test.svelte`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui/App.test.svelte), [`src/webui/Health.svelte`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui/Health.svelte), [`src/webui/Logs.svelte`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui/Logs.svelte) (+25 more)
- chore: update repository references from p2xai to thedorekaczynski ([c20772e](https://github.com/gronkanium/gronka/commit/c20772ef71e2a7720cfb9a2dc61649dad89a26e5)) - [`_posts/2025-11-18-welcome.md`](https://github.com/gronkanium/gronka/blob/HEAD/_posts/2025-11-18-welcome.md), [`_posts/2025-11-19-gronka-ethos.md`](https://github.com/gronkanium/gronka/blob/HEAD/_posts/2025-11-19-gronka-ethos.md), [`_posts/2025-11-20-cobalt-rate-limits.md`](https://github.com/gronkanium/gronka/blob/HEAD/_posts/2025-11-20-cobalt-rate-limits.md), [`_posts/2025-11-21-convert-command-bug-fix.md`](https://github.com/gronkanium/gronka/blob/HEAD/_posts/2025-11-21-convert-command-bug-fix.md), [`_posts/2025-11-22-gronka-0.9.0-release.md`](https://github.com/gronkanium/gronka/blob/HEAD/_posts/2025-11-22-gronka-0.9.0-release.md) (+3 more)
- Merge branch 'main' of https://github.com/p2xai/gronka ([bf8fe08](https://github.com/gronkanium/gronka/commit/bf8fe08579a9159d1c4f4d5f294606c93d8a5725))
- Merge pull request #8 from thedorekaczynski/dependabot/npm_and_yarn/body-parser-2.2.1 ([3b1d15f](https://github.com/gronkanium/gronka/commit/3b1d15f184837f5ecb2adb650d3dbe523f74acbf))

### Removed

- chore: remove badges, update changelog ([c20f852](https://github.com/gronkanium/gronka/commit/c20f8527b633d90d632b2fd2c1884fecf8799d5c)) - [`CHANGELOG.md`](https://github.com/gronkanium/gronka/blob/HEAD/CHANGELOG.md), [`index.md`](https://github.com/gronkanium/gronka/blob/HEAD/index.md)
- remove test reporting from GitHub CI workflows ([6974e96](https://github.com/gronkanium/gronka/commit/6974e96378650dd2252d8a2a4e1b12473e892ba2)) - [`.github/workflows/ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.github/workflows/ci.yml)
- remove all deferred queue functionality ([cfce53e](https://github.com/gronkanium/gronka/commit/cfce53e408d04c710076e63687bad2d25d5c78da)) - [`src/bot.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/bot.js), [`src/commands/download.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/download.js), [`src/utils/cobalt.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/cobalt.js), [`src/utils/deferred-download-notifier.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/deferred-download-notifier.js), [`src/utils/deferred-download-queue.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/deferred-download-queue.js) (+2 more)
- delete wiki-repo delete wiki-repo ([ef316ab](https://github.com/gronkanium/gronka/commit/ef316ab0c665e6a05eff32a499050d101d67f430)) - [`wiki-repo`](https://github.com/gronkanium/gronka/blob/HEAD/wiki-repo)

### Fixed

- fix: prevent cache from returning wrong file type in download command ([eef90b3](https://github.com/gronkanium/gronka/commit/eef90b3f7db2f2c830c8f6675ea7980608df4094)) - [`src/commands/download.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/download.js), [`src/utils/cobalt-queue.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/cobalt-queue.js)
- style: fix prettier formatting issues ([dfbbc0e](https://github.com/gronkanium/gronka/commit/dfbbc0e745397ac580dd4e0f305ed09800b43bc2)) - [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml), [`test/utils/config.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/config.test.js), [`test/utils/video-processor.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/video-processor.test.js)
- fix: add enhanced debugging and TAP file artifacts for test jobs ([cb7f3b2](https://github.com/gronkanium/gronka/commit/cb7f3b22daec77a78531d12c85e5acfbff0313d8)) - [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml)
- fix: capture both stdout and stderr in test jobs for gitlab test reports ([97f065e](https://github.com/gronkanium/gronka/commit/97f065e5725dc84aaf344dcb83da1c3c8e3ebba0)) - [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml)
- fix: format .gitlab-ci.yml with prettier ([66246be](https://github.com/gronkanium/gronka/commit/66246be228f1ec72e216c1fbdb5ee84800b799b5)) - [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml)
- fix: simplify XML validation to avoid Prettier YAML parsing errors ([c93fd1a](https://github.com/gronkanium/gronka/commit/c93fd1a46c681c70f72a007fcf86369f800b6f6e)) - [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml)
- debug: add detailed logging to diagnose tap-junit conversion issues ([f7e6ab7](https://github.com/gronkanium/gronka/commit/f7e6ab71f38121d4db9850a9e411a1ba02b3fc0d)) - [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml)
- fix: preserve valid JUnit XML files in GitLab CI test reporting ([2ce050b](https://github.com/gronkanium/gronka/commit/2ce050ba2c65f7e8f38179d7818eafd94b846eb5)) - [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml)
- fix: handle tap-junit creating directories instead of files in GitLab CI ([6aad278](https://github.com/gronkanium/gronka/commit/6aad278e5f81361be444c901b317bbd7a623a6da)) - [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml)
- fix: remove directory before creating test report XML files ([91a83a2](https://github.com/gronkanium/gronka/commit/91a83a2193368325e653df3ce0f155a7502ab08d)) - [`.github/workflows/ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.github/workflows/ci.yml)
- fix: ensure test report XML files are created as regular files ([4542d6c](https://github.com/gronkanium/gronka/commit/4542d6c20077119e40c4b70661a32a837c2ac281)) - [`.github/workflows/ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.github/workflows/ci.yml), [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml)
- fix: address code scanning issues ([88c9546](https://github.com/gronkanium/gronka/commit/88c95466f43cf3cbe53216d22e9ffab0af767e74)) - [`.github/workflows/ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.github/workflows/ci.yml), [`src/utils/operations-tracker.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/operations-tracker.js), [`test/utils/race-conditions.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/race-conditions.test.js)
- fix: ensure test report XML files always exist for CI ([bf69778](https://github.com/gronkanium/gronka/commit/bf69778f8226a96fd8478e31681e78ae3d889ca4)) - [`.github/workflows/ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.github/workflows/ci.yml), [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml)
- fix: remove unused imports in race-conditions test ([b53dacb](https://github.com/gronkanium/gronka/commit/b53dacbd91ebcb45777d186a7b96d3c0dca11640)) - [`src/commands/convert.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/convert.js), [`src/commands/download.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/download.js), [`src/commands/info.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/info.js), [`src/commands/optimize.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/optimize.js), [`src/commands/stats.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/stats.js) (+10 more)
- fix: remove useless treatAsGif conditionals flagged by GitHub Advanced Security ([b60bd69](https://github.com/gronkanium/gronka/commit/b60bd69c3021ae0e9c0ed5d025eaf36876d57320)) - [`src/commands/download.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/download.js)
- ci: use npx cross-env in test jobs to fix command not found error ([d0ff237](https://github.com/gronkanium/gronka/commit/d0ff237e19db3369b1bd0a377799de7e0482472d)) - [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml)
- ci: remove artifacts from setup job to fix pipeline failure ([7f38afa](https://github.com/gronkanium/gronka/commit/7f38afa7e3ddc58bf1e97da4ab20c67c8da83322)) - [`.gitlab-ci.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.gitlab-ci.yml)
- refactor: cleanup unused code and fix configuration inconsistencies ([014338f](https://github.com/gronkanium/gronka/commit/014338f6791f5c91ff9c9cf18d3964d330a3dd75)) - [`src/commands/convert.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/convert.js), [`src/utils/config.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/config.js), [`src/webui-server.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui-server.js)
- fix: update docker to use data-prod directories and fix storage directory creation ([0412556](https://github.com/gronkanium/gronka/commit/0412556f820f2420509ba23d621347766db77f31)) - [`CHANGELOG.md`](https://github.com/gronkanium/gronka/blob/HEAD/CHANGELOG.md), [`Dockerfile`](https://github.com/gronkanium/gronka/blob/HEAD/Dockerfile), [`docker-compose.yml`](https://github.com/gronkanium/gronka/blob/HEAD/docker-compose.yml), [`package.json`](https://github.com/gronkanium/gronka/blob/HEAD/package.json), [`src/server.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/server.js)
- fix: video trimming and file type cache validation issues ([5c20e9c](https://github.com/gronkanium/gronka/commit/5c20e9c472e64391d50117116f3cb8fb7d948e22)) - [`src/commands/convert.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/convert.js), [`src/commands/download.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/download.js), [`src/commands/optimize.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/optimize.js), [`src/utils/cobalt-queue.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/cobalt-queue.js), [`src/utils/video-processor.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/video-processor.js)
- fix: implement video trimming in download command ([fccaf23](https://github.com/gronkanium/gronka/commit/fccaf2360c840553e175b5eebf3ce5e956d79cef)) - [`src/commands/download.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/download.js), [`src/utils/video-processor.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/video-processor.js)
- fix: fix operations tracker test failures - fix duration calculation test and variable initialization order ([4c354b9](https://github.com/gronkanium/gronka/commit/4c354b9132e6ff63f528b7bebbe2c3aa9689c9cd)) - [`test/utils/operations-tracker.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/operations-tracker.test.js)
- fix: replace footer with field for clickable Discord link in /info command ([011d347](https://github.com/gronkanium/gronka/commit/011d347c0bd6f822482afe3bcd50a7cccfb9262b)) - [`src/commands/info.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/info.js)
- fix: replace insecure URL validation in test with proper parsing and exclude test files from CodeQL ([449667f](https://github.com/gronkanium/gronka/commit/449667f0990f474814ee4d2ad08509a9472db8cc)) - [`.github/workflows/codeql.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.github/workflows/codeql.yml), [`test/utils/deferred-download-notifier.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/deferred-download-notifier.test.js)
- refactor: improve pre-commit hook to auto-fix formatting and linting ([83be91f](https://github.com/gronkanium/gronka/commit/83be91f86a829614c258521b96b0354ad4de4b71)) - [`.husky/pre-commit`](https://github.com/gronkanium/gronka/blob/HEAD/.husky/pre-commit)
- fix: update database with Discord URL when files uploaded to Discord ([640fab7](https://github.com/gronkanium/gronka/commit/640fab756f83148c687461597abe8c899454ab36)) - [`src/bot.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/bot.js), [`src/commands/download.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/download.js), [`src/commands/optimize.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/optimize.js)
- fix: ensure operation duration is always at least 1ms ([1245605](https://github.com/gronkanium/gronka/commit/1245605b66771fee18a5123f002543b803d1b05a)) - [`src/utils/operations-tracker.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/operations-tracker.js)
- fix: add delay to error status test to ensure duration is calculated ([3d87803](https://github.com/gronkanium/gronka/commit/3d87803a9ae79605b44faad20ab200a6661c8c13)) - [`test/utils/operations-tracker.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/operations-tracker.test.js)
- fix: correct test mocks for Discord.js Collection API and duration assertion ([b1f3525](https://github.com/gronkanium/gronka/commit/b1f352552089ad6f6c01d1b7e4a8779da0e21d6b)) - [`test/utils/deferred-download-notifier.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/deferred-download-notifier.test.js), [`test/utils/operations-tracker.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/operations-tracker.test.js)
- fix: update video size limit tests to use 100MB instead of outdated 500MB ([b1f3506](https://github.com/gronkanium/gronka/commit/b1f350659ddb182d33804f47793e3048c469f1d9)) - [`src/utils/attachment-helpers.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/attachment-helpers.js), [`test/utils/attachment-helpers.test.js`](https://github.com/gronkanium/gronka/blob/HEAD/test/utils/attachment-helpers.test.js)
- fix: only save R2 URLs to database when files are actually uploaded to R2, capture Discord attachment URLs for tracking, reduce log verbosity ([4f62d28](https://github.com/gronkanium/gronka/commit/4f62d2829fa2ed3e5b7e9d2710f5f031766203bb)) - [`src/commands/convert.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/convert.js), [`src/utils/operations-tracker.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/operations-tracker.js)
- feat: add operations search and debug page, improve WebUI styling ([d4cc03d](https://github.com/gronkanium/gronka/commit/d4cc03d112c52ba1db446759b9d61c77c83efca7)) - [`src/webui-server.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui-server.js)
- fix: remove stats_mode=single from palettegen to fix compatibility issues ([0400b9e](https://github.com/gronkanium/gronka/commit/0400b9e98ceeca540243224b5d7be9d7f0b72145)) - [`src/utils/video-processor.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/video-processor.js)
- fix: suppress CodeQL false positives for log injection and network-to-file alerts ([16995c5](https://github.com/gronkanium/gronka/commit/16995c5c279415e4271906bb48319a78f08ab1bd)) - [`.github/codeql-config.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.github/codeql-config.yml), [`.github/workflows/codeql.yml`](https://github.com/gronkanium/gronka/blob/HEAD/.github/workflows/codeql.yml), [`src/commands/convert.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/convert.js), [`src/commands/optimize.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/optimize.js), [`src/utils/logger.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/logger.js)
- fix: apply CodeQL-recognized sanitization patterns for log injection ([4e93bc4](https://github.com/gronkanium/gronka/commit/4e93bc4287c7009110532394a3717fd079f0a96e)) - [`src/commands/convert.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/convert.js), [`src/commands/optimize.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/optimize.js), [`src/utils/logger.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/logger.js), [`src/webui/stores/websocket-store.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui/stores/websocket-store.js)
- fix: resolve CodeQL security issues - log injection and network data validation ([69e41fa](https://github.com/gronkanium/gronka/commit/69e41faec177fdab373765136000a7294aa5a026)) - [`src/commands/convert.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/convert.js), [`src/commands/optimize.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/optimize.js), [`src/utils/logger.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/logger.js), [`src/webui/websocket-store.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui/websocket-store.js)
- fix: resolve CodeQL security vulnerabilities and warnings ([767cee6](https://github.com/gronkanium/gronka/commit/767cee607ac4fb947d835c08d2c678e6e9da1a17)) - [`src/commands/convert.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/convert.js), [`src/commands/optimize.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/commands/optimize.js), [`src/utils/gif-optimizer.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/gif-optimizer.js), [`src/utils/logger.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/utils/logger.js), [`src/webui/websocket-store.js`](https://github.com/gronkanium/gronka/blob/HEAD/src/webui/websocket-store.js)
