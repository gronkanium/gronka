import { createLogger } from './logger.js';
import { botConfig } from './config.js';

const logger = createLogger('ntfy');

/**
 * Send notification to ntfy.sh
 * @param {string} title - Notification title
 * @param {string} message - Notification message
 * @returns {Promise<void>}
 */
export async function sendNtfyNotification(title, message) {
  if (!botConfig.ntfyEnabled || !botConfig.ntfyTopic) {
    return;
  }

  try {
    const url = `https://ntfy.sh/${botConfig.ntfyTopic}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Title: title,
        'Content-Type': 'text/plain',
      },
      body: message,
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
 * @returns {Promise<void>}
 */
export async function notifyCommandSuccess(username, command) {
  await sendNtfyNotification('Command Success', `${username}: ${command} success`);
}

/**
 * Send command failure notification
 * @param {string} username - Username
 * @param {string} command - Command name (convert, optimize, download)
 * @returns {Promise<void>}
 */
export async function notifyCommandFailure(username, command) {
  await sendNtfyNotification('Command Failed', `${username}: ${command} failed`);
}

/**
 * Send deferred download notification
 * @param {string} username - Username
 * @param {string} status - Status (success or failed)
 * @returns {Promise<void>}
 */
export async function notifyDeferredDownload(username, status) {
  await sendNtfyNotification('Deferred Download', `${username}: deferred download ${status}`);
}
