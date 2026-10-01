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
import { keylessMegaFileId } from '../utils/mega.js';
import { promptForMegaKey } from './mega-key.js';
import { getDisabledServiceLabel } from '../utils/download-services.js';
import { AppError, ValidationError } from '../utils/errors.js';
import { batchAttachmentsForDelivery } from '../utils/attachment-helpers.js';
import { isAdmin } from '../utils/rate-limit.js';
import { isDirectMediaUrl } from '../utils/file-downloader.js';
import { logOperationStep } from '../utils/operations-tracker.js';
import { resolveTtlHoursForSize } from '../utils/storage.js';
import {
  uploadMediaToR2,
  isR2Configured,
  formatR2UrlWithDisclaimer,
  formatMultipleR2UrlsWithDisclaimer,
} from '../utils/r2-storage.js';
import { storeMedia, toR2, attachmentFor, deliverStored, finishCommand } from './shared/deliver.js';
import { hashUrl } from '../utils/hashing.js';
import { getProcessedUrl } from '../utils/database.js';
import { recordProcessedUrl, trackR2UploadIfApplicable } from './shared/url-cache.js';
import { runMediaCommand } from './shared/run-media-command.js';
import { acquireMedia, extractAudio } from '../core/acquire-media.js';
import { dispatchMediaJob } from '../jobs/dispatch.js';
import {
  replyIfRateLimited,
  resolveTimeOptions,
  refuse,
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

const logger = createLogger('download');

const {
  cobaltEnabled: COBALT_ENABLED,
  ytdlpEnabled: YTDLP_ENABLED,
  galleryDlEnabled: GALLERY_DL_ENABLED,
  discordSizeLimit: DISCORD_SIZE_LIMIT,
} = botConfig;

// Discord caps a message at 2000 characters, so as many links as fit.
async function replyWithDirectMediaUrls(interaction, ctx, { url, urls, stepName }) {
  const lines = [];
  let length = 0;
  for (const item of urls) {
    if (length + item.url.length + 1 > 1990) break;
    lines.push(item.url);
    length += item.url.length + 1;
  }
  logOperationStep(ctx.operationId, stepName, 'success', {
    message: `Returning ${lines.length} direct media URL(s) without downloading`,
    metadata: { url, mediaUrls: lines },
  });
  await safeInteractionEditReply(interaction, { content: lines.join('\n') });
  await finishCommand('download', ctx, 0);
}

async function deliverArchive(interaction, ctx, fileData, attachmentLimit) {
  if (fitsDiscordAttachment(fileData.size, attachmentLimit)) {
    await safeInteractionEditReply(interaction, {
      files: [new AttachmentBuilder(fileData.path, { name: fileData.filename })],
    });
  } else if (isR2Configured(r2Config)) {
    const archiveHash = fileData.hash;
    const url = await uploadMediaToR2(
      'archive',
      fileData,
      archiveHash,
      '.zip',
      r2Config,
      ctx.buildMetadata()
    );
    const archiveUrlHash = hashUrl(`${url}#archive:${archiveHash}`);
    await recordProcessedUrl({
      urlHash: archiveUrlHash,
      contentHash: archiveHash,
      fileType: 'archive',
      fileExtension: '.zip',
      fileUrl: url,
      userId: ctx.userId,
      fileSize: fileData.size,
    });
    await trackR2UploadIfApplicable(archiveUrlHash, url, ctx.adminUser);
    const ttlHours = await resolveTtlHoursForSize(fileData.size);
    await safeInteractionEditReply(interaction, {
      content: formatR2UrlWithDisclaimer(url, r2Config, ctx.adminUser, ttlHours),
    });
  } else {
    throw new ValidationError('this ZIP is too large to attach to Discord');
  }
  await finishCommand('download', ctx, fileData.size);
}

// Files that fit go out as attachments (split into batches); the rest become R2 links.
async function deliverGallery(interaction, ctx, fileData, urlHash, attachmentLimit) {
  const { userId, adminUser } = ctx;
  logger.debug(`Processing ${fileData.length} media files from picker`);
  const stored = [];
  for (const media of fileData) {
    const item = await storeMedia(media, ctx, attachmentLimit, { defaultExt: '.jpg' });
    stored.push(item.fits ? item : await toR2(item, ctx));
  }
  const attached = stored.filter(item => item.fits);
  const linked = stored.filter(item => !item.fits);
  const batches = batchAttachmentsForDelivery(attached.map(attachmentFor));
  const content = formatMultipleR2UrlsWithDisclaimer(
    linked.map(item => item.url),
    r2Config,
    adminUser
  );

  // A false from the send helpers is a failed delivery, never a success.
  const firstMessage = await safeInteractionEditReply(interaction, {
    files: batches[0],
    content: content || undefined,
  });
  if (firstMessage === false) {
    throw new AppError('could not deliver the files to discord. please try again.');
  }
  const sent = [firstMessage];
  for (const batch of batches.slice(1)) {
    const message = await safeInteractionFollowUp(interaction, { files: batch });
    if (message === false) {
      throw new AppError('only part of this post could be delivered to discord. please try again.');
    }
    sent.push(message);
  }

  const discordUrls = sent.flatMap(message =>
    message?.attachments ? Array.from(message.attachments.values(), a => a.url) : []
  );
  const record = (item, fileUrl) =>
    recordProcessedUrl({
      urlHash,
      contentHash: item.hash,
      fileType: item.type,
      fileExtension: item.ext,
      fileUrl,
      userId,
      fileSize: item.size,
    });
  for (const [i, item] of attached.entries()) {
    if (discordUrls[i]) await record(item, discordUrls[i]);
  }
  for (const item of linked) {
    await record(item, item.url);
    await trackR2UploadIfApplicable(urlHash, item.url, adminUser);
  }
  const totalSize = fileData.reduce((sum, media) => sum + media.size, 0);
  await finishCommand('download', ctx, totalSize, { mediaCount: stored.length });
}

// A file already in storage is answered with its link, like the URL cache above.
async function deliverSingle(interaction, ctx, item, urlHash, attachmentLimit) {
  const stored = await storeMedia(item, ctx, attachmentLimit);
  if (stored.cached) {
    logger.debug(`${stored.type} already exists (hash: ${stored.hash}) for user ${ctx.userId}`);
  }
  await deliverStored(interaction, ctx, stored.cached ? { ...stored, fits: false } : stored, {
    urlHash,
  });
  await finishCommand('download', ctx, stored.size);
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
      const { operationId, adminUser } = ctx;
      const trimming = startTime !== null || duration !== null;

      // Checked before the URL cache so a disabled source can't serve an old download either.
      const disabledServiceLabel = await getDisabledServiceLabel(url);
      if (disabledServiceLabel) {
        logOperationStep(operationId, 'service_disabled', 'success', {
          message: 'Download source is turned off',
          metadata: { url, service: disabledServiceLabel },
        });
        throw new ValidationError(`downloads from ${disabledServiceLabel} are turned off.`);
      }

      // A trimmed or audio request is a different file, so it never reuses the URL cache.
      const urlHash = hashUrl(url);
      const cacheable = !galleryOptions.mediaUrls && !galleryOptions.audioOnly && !trimming;
      const cachedRow = cacheable ? await getProcessedUrl(urlHash) : null;
      if (cachedRow?.file_type === 'video' && !cachedRow.r2_expired_at) {
        logOperationStep(operationId, 'url_cache_hit', 'success', {
          message: 'URL already processed as video, returning cached result',
          metadata: { url, cachedUrl: cachedRow.file_url },
        });
        await safeInteractionEditReply(interaction, {
          content: formatR2UrlWithDisclaimer(cachedRow.file_url, r2Config, adminUser),
        });
        return finishCommand('download', ctx, 0);
      }
      logOperationStep(operationId, 'url_cache_miss', 'success', {
        message: cachedRow
          ? 'Cached result is expired or not a video, downloading again'
          : 'URL not in cache, downloading',
        metadata: { url, cachedType: cachedRow?.file_type ?? null },
      });

      const attachmentLimit = getDiscordAttachmentLimit(interaction, DISCORD_SIZE_LIMIT);
      const acquired = await acquireMedia(url, {
        adminUser,
        startTime,
        duration,
        galleryOptions,
        attachmentLimit,
        client: interaction.client,
        logStep: ctx.logStep,
      });
      if (acquired.kind === 'urls') {
        return replyWithDirectMediaUrls(interaction, ctx, acquired);
      }
      url = acquired.url;
      const { fileData, downloadMethod } = acquired;

      if (galleryOptions.audioOnly) {
        logOperationStep(operationId, 'audio_extract', 'running', {
          message: 'Extracting audio as mp3',
          metadata: { url },
        });
        const { file: mp3, baseName } = await extractAudio(fileData, downloadMethod, {
          startTime,
          duration,
        });
        await sendConvertedFile(
          interaction,
          { ...ctx, discordAttachmentLimit: attachmentLimit },
          { file: mp3, format: 'mp3', baseName }
        );
        logOperationStep(operationId, 'audio_extract', 'success', {
          message: 'mp3 delivered',
          metadata: { url, fileSize: mp3.size },
        });
        return finishCommand('download', ctx, mp3.size);
      }
      if (fileData?.archive) {
        return deliverArchive(interaction, ctx, fileData, attachmentLimit);
      }
      if (Array.isArray(fileData)) {
        return deliverGallery(interaction, ctx, fileData, urlHash, attachmentLimit);
      }

      // yt-dlp already cut its download with --download-sections.
      let item = fileData;
      if (trimming && downloadMethod !== 'ytdlp') {
        item = await trimItem(fileData, { startTime, duration });
        logOperationStep(operationId, 'media_trim', item === fileData ? 'error' : 'success', {
          message: item === fileData ? 'Trim failed, sending the untrimmed file' : 'Trimmed',
          metadata: { startTime, duration, originalSize: fileData.size },
        });
      }
      await deliverSingle(interaction, ctx, item, urlHash, attachmentLimit);
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
    isDirectMediaUrl(url);
  if (ownExtractor) return false;
  if (!COBALT_ENABLED) {
    const message = 'cobalt is not enabled. please enable it to use the download command.';
    await refuse(interaction, 'download', {
      message,
      reason: 'cobalt_disabled',
      context,
      notify: true,
    });
    return true;
  }
  if (!isSocialMediaUrl(url)) {
    const message = 'url is not from a supported social media platform.';
    const reason = 'invalid_social_media_url';
    await refuse(interaction, 'download', { message, reason, context, notify: true });
    return true;
  }
  return false;
}

export async function handleDownloadContextMenuCommand(interaction) {
  if (!interaction.isMessageContextMenuCommand() || interaction.commandName !== 'download') {
    return;
  }
  const userId = interaction.user.id;
  logger.debug(`User ${userId} initiated download via context menu`);
  const guard = { type: 'download', action: 'downloading another video' };
  if (await replyIfRateLimited(interaction, { ...guard, commandSource: 'context-menu' })) {
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
      notify: true,
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
  const userId = interaction.user.id;
  const commandSource = commandSourceOf(interaction);
  logger.debug(`User ${userId} initiated download${isAdmin(userId) ? ' [ADMIN]' : ''}`);
  const guard = { type: 'download', action: 'downloading another video' };
  if (await replyIfRateLimited(interaction, { ...guard, commandSource })) {
    return;
  }

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
      notify: true,
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
      await (interaction.deferred
        ? safeInteractionEditReply(interaction, { content })
        : safeInteractionReply(interaction, { content, flags: MessageFlags.Ephemeral }));
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
