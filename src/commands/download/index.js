/**
 * Download command module
 *
 * This module handles downloading media from social media platforms.
 * It supports:
 * - Twitter/X, TikTok, Instagram, YouTube, Reddit, Facebook, Threads
 * - Video trimming via start_time/end_time parameters
 * - GIF trimming
 * - Multiple media files from picker responses
 * - Caching of processed URLs
 * - R2 and Discord attachment uploads
 */

// Main exports for bot.js
export { handleDownloadCommand, handleDownloadContextMenuCommand } from './handlers.js';

// Internal exports for testing
export { processDownload } from './process-download.js';
export { processSingleFile } from './process-single.js';
export { processPickerResponse } from './process-picker.js';
export { trimGifFile, trimVideoFile, trimVideoAsGif, needsTrimming } from './trimming.js';
export {
  calculateUploadDestinations,
  reuploadToR2,
  sendMultipleMedia,
  sendSingleFileToDiscord,
  buildFileUrl,
} from './upload.js';
export { cleanupTempFiles, buildMetadata, getCdnPath, DOWNLOAD_LIMITS } from './utils.js';
