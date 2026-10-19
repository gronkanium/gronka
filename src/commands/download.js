import { createLogger } from '../utils/logger.js';
import { botConfig, r2Config } from '../utils/config.js';
import { firstUrlIn } from '../utils/validation.js';
import { readLink, prepareLink, refusalFor } from '../core/intake.js';
import {
  isMangaDexTitleUrl,
  isMangaDexChapterUrl,
  isNhentaiGalleryUrl,
} from '../utils/gallery-dl.js';
import { beginMangaSelection } from './manga.js';
import { keylessMegaFileId } from '../utils/mega.js';
import { promptForMegaKey } from './mega-key.js';
import { getDisabledServiceLabel } from '../utils/download-services.js';
import { ValidationError } from '../utils/errors.js';
import { batchAttachmentsForDelivery } from '../utils/attachment-helpers.js';
import { resolveTtlHoursForSize } from '../utils/storage.js';
import { isR2Configured, formatMultipleR2UrlsWithDisclaimer } from '../utils/r2-storage.js';
import {
  storeMedia,
  attachmentFor,
  deliverStored,
  deliverReply,
  finishCommand,
  toR2,
  deliveryError,
  canRecoverUpload,
} from './shared/deliver.js';
import { runMediaCommand } from './shared/run-media-command.js';
import { acquireMedia, extractAudio } from '../core/acquire-media.js';
import { dispatchMediaJob } from '../jobs/dispatch.js';
import {
  resolveTimeOptions,
  refuse,
  replyError,
  commandSourceOf,
} from './shared/command-guards.js';
import { trimItem } from '../utils/video-processor.js';
import { sendConvertedFile } from './shared/send-converted.js';
import {
  safeInteractionEditReply,
  safeInteractionFollowUp,
  safeInteractionDeferReply,
} from '../utils/interaction-helpers.js';
import { fitsDiscordAttachment, getDiscordAttachmentLimit } from './shared/attachment-limit.js';
import { mapLimit, ITEM_FANOUT } from '../utils/map-limit.js';

const logger = createLogger('download');

const { galleryDlEnabled: GALLERY_DL_ENABLED, discordSizeLimit: DISCORD_SIZE_LIMIT } = botConfig;

// Discord caps a message at 2000 characters, so as many links as fit.
async function replyWithDirectMediaUrls(interaction, ctx, { urls }) {
  const lines = [];
  let length = 0;
  for (const item of urls) {
    if (length + item.url.length + 1 > 1990) break;
    lines.push(item.url);
    length += item.url.length + 1;
  }
  await deliverReply(interaction, { content: lines.join('\n') });
  await finishCommand();
}

async function deliverArchive(interaction, ctx, fileData, attachmentLimit) {
  if (!fitsDiscordAttachment(fileData.size, attachmentLimit) && !isR2Configured(r2Config)) {
    throw new ValidationError('this ZIP is too large to attach to Discord');
  }
  await deliverStored(
    interaction,
    await storeMedia(fileData, attachmentLimit, { defaultExt: '.zip' }),
    {
      name: fileData.filename,
    }
  );
  await finishCommand();
}

// Files that fit go out as attachments (split into batches); the rest become R2 links.
async function deliverGallery(interaction, ctx, fileData, attachmentLimit) {
  const stored = await mapLimit(fileData, ITEM_FANOUT, media =>
    storeMedia(media, attachmentLimit, { defaultExt: '.jpg' })
  );
  const attached = stored.filter(item => item.fits);
  const linked = stored.filter(item => !item.fits);
  const batches = batchAttachmentsForDelivery(attached);
  const ttlHours = linked.length
    ? await resolveTtlHoursForSize(Math.max(...linked.map(item => item.size)))
    : null;
  const content = formatMultipleR2UrlsWithDisclaimer(
    linked.map(item => item.url),
    r2Config,
    ttlHours
  );

  // A false from the send helpers is a failed delivery, never a success.
  const firstMessage = await safeInteractionEditReply(interaction, {
    files: batches[0]?.map(item => attachmentFor(item, attached.indexOf(item))),
    content: content || undefined,
  });
  if (firstMessage === false) {
    if (!batches[0]?.length || !canRecoverUpload(interaction)) throw deliveryError(interaction);
    await deliverGalleryLinks(interaction, [...batches[0], ...linked]);
  }
  for (const batch of batches.slice(1)) {
    const message = await safeInteractionFollowUp(interaction, {
      files: batch.map(item => attachmentFor(item, attached.indexOf(item))),
    });
    if (message === false) {
      if (!canRecoverUpload(interaction)) throw deliveryError(interaction, true);
      await deliverGalleryLinks(interaction, batch, true);
    }
  }

  await finishCommand();
}

async function deliverGalleryLinks(interaction, items, followUp = false) {
  const linked = await mapLimit(items, ITEM_FANOUT, toR2);
  const ttlHours = await resolveTtlHoursForSize(Math.max(...items.map(item => item.size)));
  const chunks = [];
  let urls = [];
  for (const item of linked) {
    const next = [...urls, item.url];
    if (urls.length && formatMultipleR2UrlsWithDisclaimer(next, r2Config, ttlHours).length > 2000) {
      chunks.push(urls);
      urls = [];
    }
    urls.push(item.url);
  }
  chunks.push(urls);
  for (const chunk of chunks) {
    const payload = { content: formatMultipleR2UrlsWithDisclaimer(chunk, r2Config, ttlHours) };
    if (followUp) {
      if ((await safeInteractionFollowUp(interaction, payload)) === false)
        throw deliveryError(interaction, true);
    } else {
      await deliverReply(interaction, payload);
      followUp = true;
    }
  }
}

async function deliverSingle(interaction, ctx, item, attachmentLimit) {
  const stored = await storeMedia(item, attachmentLimit);
  await deliverStored(interaction, stored);
  await finishCommand();
}

export async function processDownload(
  interaction,
  url,
  commandSource = null,
  startTime = null,
  duration = null,
  galleryOptions = {}
) {
  await runMediaCommand(
    'download',
    interaction,
    async ctx => {
      const trimming = startTime !== null || duration !== null;

      const disabledServiceLabel = await getDisabledServiceLabel(url);
      if (disabledServiceLabel) {
        throw new ValidationError(`downloads from ${disabledServiceLabel} are turned off.`);
      }

      const attachmentLimit = getDiscordAttachmentLimit(interaction, DISCORD_SIZE_LIMIT);
      const acquired = await acquireMedia(url, {
        startTime,
        duration,
        galleryOptions,
        attachmentLimit,
        client: interaction.client,
      });
      if (acquired.kind === 'urls') {
        return replyWithDirectMediaUrls(interaction, ctx, acquired);
      }
      url = acquired.url;
      const { fileData } = acquired;

      if (galleryOptions.audioOnly) {
        const { file: mp3, baseName } = await extractAudio(fileData, {
          startTime,
          duration,
        });
        await sendConvertedFile(
          interaction,
          { ...ctx, discordAttachmentLimit: attachmentLimit },
          { file: mp3, format: 'mp3', baseName }
        );
        return finishCommand();
      }
      if (fileData?.archive) {
        return deliverArchive(interaction, ctx, fileData, attachmentLimit);
      }
      if (Array.isArray(fileData)) {
        return deliverGallery(interaction, ctx, fileData, attachmentLimit);
      }

      let item = fileData;
      if (trimming && !fileData.trimmed) {
        item = await trimItem(fileData, { startTime, duration });
      }
      await deliverSingle(interaction, ctx, item, attachmentLimit);
    },
    {
      commandSource,
      errorFallback: 'something broke on our end with this download. it has been logged.',
      context: {
        originalUrl: url,
        commandOptions: { startTime, duration, mp3: galleryOptions.audioOnly },
      },
    }
  );
}

// processDownload's signature, run by a worker when workers are on.
export function queueDownload(
  interaction,
  url,
  commandSource,
  startTime,
  duration,
  galleryOptions
) {
  return dispatchMediaJob(interaction, 'download', {
    url,
    commandSource,
    startTime,
    duration,
    galleryOptions,
  });
}

// Replies and returns true when no extractor can take this URL.
async function refuseUnsupported(interaction, url, commandSource) {
  const refusal = refusalFor(url);
  if (!refusal) return false;
  await refuse(interaction, 'download', {
    ...refusal,
    context: { originalUrl: url, commandSource },
  });
  return true;
}

export async function handleDownloadContextMenuCommand(interaction) {
  if (!interaction.isMessageContextMenuCommand() || interaction.commandName !== 'download') {
    return;
  }
  const read = readLink(
    firstUrlIn(interaction.targetMessage.content),
    'no URL found in this message.'
  );
  if (read.refusal) {
    await refuse(interaction, 'download', {
      ...read.refusal,
      context: { commandSource: 'context-menu' },
    });
    return;
  }
  const url = await prepareLink(read.url);

  const megaFileId = keylessMegaFileId(url);
  if (megaFileId) {
    await promptForMegaKey(interaction, megaFileId, 'context-menu', null, null);
    return;
  }
  if (await refuseUnsupported(interaction, url, 'context-menu')) {
    return;
  }
  await safeInteractionDeferReply(interaction);
  await queueDownload(interaction, url, 'context-menu', null, null, {});
}

export async function handleDownloadCommand(interaction) {
  const commandSource = commandSourceOf(interaction);

  const rawUrl = interaction.options.getString('url');
  const read = readLink(rawUrl, 'please provide a URL to download from.');
  if (read.refusal) {
    const context = { originalUrl: rawUrl, commandSource };
    await refuse(interaction, 'download', { ...read.refusal, context });
    return;
  }
  const url = await prepareLink(read.url);
  const audioOnly = interaction.options.getBoolean('mp3') === true;

  const times = await resolveTimeOptions(interaction, { type: 'download' });
  if (times === null) {
    return;
  }
  const { startTime: trimStart, duration: trimDuration } = times;

  if (
    GALLERY_DL_ENABLED &&
    (isMangaDexTitleUrl(url) || isMangaDexChapterUrl(url) || isNhentaiGalleryUrl(url))
  ) {
    try {
      await beginMangaSelection(interaction, url);
    } catch (error) {
      logger.warn(`Manga selection failed: ${error.message}`);
      const content = 'could not inspect that manga. please try again later.';
      await replyError(interaction, content);
    }
    return;
  }

  const megaFileId = keylessMegaFileId(url);
  if (megaFileId && interaction.isPrefixCommand) {
    const message = 'send the full mega link including the key (the part after #).';
    await refuse(interaction, 'download', {
      message,
      reason: 'missing_input',
      context: { originalUrl: url, commandSource },
    });
    return;
  }
  if (megaFileId) {
    await promptForMegaKey(
      interaction,
      megaFileId,
      commandSource,
      trimStart,
      trimDuration,
      audioOnly
    );
    return;
  }

  if (await refuseUnsupported(interaction, url, commandSource)) {
    return;
  }
  await safeInteractionDeferReply(interaction);
  await queueDownload(interaction, url, commandSource, trimStart, trimDuration, { audioOnly });
}
