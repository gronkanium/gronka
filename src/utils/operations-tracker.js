/**
 * Operations tracker for monitoring bot operations
 * Tracks convert, download, and optimize operations with status updates
 */

import crypto from 'crypto';
import axios from 'axios';
import {
  insertOperationLog,
  insertOrUpdateUserMetrics,
  getUserMetrics,
  getStuckOperations,
  markOperationAsFailed,
  getOperationTrace,
  getRecentOperations as getRecentOperationsFromDb,
} from './database.js';

/**
 * Queue an operation log entry for batched writing
 * @param {string} operationId - Operation ID
 * @param {string} step - Step name
 * @param {string} status - Status
 * @param {Object} data - Data object
 */
function queueOperationLog(operationId, step, status, data) {
  operationLogQueue.push({ operationId, step, status, data });

  // Flush immediately if queue is full
  if (operationLogQueue.length >= MAX_QUEUE_SIZE) {
    flushOperationLogs();
  } else {
    // Schedule flush if not already scheduled
    if (!flushTimer && !isFlushing) {
      flushTimer = setTimeout(() => {
        flushOperationLogs();
      }, FLUSH_INTERVAL_MS);
    }
  }
}

/**
 * Flush queued operation logs to database asynchronously
 */
async function flushOperationLogs() {
  if (isFlushing || operationLogQueue.length === 0) {
    return;
  }

  isFlushing = true;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  // Copy queue and clear it immediately to allow new entries
  const logsToFlush = [...operationLogQueue];
  operationLogQueue.length = 0;

  // Flush in background (don't await to avoid blocking)
  // eslint-disable-next-line no-undef
  setImmediate(async () => {
    try {
      for (const logEntry of logsToFlush) {
        try {
          insertOperationLog(logEntry.operationId, logEntry.step, logEntry.status, logEntry.data);
        } catch (error) {
          // Log error but continue with other entries
          console.error('Failed to flush operation log entry:', error);
        }
      }
    } catch (error) {
      console.error('Error flushing operation logs:', error);
    } finally {
      isFlushing = false;
      // If new entries were added while flushing, schedule another flush
      if (operationLogQueue.length > 0) {
        if (!flushTimer) {
          flushTimer = setTimeout(() => {
            flushOperationLogs();
          }, FLUSH_INTERVAL_MS);
        }
      }
    }
  });
}

/**
 * Force flush all queued operation logs (for shutdown)
 * @returns {Promise<void>}
 */
export async function flushAllOperationLogs() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  // Wait for current flush to complete
  while (isFlushing) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  // Flush remaining logs synchronously
  if (operationLogQueue.length > 0) {
    const logsToFlush = [...operationLogQueue];
    operationLogQueue.length = 0;

    for (const logEntry of logsToFlush) {
      try {
        insertOperationLog(logEntry.operationId, logEntry.step, logEntry.status, logEntry.data);
      } catch (error) {
        console.error('Failed to flush operation log entry during shutdown:', error);
      }
    }
  }
}
import { createLogger } from './logger.js';

// In-memory storage for operations (FIFO queue, max 100)
const operations = [];
const MAX_OPERATIONS = 100;

// Logger for application logs
const logger = createLogger('bot');

// Batched operation log queue for non-blocking writes
const operationLogQueue = [];
const MAX_QUEUE_SIZE = 10; // Flush when queue reaches this size
const FLUSH_INTERVAL_MS = 100; // Flush every 100ms
let flushTimer = null;
let isFlushing = false;

// Callback registry for broadcasting updates (set by webui-server)
// Keyed by WebUI port to support multiple instances
const broadcastCallbacks = new Map();
const userMetricsBroadcastCallbacks = new Map();

// Store current bot instance's WebUI port (mapped from TEST_WEBUI_PORT or PROD_WEBUI_PORT by bot-start.js)
// Use a getter function to read from process.env dynamically (allows tests to change it)
function getInstancePort() {
  return parseInt(process.env.WEBUI_PORT || '3001', 10);
}

// WebUI URL for sending operation updates (from bot to webui)
// Since webui is now in the same container, use localhost (fallback for HTTP mode)
function getWebuiUrl() {
  const port = getInstancePort();
  return process.env.WEBUI_URL || process.env.WEBUI_SERVER_URL || `http://localhost:${port}`;
}

/**
 * Set the broadcast callback for websocket updates
 * @param {Function} callback - Function to call when operations change
 * @param {number} [port] - WebUI port to register this callback for (defaults to current instance port)
 */
export function setBroadcastCallback(callback, port = null) {
  const targetPort = port || getInstancePort();
  broadcastCallbacks.set(targetPort, callback);
}

/**
 * Set the broadcast callback for user metrics updates
 * @param {Function} callback - Function to call when user metrics change
 * @param {number} [port] - WebUI port to register this callback for (defaults to current instance port)
 */
export function setUserMetricsBroadcastCallback(callback, port = null) {
  const targetPort = port || getInstancePort();
  userMetricsBroadcastCallbacks.set(targetPort, callback);
}

/**
 * Broadcast operation update to all connected clients
 * @param {Object} operation - Operation object to broadcast
 */
async function broadcastUpdate(operation) {
  // Try to find callback for this instance's port (same process)
  const currentPort = getInstancePort();
  const callback = broadcastCallbacks.get(currentPort);
  if (callback) {
    try {
      callback(operation);
    } catch (error) {
      console.error('Error broadcasting operation update:', error);
    }
  } else {
    // Prevent test operations from being sent to webui-server via HTTP POST
    // Check if we're in test mode by checking NODE_ENV or database path
    const isTestMode =
      process.env.NODE_ENV === 'test' ||
      (process.env.GRONKA_DB_PATH &&
        (process.env.GRONKA_DB_PATH.includes('test') ||
          process.env.GRONKA_DB_PATH.includes('tmp') ||
          process.env.GRONKA_DB_PATH.includes('temp')));

    if (isTestMode) {
      // In test mode, skip HTTP POST to prevent test operations from reaching production webui-server
      logger.debug('Skipping HTTP POST for operation update in test mode');
      return;
    }

    // Otherwise, send HTTP request to webui server (separate container)
    try {
      await axios.post(`${getWebuiUrl()}/api/operations`, operation, {
        timeout: 1000,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      // Silently fail if webui is not available (it's optional)
      if (error.code !== 'ECONNREFUSED' && error.code !== 'ETIMEDOUT') {
        console.error('Error sending operation update to webui:', error.message);
      }
    }
  }
}

/**
 * Create a failed operation for early validation failures
 * @param {string} type - Operation type ('convert', 'download', 'optimize', 'info')
 * @param {string} userId - Discord user ID
 * @param {string} username - Discord username
 * @param {string} errorMessage - Error message to display
 * @param {string} errorType - Error type (e.g., 'rate_limit', 'invalid_url', 'missing_attachment', etc.)
 * @param {Object} [context] - Additional context
 * @param {string} [context.originalUrl] - Original URL if this came from a URL
 * @param {Object} [context.attachment] - Attachment details (name, size, contentType, url)
 * @param {Object} [context.commandOptions] - Command options (optimize, lossy, etc.)
 * @param {string} [context.commandSource] - Command source ('slash' or 'context-menu')
 * @returns {string} Operation ID
 */
export function createFailedOperation(
  type,
  userId,
  username,
  errorMessage,
  errorType,
  context = {}
) {
  // Use cryptographically secure random bytes for operation ID
  const randomBytes = crypto.randomBytes(6).toString('hex');
  const operation = {
    id: `${Date.now()}-${randomBytes}`,
    type,
    status: 'error',
    userId,
    username,
    fileSize: null,
    timestamp: Date.now(),
    startTime: Date.now(),
    error: errorMessage,
    stackTrace: null,
    filePaths: [],
    performanceMetrics: {
      duration: 0, // Early failures have no duration
      steps: [],
    },
    earlyFailure: true, // Flag to identify early failures
    errorType, // Store error type for filtering
    originalUrl: context.originalUrl || null, // Store original URL if available
  };

  // Add to front of array
  operations.unshift(operation);

  // Remove oldest if over limit
  if (operations.length > MAX_OPERATIONS) {
    operations.pop();
  }

  // Determine input type from context
  let inputType = null;
  if (context.originalUrl) {
    inputType = 'url';
  } else if (context.attachment) {
    inputType = 'file';
  }

  // Build metadata for operation creation log
  const metadata = {
    operationType: type,
    userId,
    username,
    errorType,
    earlyFailure: true,
  };

  // Add context to metadata if provided
  if (context.originalUrl) {
    metadata.originalUrl = context.originalUrl;
  }
  if (context.attachment) {
    metadata.attachment = {
      name: context.attachment.name || null,
      size: context.attachment.size || null,
      contentType: context.attachment.contentType || null,
      url: context.attachment.url || null,
    };
  }
  if (context.commandOptions) {
    metadata.commandOptions = context.commandOptions;
  }
  if (context.commandSource) {
    metadata.commandSource = context.commandSource;
  }
  if (inputType) {
    metadata.inputType = inputType;
  }

  // Queue log entries for batched writing (non-blocking)
  // This ensures operations are tracked even if database is unavailable
  queueOperationLog(operation.id, 'created', 'error', {
    message: `Operation ${type} failed early: ${errorMessage}`,
    metadata,
  });
  // Also queue the error log
  queueOperationLog(operation.id, 'error', 'error', {
    message: errorMessage,
    metadata: {
      errorType,
      earlyFailure: true,
    },
  });

  // Log to application logs with operation ID
  logger.debug(`Failed operation ${type} created [op: ${operation.id}]: ${errorMessage}`);

  // Update user metrics (fire and forget)
  updateUserMetricsForOperation(operation).catch(error => {
    console.error('Failed to update user metrics for failed operation:', error);
  });

  broadcastUpdate(operation);
  return operation.id;
}

/**
 * Create a new operation
 * @param {string} type - Operation type ('convert', 'download', 'optimize', 'info')
 * @param {string} userId - Discord user ID
 * @param {string} username - Discord username
 * @param {Object} [context] - Initial operation context
 * @param {string} [context.originalUrl] - Original URL if this came from a URL
 * @param {Object} [context.attachment] - Attachment details (name, size, contentType, url)
 * @param {Object} [context.commandOptions] - Command options (optimize, lossy, etc.)
 * @param {string} [context.commandSource] - Command source ('slash' or 'context-menu')
 * @returns {string} Operation ID
 */
export function createOperation(type, userId, username, context = {}) {
  // Use cryptographically secure random bytes for operation ID
  const randomBytes = crypto.randomBytes(6).toString('hex');
  const operation = {
    id: `${Date.now()}-${randomBytes}`,
    type,
    status: 'pending',
    userId,
    username,
    fileSize: null,
    timestamp: Date.now(),
    startTime: Date.now(),
    error: null,
    stackTrace: null,
    filePaths: [],
    performanceMetrics: {
      duration: null,
      steps: [],
    },
    originalUrl: context.originalUrl || null, // Store original URL if available
  };

  // Add to front of array
  operations.unshift(operation);

  // Remove oldest if over limit
  if (operations.length > MAX_OPERATIONS) {
    operations.pop();
  }

  // Determine input type from context
  let inputType = null;
  if (context.originalUrl) {
    inputType = 'url';
  } else if (context.attachment) {
    inputType = 'file';
  }

  // Build metadata for operation creation log
  const metadata = {
    operationType: type,
    userId,
    username,
  };

  // Add context to metadata if provided
  if (context.originalUrl) {
    metadata.originalUrl = context.originalUrl;
  }
  if (context.attachment) {
    metadata.attachment = {
      name: context.attachment.name || null,
      size: context.attachment.size || null,
      contentType: context.attachment.contentType || null,
      url: context.attachment.url || null,
    };
  }
  if (context.commandOptions) {
    metadata.commandOptions = context.commandOptions;
  }
  if (context.commandSource) {
    metadata.commandSource = context.commandSource;
  }
  if (inputType) {
    metadata.inputType = inputType;
  }

  // Queue log entry for batched writing (non-blocking)
  // This ensures operations are tracked even if database is unavailable
  queueOperationLog(operation.id, 'created', 'pending', {
    message: `Operation ${type} created for user ${username}`,
    metadata,
  });

  // Log to application logs with operation ID
  logger.debug(`Operation ${type} created [op: ${operation.id}]`);

  broadcastUpdate(operation);
  return operation.id;
}

/**
 * Update operation status
 * @param {string} operationId - Operation ID
 * @param {string} status - New status ('pending', 'running', 'success', 'error')
 * @param {Object} [data] - Additional data (fileSize, error, stackTrace)
 */
export function updateOperationStatus(operationId, status, data = {}) {
  const operation = operations.find(op => op.id === operationId);
  if (!operation) {
    console.warn(`Operation ${operationId} not found`);
    return;
  }

  const previousStatus = operation.status;
  operation.status = status;
  operation.timestamp = Date.now(); // Update timestamp on status change

  if (data.fileSize !== undefined) {
    operation.fileSize = data.fileSize;
  }
  if (data.error !== undefined) {
    operation.error = data.error;
  }
  if (data.stackTrace !== undefined) {
    operation.stackTrace = data.stackTrace;
  }

  // Calculate duration if operation is complete
  if ((status === 'success' || status === 'error') && operation.startTime) {
    operation.performanceMetrics.duration = Math.max(1, Date.now() - operation.startTime);
  }

  // Queue log entry for batched writing (non-blocking)
  // This ensures operation status is always updated even if database is unavailable
  const metadata = { previousStatus, newStatus: status, ...data };
  // Include duration in metadata when operation completes
  if ((status === 'success' || status === 'error') && operation.performanceMetrics.duration) {
    metadata.duration = operation.performanceMetrics.duration;
  }
  queueOperationLog(operationId, 'status_update', status, {
    message: `Status changed from ${previousStatus} to ${status}`,
    metadata,
  });

  // Log to application logs with operation ID
  logger.debug(`Operation status updated to ${status} [op: ${operationId}]`);

  // Update user metrics on operation completion
  if (status === 'success' || status === 'error') {
    // Fire and forget - don't await to avoid blocking operation updates
    updateUserMetricsForOperation(operation).catch(error => {
      console.error('Failed to update user metrics:', error);
    });
  }

  broadcastUpdate(operation);
}

/**
 * Get recent operations
 * @param {number} [limit] - Maximum number of operations to return (default: all)
 * @returns {Array} Array of operation objects
 */
export function getRecentOperations(limit = null) {
  if (limit === null) {
    return [...operations];
  }
  return operations.slice(0, limit);
}

/**
 * Get an operation by ID
 * @param {string} operationId - Operation ID
 * @returns {Object|null} Operation object or null if not found
 */
export function getOperation(operationId) {
  const operation = operations.find(op => op.id === operationId);
  return operation || null;
}

/**
 * Log a detailed operation step
 * @param {string} operationId - Operation ID
 * @param {string} step - Step name (e.g., 'download_start', 'processing', 'upload')
 * @param {string} status - Status ('running', 'success', 'error')
 * @param {Object} [data] - Additional data
 */
export function logOperationStep(operationId, step, status, data = {}) {
  const operation = operations.find(op => op.id === operationId);
  if (!operation) {
    console.warn(`Operation ${operationId} not found`);
    return;
  }

  const stepTimestamp = Date.now();
  const stepData = {
    step,
    status,
    timestamp: stepTimestamp,
    duration: operation.startTime ? stepTimestamp - operation.startTime : null,
    ...data,
  };

  // Add to performance metrics
  operation.performanceMetrics.steps.push(stepData);

  // Add file path if provided
  if (data.filePath) {
    if (!operation.filePaths.includes(data.filePath)) {
      operation.filePaths.push(data.filePath);
    }
  }

  // Queue log entry for batched writing (non-blocking)
  // This ensures operation steps are tracked even if database is unavailable
  queueOperationLog(operationId, step, status, {
    message: data.message || `Step ${step} ${status}`,
    filePath: data.filePath || null,
    stackTrace: data.stackTrace || null,
    metadata: data.metadata || null,
  });

  // Log to application logs with operation ID
  logger.debug(`Operation step ${step} ${status} [op: ${operationId}]`);

  // Broadcast update if significant change
  if (status === 'error' || data.broadcast) {
    broadcastUpdate(operation);
  }
}

/**
 * Log an error with stack trace
 * @param {string} operationId - Operation ID
 * @param {Error|string} error - Error object or message
 * @param {Object} [data] - Additional data
 */
export function logOperationError(operationId, error, data = {}) {
  const operation = operations.find(op => op.id === operationId);
  if (!operation) {
    console.warn(`Operation ${operationId} not found`);
    return;
  }

  const errorMessage = error instanceof Error ? error.message : String(error);
  const stackTrace = error instanceof Error ? error.stack : null;

  operation.error = errorMessage;
  operation.stackTrace = stackTrace;

  // Queue log entry for batched writing (non-blocking)
  // This ensures operation errors are tracked even if database is unavailable
  queueOperationLog(operationId, 'error', 'error', {
    message: errorMessage,
    filePath: data.filePath || null,
    stackTrace: stackTrace,
    metadata: data.metadata || null,
  });

  // Log to application logs with operation ID
  logger.error(`Operation error: ${errorMessage} [op: ${operationId}]`);

  broadcastUpdate(operation);
}

/**
 * Update user metrics based on operation completion
 * @param {Object} operation - Operation object
 */
async function updateUserMetricsForOperation(operation) {
  if (!operation.userId || !operation.username) {
    return;
  }

  const metrics = {
    totalCommands: 1,
    successfulCommands: operation.status === 'success' ? 1 : 0,
    failedCommands: operation.status === 'error' ? 1 : 0,
    lastCommandAt: Date.now(),
  };

  // Update command-specific counters
  if (operation.type === 'convert') {
    metrics.totalConvert = 1;
  } else if (operation.type === 'download') {
    metrics.totalDownload = 1;
  } else if (operation.type === 'optimize') {
    metrics.totalOptimize = 1;
  } else if (operation.type === 'info') {
    metrics.totalInfo = 1;
  }

  // Add file size if available
  if (operation.fileSize && operation.status === 'success') {
    metrics.totalFileSize = operation.fileSize;
  }

  try {
    insertOrUpdateUserMetrics(operation.userId, operation.username, metrics);

    // Get updated metrics for broadcasting
    const updatedMetrics = getUserMetrics(operation.userId);
    if (!updatedMetrics) {
      return; // User metrics not found, skip broadcast
    }

    // Broadcast user metrics update
    const currentPort = getInstancePort();
    const userMetricsCallback = userMetricsBroadcastCallbacks.get(currentPort);
    if (userMetricsCallback) {
      // Callback is set (webui-server in same process)
      try {
        userMetricsCallback(operation.userId, updatedMetrics);
      } catch (error) {
        console.error('Error broadcasting user metrics:', error);
      }
    } else {
      // No callback, send HTTP request to webui server (separate container)
      try {
        await axios.post(
          `${getWebuiUrl()}/api/user-metrics`,
          {
            userId: operation.userId,
            metrics: updatedMetrics,
          },
          {
            timeout: 1000,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      } catch (error) {
        // Silently fail if webui is not available (it's optional)
        if (error.code !== 'ECONNREFUSED' && error.code !== 'ETIMEDOUT') {
          console.error('Error sending user metrics update to webui:', error.message);
        }
      }
    }
  } catch (error) {
    console.error('Failed to update user metrics:', error);
  }
}

/**
 * Clean up operations that are stuck in running status
 * Queries database for stuck operations and marks them as failed
 * Also updates in-memory operations if they exist and broadcasts updates
 * @param {number} [maxAgeMinutes=10] - Maximum age in minutes before an operation is considered stuck
 * @param {Object} [client] - Optional Discord client for sending DM notifications to users
 * @returns {Promise<number>} Number of operations cleaned up
 */
export async function cleanupStuckOperations(maxAgeMinutes = 10, client = null) {
  try {
    const now = Date.now();
    const maxAge = maxAgeMinutes * 60 * 1000; // Convert minutes to milliseconds
    const cutoffTime = now - maxAge;

    // Query database for stuck operations
    const stuckOperationIds = getStuckOperations(maxAgeMinutes);

    // Also check in-memory operations for stuck ones (in case database init failed)
    // This catches operations that were created but never logged to database
    const inMemoryStuckOps = operations.filter(op => {
      // Check if operation is in 'running' or 'pending' status and is old enough
      if (op.status !== 'running' && op.status !== 'pending') {
        return false;
      }
      // Check if operation timestamp is older than cutoff
      // Use timestamp (last status update) or startTime (operation creation) whichever is more recent
      const lastUpdate = op.timestamp || op.startTime || 0;
      return lastUpdate < cutoffTime;
    });

    // Combine database and in-memory stuck operations, removing duplicates
    const allStuckOperationIds = new Set(stuckOperationIds);
    for (const op of inMemoryStuckOps) {
      allStuckOperationIds.add(op.id);
    }

    if (allStuckOperationIds.size === 0) {
      return 0;
    }

    let cleanedCount = 0;
    for (const operationId of allStuckOperationIds) {
      try {
        // Check if operation exists in memory (might be in-memory only if db init failed)
        const inMemoryOp = operations.find(op => op.id === operationId);

        // Mark as failed in database (may fail silently if db not initialized)
        try {
          markOperationAsFailed(operationId);
        } catch (dbError) {
          // Database operation failed - that's okay, we'll update in-memory directly
          logger.debug(
            `Could not mark operation ${operationId} as failed in database: ${dbError.message}`
          );
        }

        // Reconstruct operation from database to get the latest status
        // This ensures we have the complete, up-to-date operation object that matches webui format
        // We use getRecentOperationsFromDb and filter to get the specific operation
        let reconstructedOp = null;
        try {
          const recentOps = getRecentOperationsFromDb(1000);
          reconstructedOp = recentOps.find(op => op.id === operationId);
        } catch (dbError) {
          // Database query failed - that's okay, we'll use in-memory operation
          logger.debug(
            `Could not reconstruct operation ${operationId} from database: ${dbError.message}`
          );
        }

        if (reconstructedOp) {
          // Update in-memory operation if it exists
          if (inMemoryOp) {
            // Update in-memory operation with reconstructed data
            Object.assign(inMemoryOp, reconstructedOp);
          }

          // Always broadcast the reconstructed operation to ensure webui gets the update
          broadcastUpdate(reconstructedOp);
        } else if (inMemoryOp) {
          // Operation exists only in memory (database init likely failed)
          // Update it directly to error status
          inMemoryOp.status = 'error';
          inMemoryOp.timestamp = Date.now();
          inMemoryOp.error = 'Operation timed out - marked as failed due to inactivity';
          if (inMemoryOp.startTime) {
            inMemoryOp.performanceMetrics.duration = Math.max(1, Date.now() - inMemoryOp.startTime);
          }

          // Broadcast the updated operation
          broadcastUpdate(inMemoryOp);
        } else {
          // Fallback: if reconstruction fails, try to get trace from database
          let trace = null;
          try {
            trace = getOperationTrace(operationId);
          } catch (dbError) {
            // Database query failed - that's okay, we'll use in-memory operation
            logger.debug(
              `Could not get trace for operation ${operationId} from database: ${dbError.message}`
            );
          }

          if (trace) {
            const userId = trace?.context?.userId;
            const operationType = trace?.context?.operationType || 'operation';
            const createdLog = trace.logs.find(log => log.step === 'created');

            const fallbackOp = {
              id: operationId,
              type: operationType,
              status: 'error',
              userId: userId || null,
              username: trace?.context?.username || null,
              fileSize: null,
              timestamp: Date.now(),
              startTime: createdLog?.timestamp || Date.now(),
              error: 'Operation timed out - marked as failed due to inactivity',
              stackTrace: null,
              filePaths: [],
              performanceMetrics: {
                duration: createdLog ? Date.now() - createdLog.timestamp : null,
                steps: [],
              },
            };

            // Update in-memory operation if it exists
            const inMemoryOp = operations.find(op => op.id === operationId);
            if (inMemoryOp) {
              Object.assign(inMemoryOp, fallbackOp);
            }

            broadcastUpdate(fallbackOp);
          }
        }

        // Get user info for DM notification
        let trace = null;
        let userId = null;
        let operationType = 'operation';

        // Try to get trace from database, but fall back to in-memory operation if db fails
        try {
          trace = getOperationTrace(operationId);
          userId = trace?.context?.userId;
          operationType = trace?.context?.operationType || 'operation';
        } catch (dbError) {
          // Database query failed - use in-memory operation if available
          if (inMemoryOp) {
            userId = inMemoryOp.userId;
            operationType = inMemoryOp.type || 'operation';
          }
          logger.debug(
            `Could not get trace for DM notification for operation ${operationId}: ${dbError.message}`
          );
        }

        // Send DM notification to user if client is provided
        if (client && userId) {
          try {
            const user = await client.users.fetch(userId);
            const errorMessage = `your ${operationType} operation timed out after ${maxAgeMinutes} minutes and was automatically cancelled. please try again.`;
            await user.send(errorMessage);
            logger.debug(
              `Sent timeout notification DM to user ${userId} for operation ${operationId}`
            );
          } catch (dmError) {
            // DM might fail if user has DMs disabled, log but don't fail the cleanup
            logger.debug(
              `Could not send timeout notification DM to user ${userId}: ${dmError.message}`
            );
          }
        }

        cleanedCount++;
        logger.info(
          `Marked stuck operation ${operationId} as failed (type: ${operationType}, user: ${userId || 'unknown'})`
        );
      } catch (error) {
        logger.error(`Failed to clean up stuck operation ${operationId}:`, error);
      }
    }

    if (cleanedCount > 0) {
      logger.info(`Cleaned up ${cleanedCount} stuck operation(s)`);
    }

    return cleanedCount;
  } catch (error) {
    logger.error('Error cleaning up stuck operations:', error);
    return 0;
  }
}
