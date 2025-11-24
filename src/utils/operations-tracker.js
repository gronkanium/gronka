/**
 * Operations tracker for monitoring bot operations
 * Tracks convert, download, and optimize operations with status updates
 */

import axios from 'axios';
import { insertOperationLog, insertOrUpdateUserMetrics, getUserMetrics } from './database.js';

// In-memory storage for operations (FIFO queue, max 100)
const operations = [];
const MAX_OPERATIONS = 100;

// Callback for broadcasting updates (set by webui-server)
let broadcastCallback = null;
let userMetricsBroadcastCallback = null;

// WebUI URL for sending operation updates (from bot to webui)
// Since webui is now in the same container, use localhost (fallback for HTTP mode)
const WEBUI_URL = process.env.WEBUI_URL || process.env.WEBUI_SERVER_URL || 'http://localhost:3001';

/**
 * Set the broadcast callback for websocket updates
 * @param {Function} callback - Function to call when operations change
 */
export function setBroadcastCallback(callback) {
  broadcastCallback = callback;
}

/**
 * Set the broadcast callback for user metrics updates
 * @param {Function} callback - Function to call when user metrics change
 */
export function setUserMetricsBroadcastCallback(callback) {
  userMetricsBroadcastCallback = callback;
}

/**
 * Broadcast operation update to all connected clients
 * @param {Object} operation - Operation object to broadcast
 */
async function broadcastUpdate(operation) {
  // If callback is set (webui-server), use it (same process)
  if (broadcastCallback) {
    try {
      broadcastCallback(operation);
    } catch (error) {
      console.error('Error broadcasting operation update:', error);
    }
  } else {
    // Otherwise, send HTTP request to webui server (separate container)
    try {
      await axios.post(`${WEBUI_URL}/api/operations`, operation, {
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
  const operation = {
    id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
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

  // Log operation creation with full context
  try {
    insertOperationLog(operation.id, 'created', 'pending', {
      message: `Operation ${type} created for user ${username}`,
      metadata,
    });
  } catch (error) {
    console.error('Failed to log operation creation:', error);
  }

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
    operation.performanceMetrics.duration = Date.now() - operation.startTime;
  }

  // Log status update
  try {
    insertOperationLog(operationId, 'status_update', status, {
      message: `Status changed from ${previousStatus} to ${status}`,
      metadata: { previousStatus, newStatus: status, ...data },
    });
  } catch (error) {
    console.error('Failed to log operation status update:', error);
  }

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

  // Log to database
  try {
    insertOperationLog(operationId, step, status, {
      message: data.message || `Step ${step} ${status}`,
      filePath: data.filePath || null,
      stackTrace: data.stackTrace || null,
      metadata: data.metadata || null,
    });
  } catch (error) {
    console.error('Failed to log operation step:', error);
  }

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

  // Log to database
  try {
    insertOperationLog(operationId, 'error', 'error', {
      message: errorMessage,
      filePath: data.filePath || null,
      stackTrace: stackTrace,
      metadata: data.metadata || null,
    });
  } catch (err) {
    console.error('Failed to log operation error:', err);
  }

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
    if (userMetricsBroadcastCallback) {
      // Callback is set (webui-server in same process)
      try {
        userMetricsBroadcastCallback(operation.userId, updatedMetrics);
      } catch (error) {
        console.error('Error broadcasting user metrics:', error);
      }
    } else {
      // No callback, send HTTP request to webui server (separate container)
      try {
        await axios.post(
          `${WEBUI_URL}/api/user-metrics`,
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
