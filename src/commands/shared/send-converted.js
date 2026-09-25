import { AttachmentBuilder } from 'discord.js';
import { r2Config } from '../../utils/config.js';
import { ValidationError } from '../../utils/errors.js';
import { generateHash } from '../../utils/file-downloader.js';
import { hashUrl } from '../../utils/hashing.js';
import { safeInteractionEditReply } from '../../utils/interaction-helpers.js';
import { uploadToR2, getR2KeyFromHash, formatR2UrlWithDisclaimer } from '../../utils/r2-storage.js';
import { resolveTtlHoursForSize } from '../../utils/storage.js';
import { OUTPUT_FORMATS } from '../../utils/video-processor.js';
import { fitsDiscordAttachment } from './attachment-limit.js';
import { recordProcessedUrl, trackR2UploadIfApplicable } from './url-cache.js';

// Attaches a converted file when Discord will take it, otherwise hands out an expiring R2 link.
export async function sendConvertedFile(interaction, ctx, { buffer, format, baseName }) {
  const { userId, adminUser, buildMetadata, discordAttachmentLimit } = ctx;
  const spec = OUTPUT_FORMATS[format];
  const filename = `${baseName}.${format}`;

  if (fitsDiscordAttachment(buffer.length, discordAttachmentLimit)) {
    await safeInteractionEditReply(interaction, {
      files: [new AttachmentBuilder(buffer, { name: filename })],
    });
    return;
  }
  if (
    !r2Config.accountId ||
    !r2Config.accessKeyId ||
    !r2Config.secretAccessKey ||
    !r2Config.bucketName
  ) {
    throw new ValidationError(`the ${format} is too large to attach to Discord.`);
  }

  const hash = generateHash(buffer);
  const key = getR2KeyFromHash(hash, spec.kind, `.${format}`);
  const url = await uploadToR2(buffer, key, spec.mime, r2Config, buildMetadata());
  const urlHash = hashUrl(`${url}#${format}:${hash}`);
  await recordProcessedUrl({
    urlHash,
    contentHash: hash,
    fileType: spec.kind,
    fileExtension: `.${format}`,
    fileUrl: url,
    userId,
    fileSize: buffer.length,
  });
  await trackR2UploadIfApplicable(urlHash, url, adminUser);
  const ttlHours = await resolveTtlHoursForSize(buffer.length);
  await safeInteractionEditReply(interaction, {
    content: formatR2UrlWithDisclaimer(url, r2Config, adminUser, ttlHours),
  });
}
