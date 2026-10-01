import { AttachmentBuilder } from 'discord.js';
import { r2Config } from '../../utils/config.js';
import { ValidationError } from '../../utils/errors.js';
import { hashUrl } from '../../utils/hashing.js';
import { deliverReply } from './deliver.js';
import {
  assertR2Capacity,
  uploadToR2,
  getR2KeyFromHash,
  formatR2UrlWithDisclaimer,
} from '../../utils/r2-storage.js';
import { resolveTtlHoursForSize } from '../../utils/storage.js';
import { OUTPUT_FORMATS } from '../../utils/video-processor.js';
import { fitsDiscordAttachment } from './attachment-limit.js';
import { recordProcessedUrl, trackR2UploadIfApplicable } from './url-cache.js';

// Attaches a converted file when Discord will take it, otherwise hands out an expiring R2 link.
export async function sendConvertedFile(interaction, ctx, { file, format, baseName }) {
  const { userId, adminUser, buildMetadata, discordAttachmentLimit } = ctx;
  const spec = OUTPUT_FORMATS[format];
  const filename = `${baseName}.${format}`;

  if (fitsDiscordAttachment(file.size, discordAttachmentLimit)) {
    await deliverReply(interaction, {
      files: [new AttachmentBuilder(file.path, { name: filename })],
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

  const { hash } = file;
  const key = getR2KeyFromHash(hash, spec.kind, `.${format}`);
  await assertR2Capacity(file.size);
  const url = await uploadToR2(file, key, spec.mime, r2Config, buildMetadata());
  const urlHash = hashUrl(`${url}#${format}:${hash}`);
  await recordProcessedUrl({
    urlHash,
    contentHash: hash,
    fileType: spec.kind,
    fileExtension: `.${format}`,
    fileUrl: url,
    userId,
    fileSize: file.size,
  });
  await trackR2UploadIfApplicable(urlHash, url, adminUser);
  const ttlHours = await resolveTtlHoursForSize(file.size);
  await deliverReply(interaction, {
    content: formatR2UrlWithDisclaimer(url, r2Config, adminUser, ttlHours),
  });
}
