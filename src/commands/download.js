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
import { isR2Configured } from '../utils/r2-storage.js';
import {
  storeMedia,
  storedReplyItem,
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
import { mediaReplyPayload, mediaReplyBatches } from './shared/media-reply.js';
import { mapLimit, ITEM_FANOUT } from '../utils/map-limit.js';

const logger = createLogger('download');

const { galleryDlEnabled: GALLERY_DL_ENABLED, discordSizeLimit: DISCORD_SIZE_LIMIT } = botConfig;

async function replyWithDirectMediaUrls(interaction, ctx, { urls }) {
  let followUp = false;
  for (const batch of mediaReplyBatches(interaction, urls)) {
    const payload = mediaReplyPayload(interaction, batch);
    if (followUp) {
      if ((await safeInteractionFollowUp(interaction, payload)) === false)
        throw deliveryError(interaction, true);
    } else {
      await deliverReply(interaction, payload);
      followUp = true;
    }
  }
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
  const groups = [[...(batches[0] ?? []), ...linked], ...batches.slice(1)];
  let followUp = false;
  for (const group of groups) {
    const items = await Promise.all(
      group.map(item => storedReplyItem(item, { index: stored.indexOf(item) }))
    );
    for (const batch of mediaReplyBatches(interaction, items)) {
      const payload = mediaReplyPayload(interaction, batch);
      const send = followUp ? safeInteractionFollowUp : safeInteractionEditReply;
      const message = await send(interaction, payload);
      if (message === false) {
        if (!payload.files?.length || !canRecoverUpload(interaction))
          throw deliveryError(interaction, followUp);
        const storedBatch = batch.map(item => group[items.indexOf(item)]);
        await deliverGalleryLinks(interaction, storedBatch, followUp);
      }
      followUp = true;
    }
  }
  await finishCommand();
}

async function deliverGalleryLinks(interaction, items, followUp = false) {
  const linked = await mapLimit(items, ITEM_FANOUT, async item => ({
    ...(await toR2(item)),
    fits: false,
  }));
  const replies = await Promise.all(linked.map(item => storedReplyItem(item)));
  for (const batch of mediaReplyBatches(interaction, replies)) {
    const payload = mediaReplyPayload(interaction, batch);
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
  const refusal = await refusalFor(url);
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
