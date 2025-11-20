/**
 * Operations tracker for monitoring bot operations
 * Tracks convert, download, and optimize operations with status updates
 */

import axios from 'axios';

// In-memory storage for operations (FIFO queue, max 100)
const operations = [];
const MAX_OPERATIONS = 100;

// Callback for broadcasting updates (set by webui-server)
let broadcastCallback = null;

// WebUI URL for sending operation updates (from bot to webui)
const WEBUI_URL = process.env.WEBUI_URL || process.env.WEBUI_SERVER_URL || 'http://webui:3001';

/**
 * Set the broadcast callback for websocket updates
 * @param {Function} callback - Function to call when operations change
 */
export function setBroadcastCallback(callback) {
  broadcastCallback = callback;
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
 * @param {string} type - Operation type ('convert', 'download', 'optimize')
 * @param {string} userId - Discord user ID
 * @param {string} username - Discord username
 * @returns {string} Operation ID
 */
export function createOperation(type, userId, username) {
  const operation = {
    id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    type,
    status: 'pending',
    userId,
    username,
    fileSize: null,
    timestamp: Date.now(),
    error: null,
  };

  // Add to front of array
  operations.unshift(operation);

  // Remove oldest if over limit
  if (operations.length > MAX_OPERATIONS) {
    operations.pop();
  }

  broadcastUpdate(operation);
  return operation.id;
}

/**
 * Update operation status
 * @param {string} operationId - Operation ID
 * @param {string} status - New status ('pending', 'running', 'success', 'error')
 * @param {Object} [data] - Additional data (fileSize, error)
 */
export function updateOperationStatus(operationId, status, data = {}) {
  const operation = operations.find(op => op.id === operationId);
  if (!operation) {
    console.warn(`Operation ${operationId} not found`);
    return;
  }

  operation.status = status;
  if (data.fileSize !== undefined) {
    operation.fileSize = data.fileSize;
  }
  if (data.error !== undefined) {
    operation.error = data.error;
  }
  operation.timestamp = Date.now(); // Update timestamp on status change

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
