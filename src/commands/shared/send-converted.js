import { AttachmentBuilder } from 'discord.js';
import { r2Config } from '../../utils/config.js';
import { ValidationError } from '../../utils/errors.js';
import { deliverReply } from './deliver.js';
import {
  uploadMediaToR2,
  formatR2UrlWithDisclaimer,
  isR2Configured,
} from '../../utils/r2-storage.js';
import { resolveTtlHoursForSize } from '../../utils/storage.js';
import { OUTPUT_FORMATS } from '../../utils/video-processor.js';
import { fitsDiscordAttachment } from './attachment-limit.js';

// Attaches a converted file when Discord will take it, otherwise hands out an expiring R2 link.
export async function sendConvertedFile(interaction, ctx, { file, format, baseName }) {
  const spec = OUTPUT_FORMATS[format];
  const filename = `${baseName}.${format}`;

  if (fitsDiscordAttachment(file.size, ctx.discordAttachmentLimit)) {
    await deliverReply(interaction, {
      files: [new AttachmentBuilder(file.path, { name: filename })],
    });
    return;
  }
  if (!isR2Configured(r2Config)) {
    throw new ValidationError(`the ${format} is too large to attach to Discord.`);
  }

  const url = await uploadMediaToR2(spec.kind, file, `.${format}`, r2Config, spec.mime);
  const ttlHours = await resolveTtlHoursForSize(file.size);
  await deliverReply(interaction, {
    content: formatR2UrlWithDisclaimer(url, r2Config, ttlHours),
  });
}
