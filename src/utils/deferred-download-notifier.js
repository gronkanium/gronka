import { createLogger } from './logger.js';
import { notifyDeferredDownload } from './ntfy-notifier.js';

const logger = createLogger('deferred-notifier');

/**
 * Send DM to user with download result
 * @param {Client} client - Discord client
 * @param {string} userId - User ID to DM
 * @param {string} content - Message content
 * @param {AttachmentBuilder} [attachment] - Optional file attachment
 * @returns {Promise<boolean>} True if DM sent successfully
 */
export async function sendDMToUser(client, userId, content, attachment = null) {
  try {
    const user = await client.users.fetch(userId);
    const messageOptions = attachment ? { files: [attachment] } : { content };
    await user.send(messageOptions);
    logger.info(`Sent DM to user ${userId}`);
    return true;
  } catch (error) {
    logger.warn(`Failed to send DM to user ${userId}: ${error.message}`);
    return false;
  }
}

/**
 * Send follow-up message to original interaction
 * @param {Client} client - Discord client
 * @param {string} interactionToken - Interaction token
 * @param {string} content - Message content
 * @param {AttachmentBuilder} [attachment] - Optional file attachment
 * @returns {Promise<boolean>} True if message sent successfully
 */
export async function sendFollowUpMessage(client, interactionToken, content, attachment = null) {
  try {
    // Use the REST API to send a follow-up message
    const body = attachment ? { files: [attachment] } : { content };
    await client.rest.post(`/webhooks/${client.application.id}/${interactionToken}`, {
      body,
    });
    logger.info('Sent follow-up message via webhook');
    return true;
  } catch (error) {
    logger.warn(`Failed to send follow-up message: ${error.message}`);
    return false;
  }
}

/**
 * Notify user about deferred download completion
 * @param {Client} client - Discord client
 * @param {Object} queueItem - Queue item with download details
 * @param {string|null} result - Result message or URL (null if sending attachment)
 * @param {AttachmentBuilder} [attachment] - Optional file attachment
 * @returns {Promise<void>}
 */
export async function notifyDownloadComplete(client, queueItem, result, attachment = null) {
  const message = result
    ? `your deferred download is ready:\n${result}`
    : 'your deferred download is ready:';

  // Try to send DM first
  const dmSent = await sendDMToUser(client, queueItem.userId, message, attachment);

  if (!dmSent) {
    // If DM fails, try to send follow-up to original interaction
    logger.info('DM failed, attempting follow-up message');
    const followUpSent = await sendFollowUpMessage(
      client,
      queueItem.interactionToken,
      message,
      attachment
    );

    if (!followUpSent) {
      logger.error(`Failed to notify user ${queueItem.userId} about completed download`);
    }
  }

  // Send ntfy notification
  await notifyDeferredDownload(queueItem.username, 'success');
}

/**
 * Notify user about deferred download failure
 * @param {Client} client - Discord client
 * @param {Object} queueItem - Queue item with download details
 * @param {string} errorMessage - Error message
 * @returns {Promise<void>}
 */
export async function notifyDownloadFailed(client, queueItem, errorMessage) {
  const message = `your deferred download failed: ${errorMessage}`;

  // Try to send DM first
  const dmSent = await sendDMToUser(client, queueItem.userId, message);

  if (!dmSent) {
    // If DM fails, try to send follow-up to original interaction
    logger.info('DM failed, attempting follow-up message');
    await sendFollowUpMessage(client, queueItem.interactionToken, message);
  }

  // Send ntfy notification
  await notifyDeferredDownload(queueItem.username, 'failed');
}
