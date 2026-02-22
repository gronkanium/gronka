import { createLogger } from './logger.js';
import { getProcessedUrl } from './database.js';
import { initDatabase } from './database.js';
import { hashStringHex } from './hashing.js';

const logger = createLogger('cobalt-queue');

// Track in-progress downloads by URL hash
const inProgressDownloads = new Map();

/**
 * Generate hash for URL to use as deduplication key
 * @param {string} url - URL to hash
 * @returns {string} URL hash
 */
export function hashUrl(url) {
  return hashStringHex(url);
}

/**
 * Normalize conversion options to include only explicitly provided parameters
 * Filters out undefined, null, and default values for consistent hashing
 * @param {Object} options - Conversion options object
 * @returns {Object} Normalized options object with only explicitly provided parameters
 */
function normalizeConversionOptions(options) {
  if (!options || typeof options !== 'object') {
    return {};
  }

  const normalized = {};

  // Only include explicitly provided parameters (non-undefined, non-null)
  // Parameters that affect output quality/size:
  if (options.quality !== undefined && options.quality !== null) {
    normalized.quality = String(options.quality);
  }
  if (options.optimize !== undefined && options.optimize !== null) {
    normalized.optimize = Boolean(options.optimize);
  }
  if (options.lossy !== undefined && options.lossy !== null) {
    normalized.lossy = Number(options.lossy);
  }
  if (options.startTime !== undefined && options.startTime !== null) {
    normalized.startTime = Number(options.startTime);
  }
  if (options.duration !== undefined && options.duration !== null) {
    normalized.duration = Number(options.duration);
  }
  if (options.width !== undefined && options.width !== null) {
    normalized.width = Number(options.width);
  }
  if (options.fps !== undefined && options.fps !== null) {
    normalized.fps = Number(options.fps);
  }

  return normalized;
}

/**
 * Generate composite hash for URL with conversion parameters
 * Creates a cache key that includes both URL and explicitly provided conversion parameters
 * @param {string} url - URL to hash
 * @param {Object} [options] - Conversion options object (quality, optimize, lossy, startTime, duration, width, fps)
 * @returns {string} Composite hash combining URL and parameters
 */
export function hashUrlWithParams(url, options = {}) {
  const normalized = normalizeConversionOptions(options);

  // If no parameters provided, use URL-only hash for backward compatibility
  if (Object.keys(normalized).length === 0) {
    return hashUrl(url);
  }

  // Sort parameter keys for consistent hashing regardless of object key order
  const sortedKeys = Object.keys(normalized).sort();
  const paramsString = sortedKeys.map(key => `${key}:${normalized[key]}`).join('|');

  // Create composite hash: URL + parameters
  const compositeString = `${url}|${paramsString}`;
  return hashStringHex(compositeString);
}

/**
 * Queue a Cobalt download request with URL deduplication
 * @param {string} url - URL to download
 * @param {Function} downloadFn - Async function that performs the actual download
 * @param {Object} [options] - Optional parameters
 * @param {boolean} [options.skipCache] - Skip URL cache check (useful when trimming/modifying the result)
 * @param {string} [options.expectedFileType] - Expected file type ('video', 'gif', 'image'). If provided, only use cache if file type matches
 * @returns {Promise} Promise that resolves with download result
 */
export async function queueCobaltRequest(url, downloadFn, options = {}) {
  const { skipCache = false, expectedFileType = null } = options;
  const urlHash = hashUrl(url);

  // Initialize database if needed
  await initDatabase();

  // Check if this URL has already been processed (unless cache check is skipped)
  if (!skipCache) {
    const processedUrl = await getProcessedUrl(urlHash);
    if (processedUrl) {
      // If expectedFileType is provided, only use cache if file type matches
      if (expectedFileType && processedUrl.file_type !== expectedFileType) {
        logger.info(
          `URL cache exists but file type mismatch (expected: ${expectedFileType}, cached: ${processedUrl.file_type}), skipping cache`
        );
        // Skip cache and proceed with download
      } else {
        logger.info(
          `URL already processed (hash: ${urlHash.substring(0, 8)}...), returning existing file URL: ${processedUrl.file_url}`
        );
        // Return early with cached info - this will be caught by download handlers
        // We return null to indicate no download needed, and the handlers will check getProcessedUrl again
        throw new Error(`URL_ALREADY_PROCESSED:${processedUrl.file_url}`);
      }
    }
  }

  // Check if this URL is already being downloaded (atomic check-and-set)
  // URL deduplication: if multiple users request the same URL simultaneously, we reuse the existing download
  // instead of making duplicate API calls, which saves bandwidth and prevents redundant processing
  // Use atomic check-and-set to prevent race condition where two requests check at the same time
  let existingPromise = inProgressDownloads.get(urlHash);
  if (existingPromise) {
    logger.info(
      `URL already in progress, waiting for existing download: ${url.substring(0, 50)}...`
    );
    return existingPromise;
  }

  // Create new promise for this download
  const downloadPromise = (async () => {
    try {
      return await downloadFn();
    } finally {
      inProgressDownloads.delete(urlHash);
    }
  })();

  // Atomic check-and-set: if another request added the same URL between our check and set, use that one
  existingPromise = inProgressDownloads.get(urlHash);
  if (existingPromise) {
    logger.info(
      `URL was added by another request during setup, using existing download: ${url.substring(0, 50)}...`
    );
    return existingPromise;
  }

  // Track this download (atomic set)
  inProgressDownloads.set(urlHash, downloadPromise);

  return downloadPromise;
}
