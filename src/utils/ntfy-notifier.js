import { createLogger } from './logger.js';
import { botConfig } from './config.js';
import { insertAlert } from './database.js';
import { getOperation } from './operations-tracker.js';

const logger = createLogger('ntfy');
let broadcastCallback = null;

/**
 * Format duration in milliseconds to a human-readable string
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted duration (e.g., "1.2s", "5.3m")
 */
function formatDuration(ms) {
  if (!ms || ms === 0) return '';
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  const hours = minutes / 60;
  return `${hours.toFixed(1)}h`;
}

/**
 * Send notification to ntfy.sh
 * @param {string} title - Notification title
 * @param {string} message - Notification message
 * @param {Object} [options] - Additional options
 * @param {string} [options.severity] - Alert severity (info, warning, error)
 * @param {string} [options.component] - Component name
 * @param {string} [options.operationId] - Related operation ID
 * @param {string} [options.userId] - Related user ID
 * @param {Object} [options.metadata] - Additional metadata (duration will be automatically added if operationId is provided)
 * @returns {Promise<void>}
 */
export async function sendNtfyNotification(title, message, options = {}) {
  const {
    severity = 'info',
    component = 'bot',
    operationId = null,
    userId = null,
    metadata = null,
  } = options;

  // Calculate duration if operationId is provided
  let finalMetadata = metadata ? { ...metadata } : {};
  if (operationId) {
    const operation = getOperation(operationId);
    if (operation && operation.startTime) {
      const duration = Date.now() - operation.startTime;
      finalMetadata.duration = duration;
    }
  }

  // Log to database regardless of ntfy.sh status
  let alertRecord = null;
  try {
    alertRecord = insertAlert({
      severity,
      component,
      title,
      message,
      operationId,
      userId,
      metadata: Object.keys(finalMetadata).length > 0 ? finalMetadata : null,
    });

    // Broadcast alert if callback is set (for webui)
    if (broadcastCallback && alertRecord) {
      try {
        broadcastCallback(alertRecord);
      } catch (error) {
        logger.error('Error broadcasting alert:', error);
      }
    }
  } catch (error) {
    logger.error('Failed to log alert to database:', error);
  }

  // Send to ntfy.sh if enabled
  if (!botConfig.ntfyEnabled || !botConfig.ntfyTopic) {
    return;
  }

  try {
    // Build message with format: username: command success (duration)
    let notificationMessage = message;

    // Append duration in parentheses if available
    if (finalMetadata.duration !== undefined) {
      const formattedDuration = formatDuration(finalMetadata.duration);
      if (formattedDuration) {
        notificationMessage = `${message} (${formattedDuration})`;
      }
    }

    // Log the notification message for debugging
    logger.debug('Sending ntfy notification:', notificationMessage);

    const url = `https://ntfy.sh/${botConfig.ntfyTopic}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Title: title,
      },
      body: notificationMessage,
    });

    if (!response.ok) {
      logger.warn(`Failed to send ntfy notification: ${response.status} ${response.statusText}`);
    } else {
      logger.debug('Sent ntfy notification successfully');
    }
  } catch (error) {
    logger.warn(`Error sending ntfy notification: ${error.message}`);
  }
}

/**
 * Send command success notification
 * @param {string} username - Username
 * @param {string} command - Command name (convert, optimize, download)
 * @param {Object} [options] - Additional options (operationId, userId, metadata)
 * @param {string} [options.operationId] - Operation ID (duration will be automatically calculated and added to metadata)
 * @returns {Promise<void>}
 */
export async function notifyCommandSuccess(username, command, options = {}) {
  await sendNtfyNotification('command success', `${username}: ${command} success`, {
    severity: 'info',
    component: 'bot',
    ...options,
    metadata: {
      command,
      username,
      ...options.metadata,
    },
  });
}

/**
 * Send command failure notification
 * @param {string} username - Username
 * @param {string} command - Command name (convert, optimize, download)
 * @param {Object} [options] - Additional options (operationId, userId, metadata, error)
 * @param {string} [options.operationId] - Operation ID (duration will be automatically calculated and added to metadata)
 * @returns {Promise<void>}
 */
export async function notifyCommandFailure(username, command, options = {}) {
  const message = options.error
    ? `${username}: ${command} failed - ${options.error}`
    : `${username}: ${command} failed`;

  await sendNtfyNotification('command failed', message, {
    severity: 'error',
    component: 'bot',
    ...options,
    metadata: {
      command,
      username,
      error: options.error,
      ...options.metadata,
    },
  });
}

/**
 * Send generic notification with full options
 * @param {string} title - Notification title
 * @param {string} message - Notification message
 * @param {Object} options - Full options
 * @returns {Promise<void>}
 */
export async function notify(title, message, options = {}) {
  await sendNtfyNotification(title, message, options);
}

/**
 * Set broadcast callback for alert notifications
 * @param {Function} callback - Callback function to broadcast alerts
 */
export function setBroadcastCallback(callback) {
  broadcastCallback = callback;
}
