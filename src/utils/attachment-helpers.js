import { botConfig } from './config.js';
import { OUTPUT_FORMATS } from './output-formats.js';
import path from 'node:path';

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

export function attachmentMediaKind(attachment) {
  const mime = (attachment.contentType ?? '').split(';')[0].toLowerCase();
  if (ALLOWED_VIDEO_TYPES.includes(mime)) return 'video';
  if (ALLOWED_IMAGE_TYPES.includes(mime)) return 'image';
  if (mime.startsWith('audio/') || mime === 'application/ogg') return 'audio';
  if (mime && mime !== 'application/octet-stream' && mime !== 'binary/octet-stream') return null;
  const ext = path
    .extname(attachment.name ?? '')
    .slice(1)
    .toLowerCase();
  if (['mp4', 'mov', 'webm', 'avi', 'mkv'].includes(ext)) return 'video';
  if (['gif', 'png', 'jpg', 'jpeg', 'webp', 'awebp'].includes(ext)) return 'image';
  if (OUTPUT_FORMATS[ext]?.kind === 'audio') return 'audio';
  return 'unknown';
}

export function validateConversionAttachment(attachment) {
  const kind = attachmentMediaKind(attachment);
  const max = kind === 'image' ? MAX_IMAGE_SIZE : MAX_VIDEO_SIZE;
  return attachment.size > max
    ? {
        valid: false,
        error: `the ${kind === 'unknown' ? 'media' : kind} file is too large (max ${max / (1024 * 1024)}mb).`,
      }
    : { valid: true };
}

export function firstConvertibleAttachment(attachments) {
  return (
    attachments.find(attachment =>
      ['video', 'audio', 'image'].includes(attachmentMediaKind(attachment))
    ) ?? attachments.find(attachment => attachmentMediaKind(attachment) === 'unknown')
  );
}

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
