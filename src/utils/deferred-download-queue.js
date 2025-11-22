import fs from 'fs/promises';
import path from 'path';
import { createLogger } from './logger.js';
import { RateLimitError } from './cobalt.js';

const logger = createLogger('deferred-queue');

// Queue file path
const QUEUE_FILE_PATH = path.join(process.cwd(), 'data', 'deferred-downloads.json');

// In-memory queue
let queue = [];

// Processing interval (2 minutes)
// Deferred downloads are processed in batches every 2 minutes instead of immediately
// This prevents overwhelming the system with many simultaneous downloads and allows for better resource management
// Note: Items that are rate limited will be skipped until their rate limit expires, regardless of this interval
const PROCESS_INTERVAL_MS = 2 * 60 * 1000;

// Processing state
let isProcessing = false;
let processingInterval = null;

/**
 * Initialize the queue from disk
 */
export async function initQueue() {
  try {
    // Ensure data directory exists
    const dataDir = path.dirname(QUEUE_FILE_PATH);
    await fs.mkdir(dataDir, { recursive: true });

    // Load queue from disk if it exists
    try {
      const data = await fs.readFile(QUEUE_FILE_PATH, 'utf8');
      queue = JSON.parse(data);
      logger.info(`Loaded ${queue.length} deferred downloads from disk`);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn(`Failed to load queue from disk: ${error.message}`);
      }
      queue = [];
    }
  } catch (error) {
    logger.error(`Failed to initialize queue: ${error.message}`);
    queue = [];
  }
}

/**
 * Save queue to disk
 */
async function saveQueue() {
  try {
    await fs.writeFile(QUEUE_FILE_PATH, JSON.stringify(queue, null, 2), 'utf8');
  } catch (error) {
    logger.error(`Failed to save queue to disk: ${error.message}`);
  }
}

/**
 * Add a download request to the deferred queue
 * @param {Object} request - Download request
 * @param {string} request.url - URL to download
 * @param {string} request.userId - Discord user ID
 * @param {string} request.username - Discord username
 * @param {string} request.channelId - Discord channel ID (for sending messages)
 * @param {string} request.interactionToken - Discord interaction token (for editing replies)
 * @param {boolean} request.isAdmin - Whether user is admin
 * @returns {Promise<string>} Request ID
 */
export async function addToQueue(request) {
  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  const queueItem = {
    id: requestId,
    url: request.url,
    userId: request.userId,
    username: request.username,
    channelId: request.channelId,
    interactionToken: request.interactionToken,
    isAdmin: request.isAdmin || false,
    addedAt: new Date().toISOString(),
    retryCount: 0,
    status: 'pending', // pending, processing, completed, failed, cancelled, rate_limited
    rateLimitedAt: null, // ISO timestamp when rate limited
    retryAfter: null, // Milliseconds to wait before retrying
  };

  queue.push(queueItem);
  await saveQueue();

  logger.info(
    `Added deferred download to queue: ${requestId} (url: ${request.url.substring(0, 50)}...)`
  );

  return requestId;
}

/**
 * Remove a request from the queue
 * @param {string} requestId - Request ID to remove
 * @returns {Promise<boolean>} True if removed, false if not found
 */
export async function removeFromQueue(requestId) {
  const index = queue.findIndex(item => item.id === requestId);
  if (index === -1) {
    return false;
  }

  queue.splice(index, 1);
  await saveQueue();

  logger.info(`Removed request from queue: ${requestId}`);
  return true;
}

/**
 * Cancel a request in the queue
 * @param {string} requestId - Request ID to cancel
 * @returns {Promise<boolean>} True if cancelled, false if not found
 */
export async function cancelRequest(requestId) {
  const item = queue.find(item => item.id === requestId);
  if (!item) {
    return false;
  }

  item.status = 'cancelled';
  await saveQueue();

  logger.info(`Cancelled request: ${requestId}`);
  return true;
}

/**
 * Get request by ID
 * @param {string} requestId - Request ID
 * @returns {Object|null} Queue item or null if not found
 */
export function getRequest(requestId) {
  return queue.find(item => item.id === requestId) || null;
}

/**
 * Get all pending requests (including failed ones that haven't exceeded retry limit)
 * Excludes items that are still rate limited (checks rateLimitedAt + retryAfter against current time)
 * Automatically converts expired rate_limited items back to pending status
 * @returns {Promise<Array>} Array of pending queue items ready to be processed
 */
export async function getPendingRequests() {
  const MAX_RETRIES = 10; // Try up to 10 times over 20 minutes
  const now = Date.now();
  let needsSave = false;

  const pending = queue.filter(item => {
    // Include pending items
    if (item.status === 'pending') {
      return true;
    }

    // Include failed items that haven't exceeded retry limit
    if (item.status === 'failed' && (item.retryCount || 0) < MAX_RETRIES) {
      return true;
    }

    // Include rate_limited items that have expired
    if (item.status === 'rate_limited') {
      if (item.rateLimitedAt && item.retryAfter) {
        const rateLimitedAtMs = new Date(item.rateLimitedAt).getTime();
        const retryAfterMs = item.retryAfter;
        const expiresAt = rateLimitedAtMs + retryAfterMs;

        if (now >= expiresAt) {
          // Rate limit has expired, convert back to pending
          item.status = 'pending';
          needsSave = true;
          logger.info(
            `Rate limit expired for ${item.id}, converting back to pending (was rate limited for ${Math.round(retryAfterMs / 1000)}s)`
          );
          return true;
        } else {
          // Still rate limited, skip
          const remainingSeconds = Math.round((expiresAt - now) / 1000);
          logger.debug(`Skipping ${item.id}, still rate limited (${remainingSeconds}s remaining)`);
          return false;
        }
      } else {
        // Missing rate limit info, treat as expired and convert to pending
        logger.warn(`Rate limited item ${item.id} missing timing info, converting to pending`);
        item.status = 'pending';
        needsSave = true;
        return true;
      }
    }

    return false;
  });

  // Save queue if we converted any rate_limited items to pending
  if (needsSave) {
    await saveQueue();
  }

  return pending;
}

/**
 * Update request status
 * @param {string} requestId - Request ID
 * @param {string} status - New status
 * @param {Object} metadata - Additional metadata to store
 */
export async function updateRequestStatus(requestId, status, metadata = {}) {
  const item = queue.find(item => item.id === requestId);
  if (!item) {
    return;
  }

  item.status = status;
  Object.assign(item, metadata);
  await saveQueue();
}

/**
 * Process a single queue item
 * Handles RateLimitError by storing rate limit timing and setting status to 'rate_limited'
 * Applies exponential backoff for repeated rate limits (5min, 10min, 20min)
 * @param {Object} item - Queue item to process
 * @param {Function} processCallback - Async callback to process the download
 * @returns {Promise<boolean>} True if successful, false otherwise
 */
export async function processQueueItem(item, processCallback) {
  const MAX_RETRIES = 10;

  try {
    logger.info(
      `Processing deferred download: ${item.id} (retry ${(item.retryCount || 0) + 1}/${MAX_RETRIES})`
    );
    item.status = 'processing';
    await saveQueue();

    const result = await processCallback(item);

    item.status = 'completed';
    item.completedAt = new Date().toISOString();
    item.result = result;
    await saveQueue();

    logger.info(`Successfully processed deferred download: ${item.id}`);
    return true;
  } catch (error) {
    logger.error(`Failed to process deferred download ${item.id}: ${error.message}`);

    // Check if this is a rate limit error
    if (error instanceof RateLimitError) {
      const retryAfterMs = error.retryAfter || 5 * 60 * 1000; // Default 5 minutes if not provided
      const now = Date.now();

      item.rateLimitedAt = new Date(now).toISOString();
      item.retryAfter = retryAfterMs;
      item.error = error.message;
      item.lastAttempt = new Date().toISOString();

      // Apply exponential backoff for repeated rate limits
      const rateLimitCount = (item.rateLimitCount || 0) + 1;
      item.rateLimitCount = rateLimitCount;

      // Exponential backoff: 5min, 10min, 20min
      const backoffMultiplier = Math.min(Math.pow(2, rateLimitCount - 1), 4); // Cap at 4x
      const adjustedRetryAfter = retryAfterMs * backoffMultiplier;
      item.retryAfter = adjustedRetryAfter;

      const retryAfterSeconds = Math.round(adjustedRetryAfter / 1000);
      logger.warn(
        `Rate limit error for ${item.id}, will retry after ${retryAfterSeconds}s (rate limit #${rateLimitCount})`
      );

      item.status = 'rate_limited';
      await saveQueue();
      return false;
    }

    // Increment retry count
    item.retryCount = (item.retryCount || 0) + 1;
    item.error = error.message;
    item.lastAttempt = new Date().toISOString();

    // Check if we should keep retrying
    if (item.retryCount < MAX_RETRIES) {
      // Check if error is "content not found" - stop retrying immediately
      if (
        error.message &&
        (error.message.includes('not found') ||
          error.message.includes('unavailable') ||
          error.message.includes('deleted'))
      ) {
        logger.error(`Content not found for ${item.id}, marking as permanently failed (no retry)`);
        item.status = 'failed_permanent';
      } else {
        logger.warn(
          `Will retry deferred download ${item.id} (${item.retryCount}/${MAX_RETRIES} attempts)`
        );
        item.status = 'failed'; // Keep as failed to retry in next cycle
      }
    } else {
      logger.error(`Max retries (${MAX_RETRIES}) exceeded for ${item.id}, giving up`);
      item.status = 'failed_permanent';
    }

    await saveQueue();
    return false;
  }
}

/**
 * Start the queue processor
 * @param {Function} processCallback - Async callback to process downloads
 */
export function startQueueProcessor(processCallback) {
  if (processingInterval) {
    logger.warn('Queue processor already running');
    return;
  }

  logger.info(`Starting queue processor (interval: ${PROCESS_INTERVAL_MS}ms)`);

  const processQueue = async () => {
    if (isProcessing) {
      logger.debug('Queue processor already running, skipping this cycle');
      return;
    }

    isProcessing = true;

    try {
      const pending = await getPendingRequests();

      if (pending.length === 0) {
        logger.debug('No pending requests to process');
        return;
      }

      // Process requests one at a time to avoid overwhelming the system
      // getPendingRequests() already filters out rate_limited items that haven't expired
      for (const item of pending) {
        // Only process items that are pending (rate_limited items are filtered out by getPendingRequests)
        if (item.status !== 'pending') {
          continue;
        }

        await processQueueItem(item, processCallback);
      }

      // Clean up old completed/failed_permanent/cancelled requests (older than 24 hours)
      // Keep failed items with retry count < max to keep retrying
      // Keep rate_limited items (they will be processed when their rate limit expires)
      const cutoffTime = Date.now() - 24 * 60 * 60 * 1000;
      const originalLength = queue.length;
      queue = queue.filter(item => {
        if (
          item.status === 'pending' ||
          item.status === 'processing' ||
          item.status === 'rate_limited'
        ) {
          return true; // Keep pending/processing/rate_limited
        }
        if (item.status === 'failed') {
          // Keep failed items that are still retryable
          const MAX_RETRIES = 10;
          return (item.retryCount || 0) < MAX_RETRIES;
        }
        // For completed/failed_permanent/cancelled, clean up after 24 hours
        const itemTime = item.completedAt || item.lastAttempt || item.addedAt;
        return new Date(itemTime).getTime() > cutoffTime;
      });

      if (queue.length !== originalLength) {
        logger.info(`Cleaned up ${originalLength - queue.length} old requests`);
        await saveQueue();
      }
    } catch (error) {
      logger.error(`Error processing queue: ${error.message}`);
    } finally {
      isProcessing = false;
    }
  };

  // Process immediately on start
  processQueue();

  // Set up interval
  processingInterval = setInterval(processQueue, PROCESS_INTERVAL_MS);
}

/**
 * Stop the queue processor
 */
export function stopQueueProcessor() {
  if (processingInterval) {
    clearInterval(processingInterval);
    processingInterval = null;
    logger.info('Queue processor stopped');
  }
}

/**
 * Get queue statistics
 * Includes count of rate_limited items (items waiting for rate limit to expire)
 * @returns {Object} Queue stats with counts for each status
 */
export function getQueueStats() {
  return {
    total: queue.length,
    pending: queue.filter(item => item.status === 'pending').length,
    processing: queue.filter(item => item.status === 'processing').length,
    rate_limited: queue.filter(item => item.status === 'rate_limited').length,
    completed: queue.filter(item => item.status === 'completed').length,
    failed: queue.filter(item => item.status === 'failed').length,
    failed_permanent: queue.filter(item => item.status === 'failed_permanent').length,
    cancelled: queue.filter(item => item.status === 'cancelled').length,
  };
}
