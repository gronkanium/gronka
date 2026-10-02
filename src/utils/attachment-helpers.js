import { botConfig } from './config.js';

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

export function validateVideoAttachment(attachment) {
  // Check if it's a video
  if (!attachment.contentType || !ALLOWED_VIDEO_TYPES.includes(attachment.contentType)) {
    return {
      valid: false,
      error: `unsupported video format. supported formats: mp4, mov, webm, avi, mkv`,
    };
  }

  if (attachment.size > MAX_VIDEO_SIZE) {
    return {
      valid: false,
      error: `video file is too large (max ${MAX_VIDEO_SIZE / (1024 * 1024)}mb)`,
    };
  }

  return { valid: true };
}

export function validateImageAttachment(attachment) {
  // Check if it's an image
  if (!attachment.contentType || !ALLOWED_IMAGE_TYPES.includes(attachment.contentType)) {
    return {
      valid: false,
      error: `unsupported image format. supported formats: png, jpg, jpeg, webp, gif`,
    };
  }

  if (attachment.size > MAX_IMAGE_SIZE) {
    return {
      valid: false,
      error: `image file is too large (max ${MAX_IMAGE_SIZE / (1024 * 1024)}mb)`,
    };
  }

  return { valid: true };
}

// Discord rejects an entire message carrying more than 10 attachments (API error 50035,
// BASE_TYPE_MAX_LENGTH), so anything larger has to be delivered across several messages.
export const DISCORD_MAX_ATTACHMENTS = 10;

// Split attachments into batches small enough for Discord to accept in one message
export function batchAttachmentsForDelivery(attachments, size = DISCORD_MAX_ATTACHMENTS) {
  const batches = [];
  for (let i = 0; i < attachments.length; i += size) {
    batches.push(attachments.slice(i, i + size));
  }
  return batches;
}
