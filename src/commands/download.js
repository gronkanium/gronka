/**
 * Download command - Re-exports from modular structure
 *
 * This file maintains backward compatibility with existing imports.
 * The implementation has been refactored into the download/ directory:
 *
 * - download/handlers.js      - Discord command handlers
 * - download/process-download.js - Main orchestration
 * - download/process-single.js   - Single file processing
 * - download/process-picker.js   - Multiple file handling
 * - download/trimming.js         - Video/GIF trimming
 * - download/upload.js           - Upload strategy and execution
 * - download/utils.js            - Shared utilities
 */

export { handleDownloadCommand, handleDownloadContextMenuCommand } from './download/index.js';
