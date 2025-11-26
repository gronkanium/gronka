import { createLogger } from './logger.js';
import { notifyDeferredDownload } from './ntfy-notifier.js';

const logger = createLogger('deferred-notifier');

/**
 * Send DM to user with download result
 * @param {Client} client - Discord client
 * @param {string} userId - User ID to DM
 * @param {string} content - Message content
 * @param {AttachmentBuilder} [attachment] - Optional file attachment
 * @returns {Promise<Message|null>} Message if sent successfully, null otherwise
 */
export async function sendDMToUser(client, userId, content, attachment = null) {
  try {
    const user = await client.users.fetch(userId);
    const messageOptions = attachment ? { files: [attachment] } : { content };
    const message = await user.send(messageOptions);
    logger.info(`Sent DM to user ${userId}`);
    return message;
  } catch (error) {
    logger.warn(`Failed to send DM to user ${userId}: ${error.message}`);
    return null;
  }
}

/**
 * Send follow-up message to original interaction
 * @param {Client} client - Discord client
 * @param {string} interactionToken - Interaction token
 * @param {string} content - Message content
 * @param {AttachmentBuilder} [attachment] - Optional file attachment
 * @returns {Promise<Message|null>} Message if sent successfully, null otherwise
 */
export async function sendFollowUpMessage(client, interactionToken, content, attachment = null) {
  try {
    // Use the REST API to send a follow-up message
    const body = attachment ? { files: [attachment] } : { content };
    const response = await client.rest.post(
      `/webhooks/${client.application.id}/${interactionToken}`,
      {
        body,
      }
    );
    logger.info('Sent follow-up message via webhook');
    // REST API returns message data, convert to Message object if possible
    // For now, return the response data - caller can extract attachment URL from it
    return response;
  } catch (error) {
    logger.warn(`Failed to send follow-up message: ${error.message}`);
    return null;
  }
}

/**
 * Notify user about deferred download completion
 * @param {Client} client - Discord client
 * @param {Object} queueItem - Queue item with download details
 * @param {string|null} result - Result message or URL (null if sending attachment)
 * @param {AttachmentBuilder} [attachment] - Optional file attachment
 * @param {string} [operationId] - Operation ID for duration tracking
 * @param {string} [userId] - User ID
 * @returns {Promise<string|null>} Discord attachment URL if captured, null otherwise
 */
export async function notifyDownloadComplete(
  client,
  queueItem,
  result,
  attachment = null,
  operationId = null,
  userId = null
) {
  const message = result
    ? `your deferred download is ready:\n${result}`
    : 'your deferred download is ready:';

  // Try to send DM first
  const dmMessage = await sendDMToUser(client, queueItem.userId, message, attachment);
  let discordUrl = null;

  if (dmMessage) {
    // Extract attachment URL from DM message
    if (dmMessage.attachments && dmMessage.attachments.size > 0) {
      const discordAttachment = dmMessage.attachments.first();
      if (discordAttachment && discordAttachment.url) {
        discordUrl = discordAttachment.url;
      }
    }
  } else {
    // If DM fails, try to send follow-up to original interaction
    logger.info('DM failed, attempting follow-up message');
    const followUpResponse = await sendFollowUpMessage(
      client,
      queueItem.interactionToken,
      message,
      attachment
    );

    if (followUpResponse) {
      // Extract attachment URL from follow-up response
      if (followUpResponse.attachments && followUpResponse.attachments.length > 0) {
        const discordAttachment = followUpResponse.attachments[0];
        if (discordAttachment && discordAttachment.url) {
          discordUrl = discordAttachment.url;
        }
      }
    } else {
      logger.error(`Failed to notify user ${queueItem.userId} about completed download`);
    }
  }

  // Send ntfy notification
  await notifyDeferredDownload(queueItem.username, 'success', { operationId, userId });

  return discordUrl;
}

/**
 * Notify user about deferred download failure
 * @param {Client} client - Discord client
 * @param {Object} queueItem - Queue item with download details
 * @param {string} errorMessage - Error message
 * @param {string} [operationId] - Operation ID for duration tracking
 * @param {string} [userId] - User ID
 * @returns {Promise<void>}
 */
export async function notifyDownloadFailed(
  client,
  queueItem,
  errorMessage,
  operationId = null,
  userId = null
) {
  const message = `your deferred download failed: ${errorMessage}`;

  // Try to send DM first
  const dmSent = await sendDMToUser(client, queueItem.userId, message);

  if (!dmSent) {
    // If DM fails, try to send follow-up to original interaction
    logger.info('DM failed, attempting follow-up message');
    await sendFollowUpMessage(client, queueItem.interactionToken, message);
  }

  // Send ntfy notification
  await notifyDeferredDownload(queueItem.username, 'failed', {
    operationId,
    userId,
    error: errorMessage,
  });
}
