import path from 'path';
import { AttachmentBuilder } from 'discord.js';
import { createLogger } from '../../utils/logger.js';
import { botConfig, r2Config } from '../../utils/config.js';
import { AppError } from '../../utils/errors.js';
import { safeInteractionEditReply } from '../../utils/interaction-helpers.js';
import { recordRateLimit } from '../../utils/rate-limit.js';
import { updateOperationStatus } from '../../utils/operations-tracker.js';
import { notifyCommandSuccess } from '../../utils/ntfy-notifier.js';
import {
  mediaExists,
  mediaPath,
  mediaPublicUrl,
  saveMedia,
  storedSize,
  detectFileType,
  resolveTtlHoursForSize,
} from '../../utils/storage.js';
import {
  uploadMediaToR2,
  isR2Configured,
  formatR2UrlWithDisclaimer,
} from '../../utils/r2-storage.js';
import { fitsDiscordAttachment } from './attachment-limit.js';
import { recordProcessedUrl, trackR2UploadIfApplicable } from './url-cache.js';

const logger = createLogger('deliver');
const isRemote = location => /^https?:\/\//i.test(location);

// Saves a file (or reuses the stored copy) and says where it lives and whether it can be attached.
export async function storeMedia(
  media,
  { buildMetadata },
  attachmentLimit,
  { defaultExt = '.mp4', hash = media.hash } = {}
) {
  const storage = botConfig.gifStoragePath;
  const ext = path.extname(media.filename ?? '').toLowerCase() || defaultExt;
  const type = detectFileType(ext, media.contentType, media.head);
  const cached = await mediaExists(type, hash, ext, storage);
  const location = cached
    ? mediaPath(type, hash, ext, storage)
    : (await saveMedia(type, media, hash, ext, storage, buildMetadata(), attachmentLimit)).url;
  return {
    hash,
    ext,
    type,
    cached,
    inR2: cached ? isR2Configured(r2Config) : isRemote(location),
    file: media,
    url: mediaPublicUrl(location, type),
    size: await storedSize(location, media.size),
    fits: fitsDiscordAttachment(media.size, attachmentLimit),
  };
}

// Puts a stored file on R2 when it is not there yet; a no-op without R2.
export async function toR2(stored, { buildMetadata }) {
  if (stored.inR2 || !isR2Configured(r2Config)) return stored;
  const url = await uploadMediaToR2(
    stored.type,
    stored.file,
    stored.hash,
    stored.ext,
    r2Config,
    buildMetadata()
  );
  return { ...stored, url, inR2: true, cached: false };
}

export const attachmentFor = stored =>
  new AttachmentBuilder(stored.file.path, {
    name: `${stored.hash.replace(/[^a-f0-9]/gi, '')}${stored.ext}`,
  });

async function attachmentUrl(interaction, message) {
  const first = message?.attachments?.first?.();
  if (first?.url) return first.url;
  if (!message?.id || !interaction.channel) return null;
  try {
    const fetched = await interaction.channel.messages.fetch(message.id);
    return fetched?.attachments?.first?.()?.url ?? null;
  } catch (error) {
    logger.warn(`Failed to fetch message to get attachment URL: ${error.message}`);
    return null;
  }
}

export async function finishCommand(type, ctx, fileSize, extra = {}) {
  updateOperationStatus(ctx.operationId, 'success', { fileSize, ...extra });
  recordRateLimit(ctx.userId);
  notifyCommandSuccess(type, { operationId: ctx.operationId, userId: ctx.userId }).catch(error =>
    logger.warn(`Success notification failed: ${error.message}`)
  );
}

// The final reply of a command; a failed edit means the user got nothing, so the request failed.
export async function deliverReply(interaction, payload) {
  const message = await safeInteractionEditReply(interaction, payload);
  if (message === false) {
    throw new AppError('could not deliver the file to discord. please try again.');
  }
  return message;
}

export async function replyWithLink(interaction, ctx, url, ttlHours) {
  const content = formatR2UrlWithDisclaimer(url, r2Config, ctx.adminUser, ttlHours);
  await deliverReply(interaction, { content });
}

// Attaches the file when it fits, else links it; a rejected attachment falls back to an R2 link.
export async function deliverStored(interaction, ctx, stored, { urlHash }) {
  const { userId, adminUser } = ctx;
  const record = fileUrl =>
    recordProcessedUrl({
      urlHash,
      contentHash: stored.hash,
      fileType: stored.type,
      fileExtension: stored.ext,
      fileUrl,
      userId,
      fileSize: stored.size,
    });
  const track = item =>
    item.inR2 && !item.cached ? trackR2UploadIfApplicable(urlHash, item.url, adminUser) : null;

  await record(stored.url);
  await track(stored);
  const ttlHours = await resolveTtlHoursForSize(stored.size);
  if (!stored.fits) {
    return replyWithLink(interaction, ctx, stored.url, ttlHours);
  }

  const message = await safeInteractionEditReply(interaction, { files: [attachmentFor(stored)] });
  if (message !== false) {
    const discordUrl = await attachmentUrl(interaction, message);
    if (discordUrl) await record(discordUrl);
    return;
  }

  logger.warn('Discord attachment upload failed, falling back to R2');
  const fallback = await toR2(stored, ctx);
  if (fallback !== stored) {
    await record(fallback.url);
    await track(fallback);
  }
  await replyWithLink(interaction, ctx, fallback.url, ttlHours);
}
