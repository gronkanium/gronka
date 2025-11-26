import { botConfig } from './config.js';
import { createLogger } from './logger.js';

const logger = createLogger('attachment-helpers');

const { maxVideoSize: MAX_VIDEO_SIZE, maxImageSize: MAX_IMAGE_SIZE } = botConfig;

// Export size limits for use in tests
export { MAX_VIDEO_SIZE, MAX_IMAGE_SIZE };

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

/**
 * Validate video attachment
 * @param {Attachment} attachment - Discord attachment
 * @param {boolean} isAdminUser - Whether the user is an admin
 * @returns {Object} Validation result with error message if invalid
 */
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

/**
 * Validate image attachment
 * @param {Attachment} attachment - Discord attachment
 * @param {boolean} isAdminUser - Whether the user is an admin
 * @returns {Object} Validation result with error message if invalid
 */
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
