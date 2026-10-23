import { r2Config } from '../../utils/config.js';
import { ValidationError } from '../../utils/errors.js';
import { storeMedia, deliverStored } from './deliver.js';
import { isR2Configured } from '../../utils/r2-storage.js';
import { fitsDiscordAttachment } from './attachment-limit.js';

export async function sendConvertedFile(interaction, ctx, { file, format, baseName }) {
  if (!fitsDiscordAttachment(file.size, ctx.discordAttachmentLimit) && !isR2Configured(r2Config)) {
    throw new ValidationError(`the ${format} is too large to attach to Discord.`);
  }
  const stored = await storeMedia(file, ctx.discordAttachmentLimit, { defaultExt: `.${format}` });
  await deliverStored(interaction, stored, { name: `${baseName}.${format}` });
}
