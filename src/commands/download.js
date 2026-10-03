import { MessageFlags, AttachmentBuilder } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { botConfig, r2Config } from '../utils/config.js';
import { validateUrl, firstUrlIn } from '../utils/validation.js';
import { canonicalizeMirrorUrl, isSocialMediaUrl } from '../utils/cobalt.js';
import { getYtdlpSite } from '../utils/ytdlp.js';
import {
  getGalleryDlSite,
  isMangaDexTitleUrl,
  isMangaDexChapterUrl,
  isNhentaiGalleryUrl,
} from '../utils/gallery-dl.js';
import { beginMangaSelection } from './manga.js';
import { isHentaiGifzUrl } from '../utils/hentaigifz.js';
import { isBooruUrl } from '../utils/booru.js';
import { isPinterestUrl } from '../utils/pinterest.js';
import { isKlipyUrl } from '../utils/klipy.js';
import { isThreadsUrl } from '../utils/threads.js';
import { keylessMegaFileId } from '../utils/mega.js';
import { promptForMegaKey } from './mega-key.js';
import { getDisabledServiceLabel } from '../utils/download-services.js';
import { AppError, ValidationError } from '../utils/errors.js';
import { batchAttachmentsForDelivery } from '../utils/attachment-helpers.js';
import { isDirectMediaUrl } from '../utils/file-downloader.js';
import { resolveTtlHoursForSize } from '../utils/storage.js';
import {
  uploadMediaToR2,
  isR2Configured,
  formatR2UrlWithDisclaimer,
  formatMultipleR2UrlsWithDisclaimer,
} from '../utils/r2-storage.js';
import {
  storeMedia,
  attachmentFor,
  deliverStored,
  deliverReply,
  finishCommand,
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
  safeInteractionReply,
  safeInteractionEditReply,
  safeInteractionFollowUp,
  safeInteractionDeferReply,
} from '../utils/interaction-helpers.js';
import { fitsDiscordAttachment, getDiscordAttachmentLimit } from './shared/attachment-limit.js';
import { mapLimit, ITEM_FANOUT } from '../utils/map-limit.js';

const logger = createLogger('download');

const {
  cobaltEnabled: COBALT_ENABLED,
  ytdlpEnabled: YTDLP_ENABLED,
  galleryDlEnabled: GALLERY_DL_ENABLED,
  discordSizeLimit: DISCORD_SIZE_LIMIT,
} = botConfig;

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
  if (fitsDiscordAttachment(fileData.size, attachmentLimit)) {
    await deliverReply(interaction, {
      files: [new AttachmentBuilder(fileData.path, { name: fileData.filename })],
    });
  } else if (isR2Configured(r2Config)) {
    const url = await uploadMediaToR2('archive', fileData, '.zip', r2Config);
    const ttlHours = await resolveTtlHoursForSize(fileData.size);
    await deliverReply(interaction, {
      content: formatR2UrlWithDisclaimer(url, r2Config, ttlHours),
    });
  } else {
    throw new ValidationError('this ZIP is too large to attach to Discord');
  }
  await finishCommand();
}

// Files that fit go out as attachments (split into batches); the rest become R2 links.
async function deliverGallery(interaction, ctx, fileData, attachmentLimit) {
  const stored = await mapLimit(fileData, ITEM_FANOUT, media =>
    storeMedia(media, attachmentLimit, { defaultExt: '.jpg' })
  );
  const attached = stored.filter(item => item.fits);
  const linked = stored.filter(item => !item.fits);
  const batches = batchAttachmentsForDelivery(attached.map(attachmentFor));
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
    files: batches[0],
    content: content || undefined,
  });
  if (firstMessage === false) {
    throw new AppError('could not deliver the files to discord. please try again.');
  }
  for (const batch of batches.slice(1)) {
    const message = await safeInteractionFollowUp(interaction, { files: batch });
    if (message === false) {
      throw new AppError('only part of this post could be delivered to discord. please try again.');
    }
  }

  await finishCommand();
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
      const { fileData, downloadMethod } = acquired;

      if (galleryOptions.audioOnly) {
        const { file: mp3, baseName } = await extractAudio(fileData, downloadMethod, {
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

      // yt-dlp already cut its download with --download-sections.
      let item = fileData;
      if (trimming && downloadMethod !== 'ytdlp') {
        item = await trimItem(fileData, { startTime, duration });
      }
      await deliverSingle(interaction, ctx, item, attachmentLimit);
    },
    {
      commandSource,
      errorFallback:
        'could not download this content. it may be deleted, private, age-restricted, or unsupported.',
      context: { originalUrl: url },
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
  const context = { originalUrl: url, commandSource };
  const ytdlpSite = getYtdlpSite(url);
  const galleryDlSite = getGalleryDlSite(url);

  if (ytdlpSite && !YTDLP_ENABLED) {
    const message = `${ytdlpSite.toLowerCase()} downloads are disabled.`;
    await refuse(interaction, 'download', { message, reason: 'ytdlp_disabled', context });
    return true;
  }
  if (galleryDlSite && !GALLERY_DL_ENABLED) {
    const message = `${galleryDlSite.toLowerCase()} downloads are disabled.`;
    await refuse(interaction, 'download', { message, reason: 'gallery_dl_disabled', context });
    return true;
  }
  const ownExtractor =
    ytdlpSite ||
    galleryDlSite ||
    isHentaiGifzUrl(url) ||
    isBooruUrl(url) ||
    isPinterestUrl(url) ||
    isKlipyUrl(url) ||
    isThreadsUrl(url) ||
    isDirectMediaUrl(url);
  if (ownExtractor) return false;
  if (!COBALT_ENABLED) {
    const message = 'cobalt is not enabled. please enable it to use the download command.';
    await refuse(interaction, 'download', {
      message,
      reason: 'cobalt_disabled',
      context,
    });
    return true;
  }
  if (!isSocialMediaUrl(url)) {
    const message = 'url is not from a supported social media platform.';
    const reason = 'invalid_social_media_url';
    await refuse(interaction, 'download', { message, reason, context });
    return true;
  }
  return false;
}

export async function handleDownloadContextMenuCommand(interaction) {
  if (!interaction.isMessageContextMenuCommand() || interaction.commandName !== 'download') {
    return;
  }
  const found = firstUrlIn(interaction.targetMessage.content);
  if (!found) {
    const context = { commandSource: 'context-menu' };
    const message = 'no URL found in this message.';
    await refuse(interaction, 'download', {
      message,
      reason: 'missing_url',
      context,
    });
    return;
  }
  const urlValidation = validateUrl(found);
  if (!urlValidation.valid) {
    await safeInteractionReply(interaction, {
      content: `invalid URL: ${urlValidation.error}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const url = canonicalizeMirrorUrl(found);

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
  const url = canonicalizeMirrorUrl(firstUrlIn(rawUrl) ?? rawUrl);
  const audioOnly = interaction.options.getBoolean('mp3') === true;

  const times = await resolveTimeOptions(interaction, { type: 'download' });
  if (times === null) {
    return;
  }
  const { startTime: trimStart, duration: trimDuration } = times;

  if (!url) {
    const context = { commandSource };
    const message = 'please provide a URL to download from.';
    await refuse(interaction, 'download', {
      message,
      reason: 'missing_url',
      context,
    });
    return;
  }

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

  const urlValidation = validateUrl(url);
  if (!urlValidation.valid) {
    const context = { originalUrl: url, commandSource };
    const message = `invalid URL: ${urlValidation.error}`;
    await refuse(interaction, 'download', { message, reason: 'invalid_url', context });
    return;
  }
  if (await refuseUnsupported(interaction, url, commandSource)) {
    return;
  }
  await safeInteractionDeferReply(interaction);
  await queueDownload(interaction, url, commandSource, trimStart, trimDuration, { audioOnly });
}
