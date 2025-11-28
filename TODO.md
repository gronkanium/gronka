## creating issue template for github - DONE

need to create issue templates in `.github/ISSUE_TEMPLATE/` directory. should include templates for bug reports, feature requests, and possibly documentation updates. templates should guide users to provide relevant information like steps to reproduce, expected vs actual behavior, environment details, and version information.

## creating wiki for github - DONE

need to set up github wiki pages covering key topics like installation, configuration, usage examples, api documentation, troubleshooting common issues, and development setup. wiki should be comprehensive enough for users to understand how to use and contribute to gronka.

## make proper documentation thats up to date - DONE

current documentation needs review and updates. should ensure readme.md is accurate, setup instructions work, configuration options are documented, and any recent changes are reflected. may need to add missing documentation for features that were added but not documented.

## fix tool bar in logs (sucks bad) - DONE-ish

the filter toolbar in `src/webui/Logs.svelte` has usability and layout issues. the filters section with component filters, level toggles, search, time range, and export buttons needs improvement. likely needs better responsive design, clearer organization, and possibly a collapsible or more compact layout to reduce clutter.

## refactor monolithic files into modular structure

several utility files have grown too large and should be broken down into smaller, focused modules organized in appropriate subdirectories. this will improve maintainability, testability, and code organization.

### primary targets

- **`src/utils/database.js`** (1947 lines) - break into separate modules for different database concerns:
  - `src/utils/database/logs.js` - log-related operations (insertLog, getLogs, getLogsCount, getLogComponents, getLogMetrics)
  - `src/utils/database/users.js` - user-related operations (insertOrUpdateUser, getUser, getUniqueUserCount)
  - `src/utils/database/processed-urls.js` - processed URL operations (getProcessedUrl, insertProcessedUrl, getUserMedia, getUserR2Media, deleteProcessedUrl, deleteUserR2Media)
  - `src/utils/database/operations.js` - operation tracking (insertOperationLog, getOperationLogs, getOperationTrace, getRecentOperations, getStuckOperations, markOperationAsFailed)
  - `src/utils/database/metrics.js` - metrics operations (insertOrUpdateUserMetrics, getUserMetrics, getAllUsersMetrics, insertSystemMetrics, getSystemMetrics)
  - `src/utils/database/alerts.js` - alert operations (insertAlert, getAlerts, getAlertsCount)
  - `src/utils/database/init.js` - database initialization and connection management (initDatabase, closeDatabase, getDbPath, ensureDataDir)
  - keep main `src/utils/database.js` as a barrel export that re-exports from submodules for backward compatibility

- **`test/utils/video-processor.test.js`** (662 lines) - split into separate test files for different function groups:
  - `test/utils/video-processor/convert-to-gif.test.js` - tests for convertToGif function
  - `test/utils/video-processor/trim-video.test.js` - tests for trimVideo function
  - `test/utils/video-processor/trim-gif.test.js` - tests for trimGif function

### secondary targets (consider for future refactoring)

- **`src/utils/storage.js`** (1138 lines) - could be split into file path utilities, cleanup operations, and storage validation
- **`src/utils/operations-tracker.js`** (657 lines) - could be split into operation creation, status tracking, and cleanup operations
- **`src/utils/cobalt.js`** (639 lines) - could be split into API client, queue management, and response handling

### implementation approach

- maintain backward compatibility by keeping main files as barrel exports during transition
- update all import statements across codebase to use new module paths
- ensure test coverage is maintained after refactoring
- organize modules in logical subdirectories relative to their parent utility file
- each module should have a single, clear responsibility
