/**
 * Shared utilities for download command
 */
import fs from 'fs/promises';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('download');

/**
 * Clean up temporary files and directory
 * @param {Object} tmpDir - tmp directory object with removeCallback
 * @param {string[]} files - Array of file paths to delete
 */
export async function cleanupTempFiles(tmpDir, files = []) {
  for (const file of files) {
    try {
      await fs.unlink(file);
    } catch {
      // File may not exist, ignore
    }
  }
  try {
    tmpDir.removeCallback();
  } catch (cleanupError) {
    logger.warn(`Failed to clean up temp directory: ${cleanupError.message}`);
  }
}

/**
 * Build metadata object for R2 uploads
 * @param {string} userId - Discord user ID
 * @param {string} username - Discord username
 * @returns {Object} Metadata object
 */
export function buildMetadata(userId, username) {
  return {
    'user-id': userId,
    'upload-timestamp': new Date().toISOString(),
    'operation-type': 'download',
    username: username,
  };
}

/**
 * Get CDN path prefix based on file type
 * @param {string} fileType - File type ('gif', 'video', 'image')
 * @returns {string} CDN path prefix
 */
export function getCdnPath(fileType) {
  switch (fileType) {
    case 'video':
      return '/videos';
    case 'image':
      return '/images';
    case 'gif':
    default:
      return '/gifs';
  }
}

/**
 * Constants for download limits
 */
export const DOWNLOAD_LIMITS = {
  /** Maximum duration for non-admin YouTube downloads (3 minutes) */
  MAX_YOUTUBE_DURATION: 180,
};
