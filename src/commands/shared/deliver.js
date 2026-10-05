import path from 'path';
import { AttachmentBuilder } from 'discord.js';
import { createLogger } from '../../utils/logger.js';
import { r2Config } from '../../utils/config.js';
import { AppError } from '../../utils/errors.js';
import { safeInteractionEditReply } from '../../utils/interaction-helpers.js';
import { succeed } from '../../utils/operations-tracker.js';
import { detectFileType, resolveTtlHoursForSize } from '../../utils/storage.js';
import {
  isR2Configured,
  uploadMediaToR2,
  formatR2UrlWithDisclaimer,
} from '../../utils/r2-storage.js';
import { fitsDiscordAttachment } from './attachment-limit.js';
import { jobSignal } from '../../utils/media-file.js';

const logger = createLogger('deliver');

export function deliveryError(interaction, partial = false) {
  const error = interaction.deliveryError;
  let message = 'discord could not receive the file right now. please try again shortly.';
  if ([10015, 10062, 50027].includes(error?.code)) {
    message = 'this took too long and the discord reply expired. please try a shorter clip.';
  } else if ([50001, 50013].includes(error?.code)) {
    message = 'i cannot send files in this channel. please check my channel permissions.';
  } else if (error?.status === 413 || error?.code === 40005) {
    message =
      'discord rejected this upload as too large. please try a smaller file or shorter clip.';
  } else if (error?.code === 10008) {
    message =
      'the reply message was deleted before the file could be sent. please run the command again.';
  }
  return new AppError(
    partial ? `only part of this post was sent. ${message}` : message,
    'DISCORD_DELIVERY_FAILED'
  );
}

export function canRecoverUpload(interaction) {
  return (
    isR2Configured(r2Config) &&
    ![10008, 10015, 10062, 50001, 50027].includes(interaction.deliveryError?.code)
  );
}

// Says where a file will go: attached from its job dir when it fits, else a link on R2.
export async function storeMedia(media, attachmentLimit, { defaultExt = '.mp4' } = {}) {
  jobSignal()?.throwIfAborted();
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
  jobSignal()?.throwIfAborted();
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

export function finishCommand() {
  succeed();
}

// The final reply of a command; a failed edit means the user got nothing, so the request failed.
export async function deliverReply(interaction, payload) {
  jobSignal()?.throwIfAborted();
  const message = await safeInteractionEditReply(interaction, payload);
  if (message === false) {
    throw deliveryError(interaction);
  }
  return message;
}

export async function replyWithLink(interaction, url, ttlHours) {
  const content = formatR2UrlWithDisclaimer(url, r2Config, ttlHours);
  await deliverReply(interaction, { content });
}

// Attaches the file when it fits, else links it; a rejected attachment falls back to an R2 link.
export async function deliverStored(interaction, stored, { name } = {}) {
  jobSignal()?.throwIfAborted();
  const ttlHours = await resolveTtlHoursForSize(stored.size);
  if (!stored.fits) return replyWithLink(interaction, stored.url, ttlHours);
  const attachment = attachmentFor(stored);
  if (name) attachment.setName(name);
  const message = await safeInteractionEditReply(interaction, { files: [attachment] });
  if (message !== false) return;
  if (!canRecoverUpload(interaction)) {
    throw deliveryError(interaction);
  }
  logger.warn('Discord attachment upload failed, falling back to R2');
  await replyWithLink(interaction, (await toR2(stored)).url, ttlHours);
}
