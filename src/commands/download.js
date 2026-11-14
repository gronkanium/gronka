import { randomBytes } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { botConfig, r2Config } from '../utils/config.js';
import { readLink, prepareLink, refusalFor } from '../core/intake.js';
import { firstConvertibleAttachment } from '../utils/attachment-helpers.js';
import { messageMediaInput } from './shared/message-media.js';
import { startConvert } from './convert.js';
import { SITE_URL } from './info.js';
import { isShortLink } from '../utils/short-links.js';
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
import { acquireMedia } from '../core/acquire-media.js';
import { dispatchMediaJob } from '../jobs/dispatch.js';
import { resolveTimeOptions, refuse, replyError } from './shared/command-guards.js';
import { trimItem } from '../utils/video-processor.js';
import {
  safeInteractionEditReply,
  safeInteractionFollowUp,
  safeInteractionDeferReply,
} from '../utils/interaction-helpers.js';
import { fitsDiscordAttachment, getDiscordAttachmentLimit } from './shared/attachment-limit.js';
import { mediaReplyPayload, mediaReplyBatches } from './shared/media-reply.js';
import { mapLimit, ITEM_FANOUT } from '../utils/map-limit.js';

const logger = createLogger('download');

const { galleryDlEnabled: GALLERY_DL_ENABLED } = botConfig;

async function replyWithDirectMediaUrls(interaction, ctx, { urls }) {
  let followUp = false;
  for (const batch of mediaReplyBatches(urls)) {
    const payload = mediaReplyPayload(batch);
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
    { description: fileData.note }
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
      group.map((item, index) =>
        storedReplyItem(item, { description: !followUp && !index ? fileData.note : undefined })
      )
    );
    for (const batch of mediaReplyBatches(items)) {
      const payload = mediaReplyPayload(batch);
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
  for (const batch of mediaReplyBatches(replies)) {
    const payload = mediaReplyPayload(batch);
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
  await deliverStored(interaction, stored, { description: item.note });
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

      const attachmentLimit = getDiscordAttachmentLimit(interaction);
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
        commandOptions: { startTime, duration },
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
  const message =
    refusal.reason === 'invalid_social_media_url'
      ? `${refusal.message} supported sites are listed on <${SITE_URL}/#sites>.`
      : refusal.message;
  await refuse(interaction, 'download', {
    ...refusal,
    message,
    detail: refusal.message,
    context: { originalUrl: url, commandSource },
  });
  return true;
}

// Resolving a short link can outlast the 3 s Discord allows before the first response.
async function prepareAcknowledged(interaction, url) {
  if (isShortLink(url)) await safeInteractionDeferReply(interaction);
  return prepareLink(url);
}

const CONVERT_OFFER = 'convertoffer:';

async function refuseNoLink(interaction, pending) {
  const { attachment } = messageMediaInput(interaction.targetMessage, firstConvertibleAttachment);
  let components;
  if (attachment) {
    const id = `${CONVERT_OFFER}${randomBytes(12).toString('hex')}`;
    pending.set(id, { attachment, timestamp: Date.now() });
    const button = new ButtonBuilder()
      .setCustomId(id)
      .setLabel('convert it')
      .setStyle(ButtonStyle.Primary);
    components = [new ActionRowBuilder().addComponents(button)];
  }
  await refuse(interaction, 'download', {
    message: attachment
      ? 'this message has no link to download, but its file can be converted.'
      : 'this message has no link to download. use /download and paste one.',
    detail: 'no URL found in this message.',
    reason: 'missing_url',
    components,
    context: { commandSource: 'context-menu' },
  });
}

export async function handleConvertOffer(interaction, pending) {
  if (!interaction.customId?.startsWith(CONVERT_OFFER)) return false;
  const offer = pending.get(interaction.customId);
  pending.delete(interaction.customId);
  if (!offer) {
    await replyError(
      interaction,
      'this button has expired. right-click the message and pick apps > convert.'
    );
    return true;
  }
  await startConvert(interaction, { attachment: offer.attachment, commandSource: 'context-menu' });
  return true;
}

export async function handleDownloadContextMenuCommand(interaction, pending) {
  if (!interaction.isMessageContextMenuCommand() || interaction.commandName !== 'download') {
    return;
  }
  const { url: link } = messageMediaInput(interaction.targetMessage, () => null);
  if (!link) {
    await refuseNoLink(interaction, pending);
    return;
  }
  const read = readLink(link);
  if (read.refusal) {
    await refuse(interaction, 'download', {
      ...read.refusal,
      context: { commandSource: 'context-menu' },
    });
    return;
  }
  const url = await prepareAcknowledged(interaction, read.url);

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
  const commandSource = 'slash';

  const rawUrl = interaction.options.getString('link');
  const read = readLink(rawUrl, 'please provide a URL to download from.');
  if (read.refusal) {
    const context = { originalUrl: rawUrl, commandSource };
    await refuse(interaction, 'download', { ...read.refusal, context });
    return;
  }

  const times = await resolveTimeOptions(interaction, { type: 'download' });
  if (times === null) {
    return;
  }
  const { startTime: trimStart, duration: trimDuration } = times;
  const url = await prepareAcknowledged(interaction, read.url);

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
  if (megaFileId) {
    await promptForMegaKey(interaction, megaFileId, commandSource, trimStart, trimDuration);
    return;
  }

  if (await refuseUnsupported(interaction, url, commandSource)) {
    return;
  }
  await safeInteractionDeferReply(interaction);
  await queueDownload(interaction, url, commandSource, trimStart, trimDuration);
}
