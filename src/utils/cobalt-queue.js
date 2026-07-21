import { createLogger } from './logger.js';
import { getProcessedUrl } from './database.js';
import { initDatabase } from './database.js';
import { hashStringHex } from './hashing.js';

const logger = createLogger('cobalt-queue');

// Maximum concurrent Cobalt API requests
// Limited to 2 to avoid overwhelming the Cobalt API and prevent rate limiting
const MAX_CONCURRENT_REQUESTS = 2;

// Track in-progress downloads by URL hash
const inProgressDownloads = new Map();

// Queue for pending requests
const requestQueue = [];

// Current number of active requests
let activeRequests = 0;

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
 * Process next request in queue if capacity available
 */
function processQueue() {
  while (activeRequests < MAX_CONCURRENT_REQUESTS && requestQueue.length > 0) {
    const nextRequest = requestQueue.shift();
    executeRequest(nextRequest);
  }
}

/**
 * Execute a queued request
 * @param {Object} request - Request object with downloadFn, resolve, reject
 */
async function executeRequest(request) {
  const { downloadFn, resolve, reject } = request;

  activeRequests++;
  logger.info(
    `Executing request (active: ${activeRequests}/${MAX_CONCURRENT_REQUESTS}, queued: ${requestQueue.length})`
  );

  try {
    const result = await downloadFn();
    resolve(result);
  } catch (error) {
    reject(error);
  } finally {
    activeRequests--;
    logger.info(
      `Request completed (active: ${activeRequests}/${MAX_CONCURRENT_REQUESTS}, queued: ${requestQueue.length})`
    );

    // Process next item in queue
    processQueue();
  }
}

/**
 * Queue a Cobalt download request with URL deduplication and concurrency limiting
 * @param {string} url - URL to download
 * @param {Function} downloadFn - Async function that performs the actual download
 * @param {Object} [options] - Optional parameters
 * @param {boolean} [options.skipCache] - Skip URL cache check (useful when trimming/modifying the result)
 * @param {string} [options.expectedFileType] - Expected file type ('video', 'gif', 'image'). If provided, only use cache if file type matches
 * @returns {Promise} Promise that resolves with download result
 */
export function queueCobaltRequest(url, downloadFn, options = {}) {
  const { skipCache = false, expectedFileType = null, dedupeKey = null } = options;
  const urlHash = hashUrl(url);

  // Deduplication key: skipCache requests (e.g. trims) must not join promises created
  // by cache-checking requests - those can reject with URL_ALREADY_PROCESSED, which
  // would make a trim request silently return the cached untrimmed URL. They dedupe
  // in their own namespace instead. Callers with a different result shape (e.g.
  // URL-only mode) pass an explicit dedupeKey for the same reason.
  const mapKey = dedupeKey || `${skipCache ? 'nocache:' : ''}${urlHash}`;

  // URL deduplication: if multiple users request the same URL simultaneously, we reuse
  // the existing download instead of making duplicate API calls.
  // The check-and-set must happen synchronously (before any await) - registering after
  // the async DB cache check opened a window where concurrent requests all passed the
  // check before any of them registered, defeating deduplication entirely.
  const existingPromise = inProgressDownloads.get(mapKey);
  if (existingPromise) {
    logger.info(
      `URL already in progress, waiting for existing download: ${url.substring(0, 50)}...`
    );
    return existingPromise;
  }

  const downloadPromise = (async () => {
    // Initialize database if needed
    await initDatabase();

    // Check if this URL has already been processed (unless cache check is skipped)
    if (!skipCache) {
      const processedUrl = await getProcessedUrl(urlHash);
      if (processedUrl) {
        // If expectedFileType is provided, only use cache if file type matches, and never
        // reuse a cached URL whose R2 upload has expired - that's a dead link now
        if (expectedFileType && processedUrl.file_type !== expectedFileType) {
          logger.info(
            `URL cache exists but file type mismatch (expected: ${expectedFileType}, cached: ${processedUrl.file_type}), skipping cache`
          );
          // Skip cache and proceed with download
        } else if (processedUrl.r2_expired_at) {
          logger.info(
            `URL cache exists but its R2 upload expired (hash: ${urlHash.substring(0, 8)}...), skipping cache`
          );
          // Skip cache and proceed with download
        } else {
          logger.info(
            `URL already processed (hash: ${urlHash.substring(0, 8)}...), returning existing file URL: ${processedUrl.file_url}`
          );
          // Return early with cached info - this will be caught by download handlers
          // The handlers will check getProcessedUrl again for the actual URL
          throw new Error(`URL_ALREADY_PROCESSED:${processedUrl.file_url}`);
        }
      }
    }

    return await new Promise((resolve, reject) => {
      requestQueue.push({ url, urlHash, downloadFn, resolve, reject });
      logger.info(
        `Request queued (active: ${activeRequests}/${MAX_CONCURRENT_REQUESTS}, queued: ${requestQueue.length})`
      );

      // Try to process immediately if capacity available
      processQueue();
    });
  })();

  // Track this download; remove from the map once it settles either way.
  // The rejection handler here only does cleanup - callers still receive the rejection.
  inProgressDownloads.set(mapKey, downloadPromise);
  downloadPromise.then(
    () => inProgressDownloads.delete(mapKey),
    () => inProgressDownloads.delete(mapKey)
  );

  return downloadPromise;
}
