import { botConfig } from './config.js';
import { createLogger } from './logger.js';

const logger = createLogger('attachment-helpers');

const { maxVideoSize: MAX_VIDEO_SIZE, maxImageSize: MAX_IMAGE_SIZE } = botConfig;

// Export video size limit for use in tests
export { MAX_VIDEO_SIZE };

// Allowed video content types
export const ALLOWED_VIDEO_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-msvideo', // AVI
  'video/x-matroska', // MKV
];

// Allowed image content types
export const ALLOWED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
];

export function validateVideoAttachment(attachment, isAdminUser = false) {
  // Check if it's a video
  if (!attachment.contentType || !ALLOWED_VIDEO_TYPES.includes(attachment.contentType)) {
    return {
      valid: false,
      error: `unsupported video format. supported formats: mp4, mov, webm, avi, mkv`,
    };
  }

  // Check file size (admins bypass size limit)
  if (!isAdminUser && attachment.size > MAX_VIDEO_SIZE) {
    return {
      valid: false,
      error: `video file is too large (max ${MAX_VIDEO_SIZE / (1024 * 1024)}mb)`,
    };
  }

  if (isAdminUser && attachment.size > MAX_VIDEO_SIZE) {
    logger.info(
      `Video size limit bypassed for admin (${(attachment.size / (1024 * 1024)).toFixed(2)}MB > ${MAX_VIDEO_SIZE / (1024 * 1024)}MB)`
    );
  }

  return { valid: true };
}

export function validateImageAttachment(attachment, isAdminUser = false) {
  // Check if it's an image
  if (!attachment.contentType || !ALLOWED_IMAGE_TYPES.includes(attachment.contentType)) {
    return {
      valid: false,
      error: `unsupported image format. supported formats: png, jpg, jpeg, webp, gif`,
    };
  }

  // Check file size (admins bypass size limit)
  if (!isAdminUser && attachment.size > MAX_IMAGE_SIZE) {
    return {
      valid: false,
      error: `image file is too large (max ${MAX_IMAGE_SIZE / (1024 * 1024)}mb)`,
    };
  }

  if (isAdminUser && attachment.size > MAX_IMAGE_SIZE) {
    logger.info(
      `Image size limit bypassed for admin (${(attachment.size / (1024 * 1024)).toFixed(2)}MB > ${MAX_IMAGE_SIZE / (1024 * 1024)}MB)`
    );
  }

  return { valid: true };
}

// Discord rejects an entire message carrying more than 10 attachments (API error 50035,
// BASE_TYPE_MAX_LENGTH), so anything larger has to be delivered across several messages.
export const DISCORD_MAX_ATTACHMENTS = 10;

/**
 * Split attachments into batches small enough for Discord to accept in one message.
 *
 * Sending an oversized carousel as a single message failed the whole request, so the user
 * silently received nothing at all rather than a partial post.
 *
 * @param {Array} attachments - Attachments to deliver, in the order they should appear
 * @param {number} [size] - Maximum attachments per message
 * @returns {Array<Array>} Batches in order; empty when there is nothing to send
 */
export function batchAttachmentsForDelivery(attachments, size = DISCORD_MAX_ATTACHMENTS) {
  const batches = [];
  for (let i = 0; i < attachments.length; i += size) {
    batches.push(attachments.slice(i, i + size));
  }
  return batches;
}
