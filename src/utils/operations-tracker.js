/**
 * Operations tracker for monitoring bot operations
 * Tracks convert, download, and optimize operations with status updates.
 *
 * Persistence model: only lifecycle events (created, status_update, error) are
 * written to the operation_logs table — enough for the webui to reconstruct an
 * operation's history. Intermediate steps live in memory only and are streamed
 * to the webui via broadcast.
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
} from './database.js';
import { createLogger } from './logger.js';

// In-memory storage for operations (FIFO queue, max 100)
const operations = [];
const MAX_OPERATIONS = 100;

const logger = createLogger('bot');

// In-flight database writes, so shutdown/tests can wait for them to land
const pendingWrites = new Set();

/**
 * Write an operation log entry to the database without blocking the caller.
 * Failures are logged and swallowed - tracking must not break operations.
 */
function writeOperationLog(operationId, step, status, data) {
  const write = insertOperationLog(operationId, step, status, data).catch(error => {
    logger.error(`Failed to write operation log (${operationId}/${step}): ${error.message}`);
  });
  pendingWrites.add(write);
  write.finally(() => pendingWrites.delete(write));
}

export async function flushAllOperationLogs() {
  while (pendingWrites.size > 0) {
    await Promise.allSettled([...pendingWrites]);
  }
}

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

export function setBroadcastCallback(callback, port = null) {
  const targetPort = port || getInstancePort();
  broadcastCallbacks.set(targetPort, callback);
}

export function setUserMetricsBroadcastCallback(callback, port = null) {
  const targetPort = port || getInstancePort();
  userMetricsBroadcastCallbacks.set(targetPort, callback);
}

async function broadcastUpdate(operation) {
  const isTestMode = process.env.NODE_ENV === 'test';

  // Try to find callback for this instance's port (same process)
  const currentPort = getInstancePort();
  const callback = broadcastCallbacks.get(currentPort);
  if (callback) {
    // Safety check: prevent test operations from calling production port callbacks
    // Production ports are 3000 (server) and 3001 (webui)
    // Test ports are 3100 (server) and 3101 (webui)
    if (isTestMode && (currentPort === 3000 || currentPort === 3001)) {
      logger.debug(
        `Skipping broadcast to production port ${currentPort} in test mode (test operations should use test ports 3100/3101)`
      );
      return;
    }

    try {
      callback(operation);
    } catch (error) {
      console.error('Error broadcasting operation update:', error);
    }
  } else {
    // Prevent test operations from being sent to webui-server via HTTP POST
    if (isTestMode) {
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
      // Silently fail if webui is not available (it's optional). Axios timeouts
      // surface as ECONNABORTED, so treat those as "unavailable" too.
      if (
        error.code !== 'ECONNREFUSED' &&
        error.code !== 'ETIMEDOUT' &&
        error.code !== 'ECONNABORTED'
      ) {
        console.error('Error sending operation update to webui:', error.message);
      }
    }
  }
}

/**
 * Build the metadata object stored with an operation's 'created' log entry
 */
function buildCreationMetadata(type, userId, username, context) {
  const metadata = {
    operationType: type,
    userId,
    username,
  };

  if (context.originalUrl) {
    metadata.originalUrl = context.originalUrl;
    metadata.inputType = 'url';
  } else if (context.attachment) {
    metadata.inputType = 'file';
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

  return metadata;
}

/**
 * Add an operation to the in-memory FIFO list
 */
function rememberOperation(operation) {
  operations.unshift(operation);
  if (operations.length > MAX_OPERATIONS) {
    operations.pop();
  }
}

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
    originalUrl: context.originalUrl || null,
  };

  rememberOperation(operation);

  const metadata = buildCreationMetadata(type, userId, username, context);
  metadata.errorType = errorType;
  metadata.earlyFailure = true;

  writeOperationLog(operation.id, 'created', 'error', {
    message: `Operation ${type} failed early: ${errorMessage}`,
    metadata,
  });
  writeOperationLog(operation.id, 'error', 'error', {
    message: errorMessage,
    metadata: {
      errorType,
      earlyFailure: true,
    },
  });

  logger.debug(`Failed operation ${type} created [op: ${operation.id}]: ${errorMessage}`);

  // Update user metrics (fire and forget)
  updateUserMetricsForOperation(operation).catch(error => {
    console.error('Failed to update user metrics for failed operation:', error);
  });

  broadcastUpdate(operation);
  return operation.id;
}

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
    originalUrl: context.originalUrl || null,
  };

  rememberOperation(operation);

  writeOperationLog(operation.id, 'created', 'pending', {
    message: `Operation ${type} created for user ${username}`,
    metadata: buildCreationMetadata(type, userId, username, context),
  });

  logger.debug(`Operation ${type} created [op: ${operation.id}]`);

  broadcastUpdate(operation);
  return operation.id;
}

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

  if ((status === 'success' || status === 'error') && operation.startTime) {
    operation.performanceMetrics.duration = Math.max(1, Date.now() - operation.startTime);
  }

  const metadata = { previousStatus, newStatus: status, ...data };
  if ((status === 'success' || status === 'error') && operation.performanceMetrics.duration) {
    metadata.duration = operation.performanceMetrics.duration;
  }
  writeOperationLog(operationId, 'status_update', status, {
    message: `Status changed from ${previousStatus} to ${status}`,
    metadata,
  });

  logger.debug(`Operation status updated to ${status} [op: ${operationId}]`);

  if (status === 'success' || status === 'error') {
    // Fire and forget - don't await to avoid blocking operation updates
    updateUserMetricsForOperation(operation).catch(error => {
      console.error('Failed to update user metrics:', error);
    });
  }

  broadcastUpdate(operation);
}

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

  operation.performanceMetrics.steps.push(stepData);

  if (data.filePath && !operation.filePaths.includes(data.filePath)) {
    operation.filePaths.push(data.filePath);
  }

  logger.debug(`Operation step ${step} ${status} [op: ${operationId}]`);

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

  writeOperationLog(operationId, 'error', 'error', {
    message: errorMessage,
    filePath: data.filePath || null,
    stackTrace: stackTrace,
    metadata: data.metadata || null,
  });

  logger.error(`Operation error: ${errorMessage} [op: ${operationId}]`);

  broadcastUpdate(operation);
}

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

  if (operation.type === 'convert') {
    metrics.totalConvert = 1;
  } else if (operation.type === 'download') {
    metrics.totalDownload = 1;
  } else if (operation.type === 'optimize') {
    metrics.totalOptimize = 1;
  } else if (operation.type === 'info') {
    metrics.totalInfo = 1;
  }

  if (operation.fileSize && operation.status === 'success') {
    metrics.totalFileSize = operation.fileSize;
  }

  try {
    await insertOrUpdateUserMetrics(operation.userId, operation.username, metrics);

    const updatedMetrics = await getUserMetrics(operation.userId);
    if (!updatedMetrics) {
      return; // User metrics not found, skip broadcast
    }

    const currentPort = getInstancePort();
    const userMetricsCallback = userMetricsBroadcastCallbacks.get(currentPort);
    if (userMetricsCallback) {
      // Callback is set (webui-server in same process)
      try {
        userMetricsCallback(operation.userId, updatedMetrics);
      } catch (error) {
        console.error('Error broadcasting user metrics:', error);
      }
    } else if (process.env.NODE_ENV === 'test') {
      // In test mode, skip HTTP POST to avoid hitting the production webui-server
      logger.debug('Skipping HTTP POST for user metrics update in test mode');
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
        // Silently fail if webui is not available (it's optional). Axios timeouts
        // surface as ECONNABORTED, so treat those as "unavailable" too.
        if (
          error.code !== 'ECONNREFUSED' &&
          error.code !== 'ETIMEDOUT' &&
          error.code !== 'ECONNABORTED'
        ) {
          console.error('Error sending user metrics update to webui:', error.message);
        }
      }
    }
  } catch (error) {
    console.error('Failed to update user metrics:', error);
  }
}

/**
 * Clean up operations that are stuck in running/pending status: mark them as
 * failed in the database and in memory, broadcast the change, and optionally
 * DM the affected user.
 * @param {number} [maxAgeMinutes=10] - Maximum age in minutes before an operation is considered stuck
 * @param {Object} [client] - Optional Discord client for sending DM notifications to users
 * @returns {Promise<number>} Number of operations cleaned up
 */
export async function cleanupStuckOperations(maxAgeMinutes = 10, client = null) {
  try {
    const cutoffTime = Date.now() - maxAgeMinutes * 60 * 1000;

    let dbStuckIds = [];
    try {
      dbStuckIds = await getStuckOperations(maxAgeMinutes);
    } catch (dbError) {
      logger.debug(`Could not query stuck operations from database: ${dbError.message}`);
    }

    // Also check in-memory operations (catches operations that never reached the database)
    const stuckIds = new Set(dbStuckIds);
    for (const op of operations) {
      if (
        (op.status === 'running' || op.status === 'pending') &&
        (op.timestamp || op.startTime || 0) < cutoffTime
      ) {
        stuckIds.add(op.id);
      }
    }

    if (stuckIds.size === 0) {
      return 0;
    }

    let cleanedCount = 0;
    for (const operationId of stuckIds) {
      try {
        try {
          await markOperationAsFailed(operationId);
        } catch (dbError) {
          logger.debug(
            `Could not mark operation ${operationId} as failed in database: ${dbError.message}`
          );
        }

        const inMemoryOp = operations.find(op => op.id === operationId);
        let userId = inMemoryOp?.userId || null;
        let operationType = inMemoryOp?.type || 'operation';

        if (inMemoryOp) {
          inMemoryOp.status = 'error';
          inMemoryOp.timestamp = Date.now();
          inMemoryOp.error = 'Operation timed out - marked as failed due to inactivity';
          if (inMemoryOp.startTime) {
            inMemoryOp.performanceMetrics.duration = Math.max(1, Date.now() - inMemoryOp.startTime);
          }
          broadcastUpdate(inMemoryOp);
        } else {
          // Operation only exists in the database; get its context for the broadcast/DM
          let trace = null;
          try {
            trace = await getOperationTrace(operationId);
          } catch (dbError) {
            logger.debug(`Could not get trace for operation ${operationId}: ${dbError.message}`);
          }
          userId = trace?.context?.userId || null;
          operationType = trace?.context?.operationType || 'operation';
          const createdLog = trace?.logs?.find(log => log.step === 'created');

          broadcastUpdate({
            id: operationId,
            type: operationType,
            status: 'error',
            userId,
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
          });
        }

        // Send DM notification to user if client is provided
        if (client && userId) {
          try {
            const user = await client.users.fetch(userId);
            await user.send(
              `your ${operationType} operation timed out after ${maxAgeMinutes} minutes and was automatically cancelled. please try again.`
            );
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
