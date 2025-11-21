import crypto from 'crypto';
import { createLogger } from './logger.js';
import { getProcessedUrl } from './database.js';
import { initDatabase } from './database.js';

const logger = createLogger('cobalt-queue');

// Maximum concurrent Cobalt API requests
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
  return crypto.createHash('sha256').update(url).digest('hex');
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
 * @returns {Promise} Promise that resolves with download result
 */
export async function queueCobaltRequest(url, downloadFn) {
  const urlHash = hashUrl(url);

  // Initialize database if needed
  await initDatabase();

  // Check if this URL has already been processed
  const processedUrl = getProcessedUrl(urlHash);
  if (processedUrl) {
    logger.info(
      `URL already processed (hash: ${urlHash.substring(0, 8)}...), returning existing file URL: ${processedUrl.file_url}`
    );
    // Return early with cached info - this will be caught by download handlers
    // We return null to indicate no download needed, and the handlers will check getProcessedUrl again
    throw new Error(`URL_ALREADY_PROCESSED:${processedUrl.file_url}`);
  }

  // Check if this URL is already being downloaded
  if (inProgressDownloads.has(urlHash)) {
    logger.info(
      `URL already in progress, waiting for existing download: ${url.substring(0, 50)}...`
    );
    const existingPromise = inProgressDownloads.get(urlHash);
    return existingPromise;
  }

  // Create new promise for this download
  const downloadPromise = new Promise((resolve, reject) => {
    const request = {
      url,
      urlHash,
      downloadFn,
      resolve: result => {
        // Remove from in-progress map
        inProgressDownloads.delete(urlHash);
        resolve(result);
      },
      reject: error => {
        // Remove from in-progress map
        inProgressDownloads.delete(urlHash);
        reject(error);
      },
    };

    // Add to queue
    requestQueue.push(request);
    logger.info(
      `Request queued (active: ${activeRequests}/${MAX_CONCURRENT_REQUESTS}, queued: ${requestQueue.length})`
    );

    // Try to process immediately if capacity available
    processQueue();
  });

  // Track this download
  inProgressDownloads.set(urlHash, downloadPromise);

  return downloadPromise;
}

/**
 * Get current queue stats
 * @returns {Object} Queue statistics
 */
export function getQueueStats() {
  return {
    activeRequests,
    queuedRequests: requestQueue.length,
    inProgressUrls: inProgressDownloads.size,
    maxConcurrent: MAX_CONCURRENT_REQUESTS,
  };
}
