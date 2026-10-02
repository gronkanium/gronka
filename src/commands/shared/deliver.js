import path from 'path';
import { AttachmentBuilder } from 'discord.js';
import { createLogger } from '../../utils/logger.js';
import { r2Config } from '../../utils/config.js';
import { AppError } from '../../utils/errors.js';
import { safeInteractionEditReply } from '../../utils/interaction-helpers.js';
import { updateOperationStatus } from '../../utils/operations-tracker.js';
import { detectFileType, resolveTtlHoursForSize } from '../../utils/storage.js';
import {
  isR2Configured,
  uploadMediaToR2,
  formatR2UrlWithDisclaimer,
} from '../../utils/r2-storage.js';
import { fitsDiscordAttachment } from './attachment-limit.js';

const logger = createLogger('deliver');

// Says where a file will go: attached from its job dir when it fits, else a link on R2.
export async function storeMedia(media, attachmentLimit, { defaultExt = '.mp4' } = {}) {
  const ext = path.extname(media.filename ?? '').toLowerCase() || defaultExt;
  const stored = {
    ext,
    type: detectFileType(ext, media.contentType, media.head),
    file: media,
    url: null,
    size: media.size,
    fits: fitsDiscordAttachment(media.size, attachmentLimit),
  };
  return stored.fits ? stored : toR2(stored);
}

export async function toR2(stored) {
  if (stored.url) return stored;
  if (!isR2Configured(r2Config)) {
    throw new AppError('this file is too big to send on discord.', 'TOO_LARGE', 413);
  }
  return { ...stored, url: await uploadMediaToR2(stored.type, stored.file, stored.ext, r2Config) };
}

export const attachmentFor = (stored, index = 0) =>
  new AttachmentBuilder(stored.file.path, {
    name: `gronka${index ? `-${index + 1}` : ''}${stored.ext}`,
  });

export async function finishCommand(type, ctx, fileSize, extra = {}) {
  updateOperationStatus(ctx.operationId, 'success', { fileSize, ...extra });
}

// The final reply of a command; a failed edit means the user got nothing, so the request failed.
export async function deliverReply(interaction, payload) {
  const message = await safeInteractionEditReply(interaction, payload);
  if (message === false) {
    throw new AppError('could not deliver the file to discord. please try again.');
  }
  return message;
}

export async function replyWithLink(interaction, url, ttlHours) {
  const content = formatR2UrlWithDisclaimer(url, r2Config, ttlHours);
  await deliverReply(interaction, { content });
}

// Attaches the file when it fits, else links it; a rejected attachment falls back to an R2 link.
export async function deliverStored(interaction, stored) {
  const ttlHours = await resolveTtlHoursForSize(stored.size);
  if (!stored.fits) return replyWithLink(interaction, stored.url, ttlHours);
  const message = await safeInteractionEditReply(interaction, { files: [attachmentFor(stored)] });
  if (message !== false) return;
  logger.warn('Discord attachment upload failed, falling back to R2');
  if (!isR2Configured(r2Config)) {
    throw new AppError('could not deliver the file to discord. please try again.');
  }
  await replyWithLink(interaction, (await toR2(stored)).url, ttlHours);
}
