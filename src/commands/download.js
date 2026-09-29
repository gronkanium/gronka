import { MessageFlags, AttachmentBuilder } from 'discord.js';
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../utils/logger.js';
import { botConfig } from '../utils/config.js';
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
import { isAdmin, recordRateLimit } from '../utils/rate-limit.js';
import { generateHash, isDirectMediaUrl } from '../utils/file-downloader.js';
import {
  createFailedOperation,
  updateOperationStatus,
  logOperationStep,
} from '../utils/operations-tracker.js';
import {
  gifExists,
  getGifPath,
  videoExists,
  getVideoPath,
  imageExists,
  getImagePath,
  saveGif,
  saveVideo,
  saveImage,
  detectFileType,
  resolveTtlHoursForSize,
} from '../utils/storage.js';
import { cleanupTempFiles as storageCleanupTempFiles } from '../utils/storage.js';
import {
  uploadGifToR2,
  uploadVideoToR2,
  uploadImageToR2,
  uploadArchiveToR2,
  formatR2UrlWithDisclaimer,
  formatMultipleR2UrlsWithDisclaimer,
} from '../utils/r2-storage.js';
import { hashUrl } from '../utils/hashing.js';
import { notifyCommandSuccess, notifyCommandFailure } from '../utils/ntfy-notifier.js';
import { getProcessedUrl } from '../utils/database.js';
import { recordProcessedUrl, trackR2UploadIfApplicable } from './shared/url-cache.js';
import { runMediaCommand } from './shared/run-media-command.js';
import { acquireMedia, extractAudio } from '../core/acquire-media.js';
import { replyIfRateLimited, resolveTimeOptions } from './shared/command-guards.js';
import { r2Config } from '../utils/config.js';
import { trimVideo, trimGif } from '../utils/video-processor.js';
import { sendConvertedFile } from './shared/send-converted.js';
import {
  safeInteractionReply,
  safeInteractionEditReply,
  safeInteractionFollowUp,
  safeInteractionDeferReply,
} from '../utils/interaction-helpers.js';
import tmp from 'tmp';
import { fitsDiscordAttachment, getDiscordAttachmentLimit } from './shared/attachment-limit.js';

const logger = createLogger('download');

const {
  gifStoragePath: GIF_STORAGE_PATH,
  cdnBaseUrl: CDN_BASE_URL,
  cobaltEnabled: COBALT_ENABLED,
  ytdlpEnabled: YTDLP_ENABLED,
  galleryDlEnabled: GALLERY_DL_ENABLED,
  discordSizeLimit: DISCORD_SIZE_LIMIT,
} = botConfig;

async function replyWithDirectMediaUrls({ interaction, operationId, userId, url, urls, stepName }) {
  // Discord message limit is 2000 chars; include as many URLs as fit
  const lines = [];
  let totalLength = 0;
  for (const item of urls) {
    if (totalLength + item.url.length + 1 > 1990) {
      break;
    }
    lines.push(item.url);
    totalLength += item.url.length + 1;
  }
  logOperationStep(operationId, stepName, 'success', {
    message: `Returning ${lines.length} direct media URL(s) without downloading`,
    metadata: { url, mediaUrls: lines },
  });
  updateOperationStatus(operationId, 'success', { fileSize: 0 });
  recordRateLimit(userId);
  await safeInteractionEditReply(interaction, { content: lines.join('\n') });
  await notifyCommandSuccess('download', { operationId, userId });
}

async function cleanupTempFiles(tmpDir, files = []) {
  await storageCleanupTempFiles(files);
  try {
    tmpDir.removeCallback();
  } catch (cleanupError) {
    logger.warn(`Failed to clean up temp directory: ${cleanupError.message}`);
  }
}

/**
 * Process download from URL
 * @param {Interaction} interaction - Discord interaction
 * @param {string} url - URL to download from
 * @param {string} [commandSource] - Command source ('slash' or 'context-menu')
 * @param {number|null} [startTime] - Start time in seconds for video trimming (optional)
 * @param {number|null} [duration] - Duration in seconds for video trimming (optional)
 */
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
      const { operationId, userId, adminUser, buildMetadata } = ctx;

      // Refuse sources that have been turned off in the webui (checked before the URL
      // cache so a disabled source can't serve a previously-downloaded file either).
      const disabledServiceLabel = await getDisabledServiceLabel(url);
      if (disabledServiceLabel) {
        logOperationStep(operationId, 'service_disabled', 'success', {
          message: 'Download source is turned off',
          metadata: { url, service: disabledServiceLabel },
        });
        throw new ValidationError(`downloads from ${disabledServiceLabel} are turned off.`);
      }

      logOperationStep(operationId, 'url_validation', 'running', {
        message: 'Validating URL',
        metadata: { url },
      });

      // Skip URL cache if time parameters are provided (trimmed videos are different from untrimmed)
      // Also skip cache if cached result is not a video (e.g., if it was converted to GIF)
      const urlHash = hashUrl(url);
      if (
        !galleryOptions.mediaUrls &&
        !galleryOptions.audioOnly &&
        startTime === null &&
        duration === null
      ) {
        const processedUrl = await getProcessedUrl(urlHash);
        if (processedUrl) {
          // Only use cached URL if it's a video (download command expects video, not GIF/image)
          // and its R2 upload hasn't expired (a stale file_url would be a dead link)
          if (processedUrl.file_type === 'video' && !processedUrl.r2_expired_at) {
            logger.info(
              `URL already processed as video (hash: ${urlHash.substring(0, 8)}...), returning existing file URL: ${processedUrl.file_url}`
            );
            logOperationStep(operationId, 'url_validation', 'success', {
              message: 'URL validation complete',
              metadata: { url },
            });
            logOperationStep(operationId, 'url_cache_hit', 'success', {
              message: 'URL already processed as video, returning cached result',
              metadata: {
                url,
                cachedUrl: processedUrl.file_url,
                cachedType: processedUrl.file_type,
              },
            });
            const fileUrl = processedUrl.file_url;
            updateOperationStatus(operationId, 'success', { fileSize: 0 });
            recordRateLimit(userId);
            await safeInteractionEditReply(interaction, {
              content: formatR2UrlWithDisclaimer(fileUrl, r2Config, adminUser),
            });
            await notifyCommandSuccess('download', { operationId, userId });
            return;
          } else if (processedUrl.r2_expired_at) {
            logger.info(
              `URL cache exists but its R2 upload expired (hash: ${urlHash.substring(0, 8)}...), downloading fresh instead of returning a dead link`
            );
            logOperationStep(operationId, 'url_cache_mismatch', 'running', {
              message: 'Cached URL expired from R2, downloading video instead',
              metadata: { url },
            });
          } else {
            logger.info(
              `URL cache exists but file type is ${processedUrl.file_type} (not video), skipping cache to download video`
            );
            logOperationStep(operationId, 'url_cache_mismatch', 'running', {
              message: 'URL cached with different file type, downloading video instead',
              metadata: { url, cachedType: processedUrl.file_type },
            });
          }
        }
      } else {
        logger.info(
          `Skipping URL cache check due to time parameters (startTime: ${startTime}, duration: ${duration})`
        );
      }

      logOperationStep(operationId, 'url_validation', 'success', {
        message: 'URL validation complete',
        metadata: { url },
      });
      logOperationStep(operationId, 'url_cache_miss', 'running', {
        message: 'URL not found in cache, proceeding with download',
        metadata: { url },
      });
      logOperationStep(operationId, 'url_cache_miss', 'success', {
        message: 'URL cache check complete, proceeding with download',
        metadata: { url },
      });

      const discordAttachmentLimit = getDiscordAttachmentLimit(interaction, DISCORD_SIZE_LIMIT);
      const acquired = await acquireMedia(url, {
        adminUser,
        startTime,
        duration,
        galleryOptions,
        attachmentLimit: discordAttachmentLimit,
        client: interaction.client,
        logStep: ctx.logStep,
      });
      if (acquired.kind === 'urls') {
        await replyWithDirectMediaUrls({
          interaction,
          operationId,
          userId,
          url: acquired.url,
          urls: acquired.urls,
          stepName: acquired.stepName,
        });
        return;
      }
      url = acquired.url;
      const { fileData, downloadMethod } = acquired;

      if (galleryOptions.audioOnly) {
        logOperationStep(operationId, 'audio_extract', 'running', {
          message: 'Extracting audio as mp3',
          metadata: { url },
        });
        const { buffer: mp3, baseName } = await extractAudio(fileData, downloadMethod, {
          startTime,
          duration,
        });
        await sendConvertedFile(
          interaction,
          { ...ctx, discordAttachmentLimit },
          { buffer: mp3, format: 'mp3', baseName }
        );
        logOperationStep(operationId, 'audio_extract', 'success', {
          message: 'mp3 delivered',
          metadata: { url, fileSize: mp3.length },
        });
        updateOperationStatus(operationId, 'success', { fileSize: mp3.length });
        recordRateLimit(userId);
        await notifyCommandSuccess('download', { operationId, userId });
        return;
      }

      if (fileData?.archive) {
        const archiveHash = generateHash(fileData.buffer);
        if (fitsDiscordAttachment(fileData.size, discordAttachmentLimit)) {
          await safeInteractionEditReply(interaction, {
            files: [new AttachmentBuilder(fileData.buffer, { name: fileData.filename })],
          });
        } else if (
          r2Config.accountId &&
          r2Config.accessKeyId &&
          r2Config.secretAccessKey &&
          r2Config.bucketName
        ) {
          const url = await uploadArchiveToR2(
            fileData.buffer,
            archiveHash,
            r2Config,
            buildMetadata()
          );
          const archiveUrlHash = hashUrl(`${url}#archive:${archiveHash}`);
          await recordProcessedUrl({
            urlHash: archiveUrlHash,
            contentHash: archiveHash,
            fileType: 'archive',
            fileExtension: '.zip',
            fileUrl: url,
            userId,
            fileSize: fileData.size,
          });
          await trackR2UploadIfApplicable(archiveUrlHash, url, adminUser);
          const deliveredTtlHours = await resolveTtlHoursForSize(fileData.size);
          await safeInteractionEditReply(interaction, {
            content: formatR2UrlWithDisclaimer(url, r2Config, adminUser, deliveredTtlHours),
          });
        } else {
          throw new ValidationError('this ZIP is too large to attach to Discord');
        }
        updateOperationStatus(operationId, 'success', { fileSize: fileData.size });
        recordRateLimit(userId);
        await notifyCommandSuccess('download', { operationId, userId });
        return;
      } else if (Array.isArray(fileData)) {
        logger.info(`Processing ${fileData.length} media files from picker`);
        const mediaResults = [];
        let totalSize = 0;

        // First pass: calculate total size
        for (let i = 0; i < fileData.length; i++) {
          const media = fileData[i];
          totalSize += media.size;
        }

        // Discord applies the limit to each attachment, not the whole request.
        const shouldUploadToDiscord = fileData.map(media =>
          fitsDiscordAttachment(media.size, discordAttachmentLimit)
        );
        const discordSize = fileData
          .filter((_, index) => shouldUploadToDiscord[index])
          .reduce((size, media) => size + media.size, 0);
        logger.info(
          `Total size: ${(totalSize / (1024 * 1024)).toFixed(2)}MB, sending ${shouldUploadToDiscord.filter(Boolean).length} file(s) to Discord (${(discordSize / (1024 * 1024)).toFixed(2)}MB) and ${fileData.length - shouldUploadToDiscord.filter(Boolean).length} file(s) to R2`
        );

        // Second pass: save all files
        for (let i = 0; i < fileData.length; i++) {
          const media = fileData[i];
          const hash = generateHash(media.buffer);
          const ext = path.extname(media.filename).toLowerCase() || '.jpg';
          const fileType = detectFileType(ext, media.contentType, media.buffer);

          let filePath;
          let fileUrl;
          let exists = false;
          let method;

          if (fileType === 'video') {
            exists = await videoExists(hash, ext, GIF_STORAGE_PATH);
            if (exists) {
              filePath = getVideoPath(hash, ext, GIF_STORAGE_PATH);
            }
          } else if (fileType === 'image') {
            exists = await imageExists(hash, ext, GIF_STORAGE_PATH);
            if (exists) {
              filePath = getImagePath(hash, ext, GIF_STORAGE_PATH);
            }
          } else if (fileType === 'gif') {
            exists = await gifExists(hash, GIF_STORAGE_PATH);
            if (exists) {
              filePath = getGifPath(hash, GIF_STORAGE_PATH);
            }
          }

          if (exists && filePath) {
            // Determine method based on whether it's a URL (R2) or local path (discord)
            method =
              filePath.startsWith('http://') || filePath.startsWith('https://') ? 'r2' : 'discord';

            if (method === 'r2') {
              fileUrl = filePath;
            } else {
              const filename = path.basename(filePath);
              const cdnPath =
                fileType === 'video' ? '/videos' : fileType === 'image' ? '/images' : '/gifs';
              fileUrl = `${CDN_BASE_URL.replace('/gifs', cdnPath)}/${filename}`;
            }
            logger.info(
              `Media ${i + 1} already exists (hash: ${hash}, type: ${fileType}, method: ${method})`
            );
          } else {
            logger.info(
              `Saving media ${i + 1} (hash: ${hash}, extension: ${ext}, type: ${fileType})`
            );
            let saveResult;

            if (fileType === 'video') {
              saveResult = await saveVideo(
                media.buffer,
                hash,
                ext,
                GIF_STORAGE_PATH,
                buildMetadata(),
                discordAttachmentLimit
              );
            } else if (fileType === 'image') {
              saveResult = await saveImage(
                media.buffer,
                hash,
                ext,
                GIF_STORAGE_PATH,
                buildMetadata(),
                discordAttachmentLimit
              );
            } else if (fileType === 'gif') {
              saveResult = await saveGif(
                media.buffer,
                hash,
                GIF_STORAGE_PATH,
                buildMetadata(),
                discordAttachmentLimit
              );
            }

            filePath = saveResult.url;
            method = saveResult.method;

            if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
              fileUrl = filePath;
            } else {
              const filename = path.basename(filePath);
              const cdnPath =
                fileType === 'video' ? '/videos' : fileType === 'image' ? '/images' : '/gifs';
              fileUrl = `${CDN_BASE_URL.replace('/gifs', cdnPath)}/${filename}`;
            }
            logger.info(
              `Successfully saved media ${i + 1} (hash: ${hash}, type: ${fileType}, method: ${method})`
            );
          }

          mediaResults.push({
            url: fileUrl,
            size: media.size,
            buffer: media.buffer,
            filename: media.filename,
            hash: hash,
            ext: ext,
            fileType: fileType,
            method: method,
          });
        }

        // Third pass: re-upload to R2 if file was saved locally but should be on R2
        for (let i = 0; i < mediaResults.length; i++) {
          if (!shouldUploadToDiscord[i] && mediaResults[i].method === 'discord') {
            const result = mediaResults[i];
            logger.info(
              `Re-uploading media ${i + 1} to R2 (hash: ${result.hash}, type: ${result.fileType})`
            );

            let r2Url;
            if (result.fileType === 'video') {
              r2Url = await uploadVideoToR2(
                result.buffer,
                result.hash,
                result.ext,
                r2Config,
                buildMetadata()
              );
            } else if (result.fileType === 'image') {
              r2Url = await uploadImageToR2(
                result.buffer,
                result.hash,
                result.ext,
                r2Config,
                buildMetadata()
              );
            } else if (result.fileType === 'gif') {
              r2Url = await uploadGifToR2(result.buffer, result.hash, r2Config, buildMetadata());
            }

            if (r2Url) {
              mediaResults[i].url = r2Url;
              mediaResults[i].method = 'r2';
              logger.info(`Successfully re-uploaded media ${i + 1} to R2: ${r2Url}`);
            }
          }
        }

        updateOperationStatus(operationId, 'success', {
          fileSize: totalSize,
          mediaCount: mediaResults.length,
        });

        recordRateLimit(userId);

        const discordFiles = mediaResults.filter((r, i) => shouldUploadToDiscord[i]);
        const r2Files = mediaResults.filter((r, i) => !shouldUploadToDiscord[i]);

        const attachments = discordFiles.map(result => {
          const safeHash = result.hash.replace(/[^a-f0-9]/gi, '');
          const filename = `${safeHash}${result.ext}`;
          return new AttachmentBuilder(result.buffer, { name: filename });
        });

        const r2Urls = r2Files.map(r => r.url);
        const content = formatMultipleR2UrlsWithDisclaimer(r2Urls, r2Config, adminUser);

        // A carousel bigger than Discord's per-message attachment cap has to go out as
        // several messages: the first edits the deferred reply, the rest follow up.
        const attachmentBatches = batchAttachmentsForDelivery(attachments);

        logger.info(
          `Sending ${attachments.length} Discord attachment(s) across ` +
            `${Math.max(1, attachmentBatches.length)} message(s) and ${r2Urls.length} R2 URL(s)`
        );

        // safeInteractionEditReply/FollowUp return false when the send failed. Treating that
        // as "no attachments to record" used to let a total delivery failure be reported as a
        // successful operation, so a failed send now fails the operation.
        const sentMessages = [];
        const firstMessage = await safeInteractionEditReply(interaction, {
          files: attachmentBatches.length > 0 ? attachmentBatches[0] : undefined,
          content: content || undefined,
        });
        if (firstMessage === false) {
          throw new AppError('could not deliver the files to discord. please try again.');
        }
        sentMessages.push(firstMessage);

        for (const batch of attachmentBatches.slice(1)) {
          const followUpMessage = await safeInteractionFollowUp(interaction, { files: batch });
          if (followUpMessage === false) {
            throw new AppError(
              'only part of this post could be delivered to discord. please try again.'
            );
          }
          sentMessages.push(followUpMessage);
        }

        // Capture Discord attachment URLs for database tracking. Batches are sent in order,
        // so flattening them preserves the discordFiles[i] correspondence.
        const attachmentArray = sentMessages.flatMap(message =>
          message && message.attachments ? Array.from(message.attachments.values()) : []
        );
        for (let i = 0; i < discordFiles.length && i < attachmentArray.length; i++) {
          const discordAttachment = attachmentArray[i];
          if (discordAttachment && discordAttachment.url) {
            await recordProcessedUrl({
              urlHash,
              contentHash: discordFiles[i].hash,
              fileType: discordFiles[i].fileType,
              fileExtension: discordFiles[i].ext,
              fileUrl: discordAttachment.url,
              userId,
              fileSize: discordFiles[i].size,
            });
          }
        }

        for (const result of r2Files) {
          await recordProcessedUrl({
            urlHash,
            contentHash: result.hash,
            fileType: result.fileType,
            fileExtension: result.ext,
            fileUrl: result.url,
            userId,
            fileSize: result.size,
          });
          await trackR2UploadIfApplicable(urlHash, result.url, adminUser);
        }

        await notifyCommandSuccess('download', { operationId, userId });
        return;
      }

      let hash = generateHash(fileData.buffer);

      const ext = path.extname(fileData.filename).toLowerCase() || '.mp4';

      const fileType = detectFileType(ext, fileData.contentType, fileData.buffer);

      let cdnPath = '/gifs';
      if (fileType === 'video') {
        cdnPath = '/videos';
      } else if (fileType === 'image') {
        cdnPath = '/images';
      }

      // note: for YouTube downloads with time parameters, yt-dlp already trimmed the video
      // using --download-sections, so we don't need to trim again with ffmpeg
      const alreadyTrimmedByYtdlp =
        downloadMethod === 'ytdlp' && (startTime !== null || duration !== null);
      const needsTrimming =
        (fileType === 'video' || fileType === 'gif') &&
        (startTime !== null || duration !== null) &&
        !alreadyTrimmedByYtdlp;

      // for yt-dlp downloads with time params, the buffer is already the trimmed segment,
      // so we should check if this trimmed version exists (based on hash of the trimmed buffer)
      // for downloads that need ffmpeg trimming, skip this check (we'll check for trimmed file later)
      let exists = false;
      let filePath = null;
      if (!needsTrimming) {
        if (fileType === 'gif') {
          exists = await gifExists(hash, GIF_STORAGE_PATH);
          if (exists) {
            filePath = getGifPath(hash, GIF_STORAGE_PATH);
          }
        } else if (fileType === 'video') {
          exists = await videoExists(hash, ext, GIF_STORAGE_PATH);
          if (exists) {
            filePath = getVideoPath(hash, ext, GIF_STORAGE_PATH);
          }
        } else if (fileType === 'image') {
          exists = await imageExists(hash, ext, GIF_STORAGE_PATH);
          if (exists) {
            filePath = getImagePath(hash, ext, GIF_STORAGE_PATH);
          }
        }
      }

      if (exists && filePath) {
        // filePath might be a local path or R2 URL
        let fileUrl;
        if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
          fileUrl = filePath;
        } else {
          const filename = path.basename(filePath);
          fileUrl = `${CDN_BASE_URL.replace('/gifs', cdnPath)}/${filename}`;
        }
        logger.info(`${fileType} already exists (hash: ${hash}) for user ${userId}`);
        let existingSize = fileData.buffer.length;
        if (!filePath.startsWith('http://') && !filePath.startsWith('https://')) {
          // Try to stat local file, but it might only exist in R2
          try {
            const stats = await fs.stat(filePath);
            existingSize = stats.size;
          } catch {
            // File only exists in R2, use buffer size as approximation
            logger.debug(`File exists in R2 but not locally, using buffer size: ${existingSize}`);
          }
        }

        // Record processed URL in database (file exists but URL might not be recorded yet)
        await recordProcessedUrl({
          urlHash,
          contentHash: hash,
          fileType,
          fileExtension: ext,
          fileUrl,
          userId,
          fileSize: existingSize,
        });

        updateOperationStatus(operationId, 'success', { fileSize: existingSize });
        recordRateLimit(userId);
        await safeInteractionEditReply(interaction, {
          content: formatR2UrlWithDisclaimer(fileUrl, r2Config, adminUser),
        });

        await notifyCommandSuccess('download', { operationId, userId });
        return;
      } else {
        let finalBuffer = fileData.buffer;
        let finalUploadMethod = 'r2';
        // If video was trimmed, use .mp4 extension (trimVideo outputs MP4 format)
        let saveExt = ext;
        // Track if we're treating a video with .gif extension as a GIF
        let treatAsGif = false;
        if (fileType === 'gif') {
          if (startTime !== null || duration !== null) {
            logger.info(
              `Trimming GIF (hash: ${hash}, extension: ${ext}, startTime: ${startTime}, duration: ${duration})`
            );
            logOperationStep(operationId, 'gif_trim', 'running', {
              message: 'Trimming GIF',
              metadata: { startTime, duration },
            });

            const tmpDir = tmp.dirSync({ unsafeCleanup: true });
            const inputGifPath = path.join(tmpDir.name, `input${ext}`);
            const outputGifPath = path.join(tmpDir.name, 'output.gif');

            try {
              await fs.writeFile(inputGifPath, fileData.buffer);

              await trimGif(inputGifPath, outputGifPath, {
                startTime,
                duration,
              });

              const trimmedBuffer = await fs.readFile(outputGifPath);

              // Generate new hash for trimmed GIF (since content changed)
              hash = generateHash(trimmedBuffer);
              // Always reflect the trimmed content, even if a file with this hash already exists
              // on disk - the early-return path below falls back to finalBuffer.length as a size
              // estimate, which must be the trimmed size, not the original untrimmed size.
              finalBuffer = trimmedBuffer;

              const trimmedExists = await gifExists(hash, GIF_STORAGE_PATH);
              if (trimmedExists) {
                filePath = getGifPath(hash, GIF_STORAGE_PATH);
                exists = true;
                logger.info(
                  `Trimmed GIF already exists (hash: ${hash}) for user ${userId} with requested parameters (startTime: ${startTime}, duration: ${duration})`
                );
              }

              logOperationStep(operationId, 'gif_trim', 'success', {
                message: 'GIF trimmed successfully',
                metadata: {
                  startTime,
                  duration,
                  originalSize: fileData.buffer.length,
                  trimmedSize: trimmedBuffer.length,
                  alreadyExists: trimmedExists,
                },
              });

              await cleanupTempFiles(tmpDir, [inputGifPath, outputGifPath]);
            } catch (trimError) {
              logOperationStep(operationId, 'gif_trim', 'error', {
                message: 'GIF trimming failed',
                metadata: { error: trimError.message },
              });
              logger.error(`GIF trimming failed: ${trimError.message}`);
              logger.info(`Falling back to saving original GIF without trimming`);
              finalBuffer = fileData.buffer;
              await cleanupTempFiles(tmpDir, [inputGifPath, outputGifPath]);
            }
          } else {
            finalBuffer = fileData.buffer;
          }

          if (exists && filePath) {
            // filePath might be a local path or R2 URL
            let fileUrl;
            if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
              fileUrl = filePath;
            } else {
              const filename = path.basename(filePath);
              fileUrl = `${CDN_BASE_URL.replace('/gifs', cdnPath)}/${filename}`;
            }
            const dbFileType = 'gif';
            logger.info(`${dbFileType} already exists (hash: ${hash}) for user ${userId}`);
            let existingSize = finalBuffer.length;
            if (!filePath.startsWith('http://') && !filePath.startsWith('https://')) {
              // Try to stat local file, but it might only exist in R2
              try {
                const stats = await fs.stat(filePath);
                existingSize = stats.size;
              } catch {
                // File only exists in R2, use buffer size as approximation
                logger.debug(
                  `File exists in R2 but not locally, using buffer size: ${existingSize}`
                );
              }
            }

            // Record processed URL in database (file exists but URL might not be recorded yet)
            const dbExt = '.gif';
            await recordProcessedUrl({
              urlHash,
              contentHash: hash,
              fileType: dbFileType,
              fileExtension: dbExt,
              fileUrl,
              userId,
              fileSize: existingSize,
            });

            updateOperationStatus(operationId, 'success', { fileSize: existingSize });
            recordRateLimit(userId);
            await safeInteractionEditReply(interaction, {
              content: formatR2UrlWithDisclaimer(fileUrl, r2Config, adminUser),
            });

            await notifyCommandSuccess('download', { operationId, userId });
            return;
          }

          logger.info(`Saving GIF (hash: ${hash})`);
          const saveResult = await saveGif(
            finalBuffer,
            hash,
            GIF_STORAGE_PATH,
            buildMetadata(),
            discordAttachmentLimit
          );
          filePath = saveResult.url;
          finalBuffer = saveResult.buffer;
          finalUploadMethod = saveResult.method;
        } else if (fileType === 'video') {
          // Check if file has .gif extension - if so, trim as GIF (not video)
          // This handles cases where files have .gif extension but video/mp4 content-type
          if (ext === '.gif' && (startTime !== null || duration !== null)) {
            logger.info(
              `Trimming GIF (detected as video but has .gif extension) (hash: ${hash}, extension: ${ext}, startTime: ${startTime}, duration: ${duration})`
            );
            logOperationStep(operationId, 'gif_trim', 'running', {
              message: 'Trimming GIF (from video source)',
              metadata: { startTime, duration },
            });

            const tmpDir = tmp.dirSync({ unsafeCleanup: true });
            const inputGifPath = path.join(tmpDir.name, `input${ext}`);
            const outputGifPath = path.join(tmpDir.name, 'output.gif');

            try {
              await fs.writeFile(inputGifPath, fileData.buffer);

              // Trim as GIF (even though content is video, output should be GIF)
              await trimGif(inputGifPath, outputGifPath, {
                startTime,
                duration,
              });

              const trimmedBuffer = await fs.readFile(outputGifPath);

              hash = generateHash(trimmedBuffer);
              // Always reflect the trimmed content, even if a file with this hash already exists
              // on disk - see the analogous fix in the GIF-trim branch above for why.
              finalBuffer = trimmedBuffer;

              // We're treating this as a GIF now (even though it was detected as video)
              cdnPath = '/gifs';
              treatAsGif = true;

              const trimmedExists = await gifExists(hash, GIF_STORAGE_PATH);
              if (trimmedExists) {
                filePath = getGifPath(hash, GIF_STORAGE_PATH);
                exists = true;
                logger.info(
                  `Trimmed GIF already exists (hash: ${hash}) for user ${userId} with requested parameters (startTime: ${startTime}, duration: ${duration})`
                );
              }

              logOperationStep(operationId, 'gif_trim', 'success', {
                message: 'GIF trimmed successfully (from video source)',
                metadata: {
                  startTime,
                  duration,
                  originalSize: fileData.buffer.length,
                  trimmedSize: trimmedBuffer.length,
                  alreadyExists: trimmedExists,
                },
              });

              await cleanupTempFiles(tmpDir, [inputGifPath, outputGifPath]);
            } catch (trimError) {
              logOperationStep(operationId, 'gif_trim', 'error', {
                message: 'GIF trimming failed',
                metadata: { error: trimError.message },
              });
              logger.error(`GIF trimming failed: ${trimError.message}`);
              logger.info(`Falling back to saving original file without trimming`);
              finalBuffer = fileData.buffer;
              await cleanupTempFiles(tmpDir, [inputGifPath, outputGifPath]);
            }

            if (treatAsGif) {
              if (exists && filePath) {
                // filePath might be a local path or R2 URL
                let fileUrl;
                if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
                  fileUrl = filePath;
                } else {
                  const filename = path.basename(filePath);
                  fileUrl = `${CDN_BASE_URL.replace('/gifs', cdnPath)}/${filename}`;
                }
                logger.info(`GIF already exists (hash: ${hash}) for user ${userId}`);
                let existingSize = finalBuffer.length;
                if (!filePath.startsWith('http://') && !filePath.startsWith('https://')) {
                  // Try to stat local file, but it might only exist in R2
                  try {
                    const stats = await fs.stat(filePath);
                    existingSize = stats.size;
                  } catch {
                    // File only exists in R2, use buffer size as approximation
                    logger.debug(
                      `File exists in R2 but not locally, using buffer size: ${existingSize}`
                    );
                  }
                }

                await recordProcessedUrl({
                  urlHash,
                  contentHash: hash,
                  fileType: 'gif',
                  fileExtension: '.gif',
                  fileUrl,
                  userId,
                  fileSize: existingSize,
                });

                updateOperationStatus(operationId, 'success', { fileSize: existingSize });
                recordRateLimit(userId);
                await safeInteractionEditReply(interaction, {
                  content: formatR2UrlWithDisclaimer(fileUrl, r2Config, adminUser),
                });

                await notifyCommandSuccess('download', { operationId, userId });
                return;
              }

              logger.info(`Saving GIF (hash: ${hash}) - trimmed from video with .gif extension`);
              const saveResult = await saveGif(
                finalBuffer,
                hash,
                GIF_STORAGE_PATH,
                buildMetadata(),
                discordAttachmentLimit
              );
              filePath = saveResult.url;
              finalBuffer = saveResult.buffer;
              finalUploadMethod = saveResult.method;
              // Note: We continue below to handle optimization and upload, but skip video-specific logic
            }
          } else if (!alreadyTrimmedByYtdlp && (startTime !== null || duration !== null)) {
            // Regular video trimming (not .gif extension)
            logger.info(
              `Trimming video (hash: ${hash}, extension: ${ext}, startTime: ${startTime}, duration: ${duration})`
            );
            logOperationStep(operationId, 'video_trim', 'running', {
              message: 'Trimming video',
              metadata: { startTime, duration },
            });

            // Always use .mp4 extension for video output (trimVideo outputs MP4 format)
            const tmpDir = tmp.dirSync({ unsafeCleanup: true });
            const inputVideoPath = path.join(tmpDir.name, `input${ext}`);
            const outputVideoPath = path.join(tmpDir.name, 'output.mp4');

            try {
              await fs.writeFile(inputVideoPath, fileData.buffer);

              await trimVideo(inputVideoPath, outputVideoPath, {
                startTime,
                duration,
              });

              const trimmedBuffer = await fs.readFile(outputVideoPath);

              // Generate new hash for trimmed video (since content changed)
              // Note: Hash is based on actual video content, not trim parameters.
              // Different trim parameters → different content → different hash.
              // Same trim parameters → same content → same hash → cache hit.
              // This ensures we always return the correct trimmed version for the requested parameters.
              hash = generateHash(trimmedBuffer);
              // Always reflect the trimmed content, even if a file with this hash already exists
              // on disk - see the analogous fix in the GIF-trim branch above for why.
              finalBuffer = trimmedBuffer;

              // This checks if we've previously created a video with this exact content (hash).
              // If the user requested different trim parameters, the hash will be different,
              // so we won't return the wrong cached version.
              // Always use .mp4 extension for trimmed videos (output format is MP4)
              const videoExt = '.mp4';
              const trimmedExists = await videoExists(hash, videoExt, GIF_STORAGE_PATH);
              if (trimmedExists) {
                filePath = getVideoPath(hash, videoExt, GIF_STORAGE_PATH);
                exists = true;
                logger.info(
                  `Trimmed video already exists (hash: ${hash}) for user ${userId} with requested parameters (startTime: ${startTime}, duration: ${duration})`
                );
              }

              logOperationStep(operationId, 'video_trim', 'success', {
                message: 'Video trimmed successfully',
                metadata: {
                  startTime,
                  duration,
                  originalSize: fileData.buffer.length,
                  trimmedSize: trimmedBuffer.length,
                  alreadyExists: trimmedExists,
                },
              });

              await cleanupTempFiles(tmpDir, [inputVideoPath, outputVideoPath]);
            } catch (trimError) {
              logOperationStep(operationId, 'video_trim', 'error', {
                message: 'Video trimming failed',
                metadata: { error: trimError.message },
              });
              logger.error(`Video trimming failed: ${trimError.message}`);
              logger.info(`Falling back to saving original video without trimming`);
              finalBuffer = fileData.buffer;
              await cleanupTempFiles(tmpDir, [inputVideoPath, outputVideoPath]);
            }
          } else {
            finalBuffer = fileData.buffer;
          }

          if (fileType === 'video' && (startTime !== null || duration !== null) && !treatAsGif) {
            saveExt = '.mp4';
          }

          if (exists && filePath) {
            // filePath might be a local path or R2 URL
            let fileUrl;
            if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
              fileUrl = filePath;
            } else {
              const filename = path.basename(filePath);
              fileUrl = `${CDN_BASE_URL.replace('/gifs', cdnPath)}/${filename}`;
            }
            logger.info(`${fileType} already exists (hash: ${hash}) for user ${userId}`);
            let existingSize = finalBuffer.length;
            if (!filePath.startsWith('http://') && !filePath.startsWith('https://')) {
              // Try to stat local file, but it might only exist in R2
              try {
                const stats = await fs.stat(filePath);
                existingSize = stats.size;
              } catch {
                // File only exists in R2, use buffer size as approximation
                logger.debug(
                  `File exists in R2 but not locally, using buffer size: ${existingSize}`
                );
              }
            }

            // Record processed URL in database (file exists but URL might not be recorded yet)
            await recordProcessedUrl({
              urlHash,
              contentHash: hash,
              fileType,
              fileExtension: saveExt,
              fileUrl,
              userId,
              fileSize: existingSize,
            });

            updateOperationStatus(operationId, 'success', { fileSize: existingSize });
            recordRateLimit(userId);
            await safeInteractionEditReply(interaction, {
              content: formatR2UrlWithDisclaimer(fileUrl, r2Config, adminUser),
            });

            await notifyCommandSuccess('download', { operationId, userId });
            return;
          }

          // Skip video saving if we already saved it as GIF (when treatAsGif is true)
          if (!treatAsGif) {
            logger.info(`Saving ${fileType} (hash: ${hash}, extension: ${saveExt})`);
            const saveResult = await saveVideo(
              finalBuffer,
              hash,
              saveExt,
              GIF_STORAGE_PATH,
              buildMetadata(),
              discordAttachmentLimit
            );
            filePath = saveResult.url;
            finalBuffer = saveResult.buffer;
            finalUploadMethod = saveResult.method;
          }
        } else if (fileType === 'image') {
          logger.info(`Saving image (hash: ${hash}, extension: ${ext})`);
          const saveResult = await saveImage(
            fileData.buffer,
            hash,
            ext,
            GIF_STORAGE_PATH,
            buildMetadata(),
            discordAttachmentLimit
          );
          filePath = saveResult.url;
          finalBuffer = saveResult.buffer;
          finalUploadMethod = saveResult.method;
        }

        // filePath might be a local path or R2 URL
        let fileUrl;
        let finalSize;
        if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
          fileUrl = filePath;
          // Get size from buffer since we can't stat R2 files
          finalSize = finalBuffer.length;
        } else {
          const filename = path.basename(filePath);
          fileUrl = `${CDN_BASE_URL.replace('/gifs', cdnPath)}/${filename}`;
          const finalStats = await fs.stat(filePath);
          finalSize = finalStats.size;
        }

        const finalSizeMB = (finalSize / (1024 * 1024)).toFixed(2);

        logger.info(
          `Successfully saved ${fileType} (hash: ${hash}, size: ${finalSizeMB}MB) for user ${userId}`
        );

        // Use saveExt for trimmed videos, ext for others
        const dbExt = fileType === 'video' ? saveExt : ext;
        await recordProcessedUrl({
          urlHash,
          contentHash: hash,
          fileType,
          fileExtension: dbExt,
          fileUrl,
          userId,
          fileSize: finalSize,
        });

        if (finalUploadMethod === 'r2') {
          await trackR2UploadIfApplicable(urlHash, fileUrl, adminUser);
        }

        updateOperationStatus(operationId, 'success', { fileSize: finalSize });

        // Retention shown to the user must match what trackTemporaryUpload actually stored,
        // which is tiered by size - so compute it from the same size here for the R2 replies.
        const deliveredTtlHours = await resolveTtlHoursForSize(finalSize);

        // Send as a Discord attachment when it fits the current interaction limit.
        if (fitsDiscordAttachment(finalSize, discordAttachmentLimit)) {
          const safeHash = hash.replace(/[^a-f0-9]/gi, '');
          const filename = `${safeHash}${dbExt}`;
          try {
            const message = await safeInteractionEditReply(interaction, {
              files: [new AttachmentBuilder(finalBuffer, { name: filename })],
            });

            let discordUrl = null;
            if (message && message.attachments && message.attachments.size > 0) {
              const discordAttachment = message.attachments.first();
              if (discordAttachment && discordAttachment.url) {
                discordUrl = discordAttachment.url;
              }
            }

            // If attachments weren't in the response, try fetching the message
            if (!discordUrl && message && message.id && interaction.channel) {
              try {
                const fetchedMessage = await interaction.channel.messages.fetch(message.id);
                if (
                  fetchedMessage &&
                  fetchedMessage.attachments &&
                  fetchedMessage.attachments.size > 0
                ) {
                  const discordAttachment = fetchedMessage.attachments.first();
                  if (discordAttachment && discordAttachment.url) {
                    discordUrl = discordAttachment.url;
                  }
                }
              } catch (fetchError) {
                logger.warn(`Failed to fetch message to get attachment URL: ${fetchError.message}`);
              }
            }

            if (discordUrl) {
              logger.info(`Uploaded to Discord: ${discordUrl}`);
              // Update database with Discord URL since file was uploaded to Discord, not saved to R2/CDN
              await recordProcessedUrl({
                urlHash,
                contentHash: hash,
                fileType,
                fileExtension: dbExt,
                fileUrl: discordUrl,
                userId,
                fileSize: finalSize,
              });
            }
          } catch (discordError) {
            logger.warn(
              `Discord attachment upload failed, falling back to R2: ${discordError.message}`
            );
            try {
              let r2Url;
              if (fileType === 'gif') {
                r2Url = await uploadGifToR2(finalBuffer, hash, r2Config, buildMetadata());
              } else if (fileType === 'video') {
                r2Url = await uploadVideoToR2(
                  finalBuffer,
                  hash,
                  saveExt,
                  r2Config,
                  buildMetadata()
                );
              } else if (fileType === 'image') {
                r2Url = await uploadImageToR2(finalBuffer, hash, ext, r2Config, buildMetadata());
              }

              if (r2Url) {
                await recordProcessedUrl({
                  urlHash,
                  contentHash: hash,
                  fileType,
                  fileExtension: dbExt,
                  fileUrl: r2Url,
                  userId,
                  fileSize: finalSize,
                });
                await trackR2UploadIfApplicable(urlHash, r2Url, adminUser);
                await safeInteractionEditReply(interaction, {
                  content: formatR2UrlWithDisclaimer(r2Url, r2Config, adminUser, deliveredTtlHours),
                });
              } else {
                // If R2 upload also fails, use the original fileUrl
                await safeInteractionEditReply(interaction, {
                  content: formatR2UrlWithDisclaimer(fileUrl, r2Config, adminUser),
                });
              }
            } catch (r2Error) {
              logger.error(`R2 fallback upload also failed: ${r2Error.message}`);
              // Last resort: use the original fileUrl
              await safeInteractionEditReply(interaction, {
                content: formatR2UrlWithDisclaimer(fileUrl, r2Config, adminUser),
              });
            }
          }
        } else {
          await safeInteractionEditReply(interaction, {
            content: formatR2UrlWithDisclaimer(fileUrl, r2Config, adminUser, deliveredTtlHours),
          });
        }

        await notifyCommandSuccess('download', { operationId, userId });

        recordRateLimit(userId);
      }
    },
    {
      commandSource,
      errorFallback:
        'could not download this content. it may be deleted, private, age-restricted, or unsupported.',
      context: { originalUrl: url },
    }
  );
}

export async function handleDownloadContextMenuCommand(interaction) {
  if (!interaction.isMessageContextMenuCommand()) {
    return;
  }

  if (interaction.commandName !== 'download') {
    return;
  }

  const userId = interaction.user.id;
  const adminUser = isAdmin(userId);

  logger.info(`User ${userId} initiated download via context menu${adminUser ? ' [ADMIN]' : ''}`);

  if (
    await replyIfRateLimited(interaction, {
      type: 'download',
      action: 'downloading another video',
      commandSource: 'context-menu',
    })
  ) {
    return;
  }

  const targetMessage = interaction.targetMessage;

  let url = firstUrlIn(targetMessage.content);
  if (url) {
    logger.info(`Found URL in message content: ${url}`);
  }

  if (!url) {
    logger.warn(`No URL found in message for user ${userId}`);
    const errorMessage = 'no URL found in this message.';
    createFailedOperation('download', userId, errorMessage, 'missing_url', {
      commandSource: 'context-menu',
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    await notifyCommandFailure('download', {
      userId,
      error: errorMessage,
    });
    return;
  }

  const urlValidation = validateUrl(url);
  if (!urlValidation.valid) {
    logger.warn(`Invalid URL for user ${userId}: ${urlValidation.error}`);
    await safeInteractionReply(interaction, {
      content: `invalid URL: ${urlValidation.error}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  url = canonicalizeMirrorUrl(url);

  const megaFileId = keylessMegaFileId(url);
  if (megaFileId) {
    await promptForMegaKey(interaction, megaFileId, 'context-menu', null, null);
    return;
  }

  // Classify the URL: yt-dlp site (youtube/redgifs/imgur/...) or not
  const ytdlpSite = getYtdlpSite(url);
  const galleryDlSite = getGalleryDlSite(url);

  if (ytdlpSite && !YTDLP_ENABLED) {
    logger.warn(`User ${userId} attempted to download from ${ytdlpSite} (yt-dlp disabled)`);
    const errorMessage = `${ytdlpSite.toLowerCase()} downloads are disabled.`;
    createFailedOperation('download', userId, errorMessage, 'ytdlp_disabled', {
      originalUrl: url,
      commandSource: 'context-menu',
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (galleryDlSite && !GALLERY_DL_ENABLED) {
    const errorMessage = `${galleryDlSite.toLowerCase()} downloads are disabled.`;
    createFailedOperation('download', userId, errorMessage, 'gallery_dl_disabled', {
      originalUrl: url,
      commandSource: 'context-menu',
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (ytdlpSite) {
    // yt-dlp sites require yt-dlp (already checked above that it's enabled)
    logger.info(`${ytdlpSite} URL detected, will use yt-dlp for download`);
  } else if (galleryDlSite) {
    logger.info(`${galleryDlSite} URL detected, will use gallery-dl for download`);
  } else if (isHentaiGifzUrl(url)) {
    // hentaigifz has its own page-scrape extractor, no Cobalt/social-media check needed
    logger.info(`hentaigifz URL detected, will use page-scrape extractor for download`);
  } else if (isBooruUrl(url)) {
    // booru sites have their own JSON-API extractor, no Cobalt/social-media check needed
    logger.info(`booru URL detected, will use booru API extractor for download`);
  } else if (isPinterestUrl(url)) {
    // Pinterest has its own JSON-LD extractor, no Cobalt/social-media check needed
    logger.info(`Pinterest URL detected, will use JSON-LD extractor for download`);
  } else if (isKlipyUrl(url)) {
    logger.info(`Klipy URL detected, will use page metadata extractor for download`);
  } else if (isDirectMediaUrl(url)) {
    // Above the cobalt gate: a direct link needs no cobalt.
    logger.info(`Direct media URL detected, will fetch the file directly`);
  } else if (!COBALT_ENABLED) {
    const errorMessage = 'cobalt is not enabled.';
    createFailedOperation('download', userId, errorMessage, 'cobalt_disabled', {
      originalUrl: url,
      commandSource: 'context-menu',
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    await notifyCommandFailure('download', { userId, error: errorMessage });
    return;
  } else if (!isSocialMediaUrl(url)) {
    const errorMessage = 'url is not from a supported social media platform.';
    createFailedOperation('download', userId, errorMessage, 'invalid_social_media_url', {
      originalUrl: url,
      commandSource: 'context-menu',
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    await notifyCommandFailure('download', {
      userId,
      error: errorMessage,
    });
    return;
  }

  // Defer reply since downloading may take time
  await safeInteractionDeferReply(interaction);

  await processDownload(interaction, url, 'context-menu');
}

export async function handleDownloadCommand(interaction) {
  const userId = interaction.user.id;
  const adminUser = isAdmin(userId);

  logger.info(`User ${userId} initiated download${adminUser ? ' [ADMIN]' : ''}`);

  if (
    await replyIfRateLimited(interaction, {
      type: 'download',
      action: 'downloading another video',
      commandSource: 'slash',
    })
  ) {
    return;
  }

  const rawUrl = interaction.options.getString('url');
  const url = canonicalizeMirrorUrl(firstUrlIn(rawUrl) ?? rawUrl);
  const audioOnly = interaction.options.getBoolean('mp3') === true;

  // Parse and validate start/end (accepts seconds or MM:SS / HH:MM:SS timestamps)
  const times = await resolveTimeOptions(interaction, { type: 'download' });
  if (times === null) {
    return;
  }
  const { startTime, endTime } = times;

  // Convert start/end to startTime/duration format for video trimming
  // Only apply time parameters for videos (they will be ignored for images/gifs)
  let trimStartTime = null;
  let trimDuration = null;

  if (startTime !== null && endTime !== null) {
    trimStartTime = startTime;
    trimDuration = endTime - startTime;
  } else if (startTime !== null) {
    // Only start_time: start at that time, continue to end
    trimStartTime = startTime;
    trimDuration = null;
  } else if (endTime !== null) {
    // Only end_time: start at beginning, end at that time
    trimStartTime = null;
    trimDuration = endTime;
  }

  if (trimStartTime !== null || trimDuration !== null) {
    logger.info(
      `Time parameters provided for download command: startTime=${trimStartTime}, duration=${trimDuration}`
    );
  }

  if (!url) {
    logger.warn(`No URL provided for user ${userId}`);
    const errorMessage = 'please provide a URL to download from.';
    createFailedOperation('download', userId, errorMessage, 'missing_url', {
      commandSource: 'slash',
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    await notifyCommandFailure('download', { userId, error: errorMessage });
    return;
  }

  if (
    (isMangaDexTitleUrl(url) || isMangaDexChapterUrl(url) || isNhentaiGalleryUrl(url)) &&
    GALLERY_DL_ENABLED
  ) {
    try {
      await beginMangaSelection(interaction, url);
    } catch (error) {
      logger.warn(`Manga selection failed: ${error.message}`);
      const reply = interaction.deferred
        ? safeInteractionEditReply(interaction, {
            content: 'could not inspect that manga. please try again later.',
          })
        : safeInteractionReply(interaction, {
            content: 'could not inspect that manga. please try again later.',
            flags: MessageFlags.Ephemeral,
          });
      await reply;
    }
    return;
  }

  const megaFileId = keylessMegaFileId(url);
  if (megaFileId) {
    await promptForMegaKey(
      interaction,
      megaFileId,
      'slash',
      trimStartTime,
      trimDuration,
      audioOnly
    );
    return;
  }

  const urlValidation = validateUrl(url);
  if (!urlValidation.valid) {
    logger.warn(`Invalid URL for user ${userId}: ${urlValidation.error}`);
    const errorMessage = `invalid URL: ${urlValidation.error}`;
    createFailedOperation('download', userId, errorMessage, 'invalid_url', {
      originalUrl: url,
      commandSource: 'slash',
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Classify the URL: yt-dlp site (youtube/redgifs/imgur/...) or not
  const ytdlpSite = getYtdlpSite(url);
  const galleryDlSite = getGalleryDlSite(url);

  if (ytdlpSite && !YTDLP_ENABLED) {
    logger.warn(`User ${userId} attempted to download from ${ytdlpSite} (yt-dlp disabled)`);
    const errorMessage = `${ytdlpSite.toLowerCase()} downloads are disabled.`;
    createFailedOperation('download', userId, errorMessage, 'ytdlp_disabled', {
      originalUrl: url,
      commandSource: 'slash',
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (galleryDlSite && !GALLERY_DL_ENABLED) {
    logger.warn(`User ${userId} attempted to download from ${galleryDlSite} (gallery-dl disabled)`);
    const errorMessage = `${galleryDlSite.toLowerCase()} downloads are disabled.`;
    createFailedOperation('download', userId, errorMessage, 'gallery_dl_disabled', {
      originalUrl: url,
      commandSource: 'slash',
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (ytdlpSite) {
    // yt-dlp sites require yt-dlp (already checked above that it's enabled)
    logger.info(`${ytdlpSite} URL detected, will use yt-dlp for download`);
  } else if (galleryDlSite) {
    logger.info(`${galleryDlSite} URL detected, will use gallery-dl for download`);
  } else if (isHentaiGifzUrl(url)) {
    // hentaigifz has its own page-scrape extractor, no Cobalt/social-media check needed
    logger.info(`hentaigifz URL detected, will use page-scrape extractor for download`);
  } else if (isBooruUrl(url)) {
    // booru sites have their own JSON-API extractor, no Cobalt/social-media check needed
    logger.info(`booru URL detected, will use booru API extractor for download`);
  } else if (isPinterestUrl(url)) {
    // Pinterest has its own JSON-LD extractor, no Cobalt/social-media check needed
    logger.info(`Pinterest URL detected, will use JSON-LD extractor for download`);
  } else if (isKlipyUrl(url)) {
    logger.info(`Klipy URL detected, will use page metadata extractor for download`);
  } else if (isDirectMediaUrl(url)) {
    // Above the cobalt gate: a direct link needs no cobalt.
    logger.info(`Direct media URL detected, will fetch the file directly`);
  } else if (!COBALT_ENABLED) {
    const errorMessage = 'cobalt is not enabled. please enable it to use the download command.';
    createFailedOperation('download', userId, errorMessage, 'cobalt_disabled', {
      originalUrl: url,
      commandSource: 'slash',
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    await notifyCommandFailure('download', { userId, error: errorMessage });
    return;
  } else if (!isSocialMediaUrl(url)) {
    const errorMessage = 'url is not from a supported social media platform.';
    createFailedOperation('download', userId, errorMessage, 'invalid_social_media_url', {
      originalUrl: url,
      commandSource: 'slash',
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    await notifyCommandFailure('download', {
      userId,
      error: errorMessage,
    });
    return;
  }

  // Defer reply since downloading may take time
  await safeInteractionDeferReply(interaction);

  await processDownload(interaction, url, 'slash', trimStartTime, trimDuration, { audioOnly });
}
