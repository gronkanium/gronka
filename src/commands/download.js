import { MessageFlags, AttachmentBuilder } from 'discord.js';
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../utils/logger.js';
import { botConfig } from '../utils/config.js';
import { validateUrl } from '../utils/validation.js';
import { isSocialMediaUrl, downloadFromSocialMedia, getCobaltMediaUrls } from '../utils/cobalt.js';
import {
  isYouTubeUrl,
  downloadFromYouTube,
  downloadWithYtdlp,
  YtdlpRateLimitError,
} from '../utils/ytdlp.js';
import { isAdmin, recordRateLimit } from '../utils/rate-limit.js';
import { generateHash } from '../utils/file-downloader.js';
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
} from '../utils/storage.js';
import { cleanupTempFiles as storageCleanupTempFiles } from '../utils/storage.js';
import {
  uploadGifToR2,
  uploadVideoToR2,
  uploadImageToR2,
  formatR2UrlWithDisclaimer,
  formatMultipleR2UrlsWithDisclaimer,
} from '../utils/r2-storage.js';
import { queueCobaltRequest, hashUrl } from '../utils/cobalt-queue.js';
import { notifyCommandSuccess, notifyCommandFailure } from '../utils/ntfy-notifier.js';
import { getProcessedUrl, getBooleanSetting } from '../utils/database.js';
import { recordProcessedUrl, trackR2UploadIfApplicable } from './shared/url-cache.js';
import { runMediaCommand } from './shared/run-media-command.js';
import { replyIfRateLimited } from './shared/command-guards.js';
import { r2Config } from '../utils/config.js';
import { trimVideo, trimGif } from '../utils/video-processor.js';
import {
  safeInteractionReply,
  safeInteractionEditReply,
  safeInteractionDeferReply,
} from '../utils/interaction-helpers.js';
import tmp from 'tmp';

const logger = createLogger('download');

function isTwitterXUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return (
      hostname === 'x.com' ||
      hostname === 'twitter.com' ||
      hostname === 'mobile.twitter.com' ||
      hostname.endsWith('.x.com') ||
      hostname.endsWith('.twitter.com')
    );
  } catch {
    return false;
  }
}

// TikTok URLs get the same Cobalt→yt-dlp fallback as X/Twitter: Cobalt has no TikTok cookie
// support, so age-restricted posts only work via yt-dlp with a cookies file (YTDLP_COOKIES_PATH).
function isTikTokUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return hostname === 'tiktok.com' || hostname.endsWith('.tiktok.com');
  } catch {
    return false;
  }
}

const {
  gifStoragePath: GIF_STORAGE_PATH,
  cdnBaseUrl: CDN_BASE_URL,
  maxVideoSize: MAX_VIDEO_SIZE,
  cobaltApiUrl: COBALT_API_URL,
  cobaltEnabled: COBALT_ENABLED,
  ytdlpEnabled: YTDLP_ENABLED,
  ytdlpQuality: YTDLP_QUALITY,
  discordSizeLimit: DISCORD_SIZE_LIMIT,
} = botConfig;

/**
 * Reply with direct media URL(s) from cobalt instead of downloading/uploading.
 * Used by url-only mode and as a last-resort fallback for X/Twitter videos that
 * exceed the download limits (Discord embeds direct video.twimg.com URLs and
 * plays the full video, so length/size caps don't apply).
 * Routes through the cobalt queue so lookups respect the same concurrency limit
 * and dedupe as regular downloads. The dedupeKey keeps them separate from
 * download requests, whose promises resolve to buffers rather than URL lists.
 * Throws when the cobalt API call fails; callers decide whether to fall back.
 * @param {Object} params
 * @param {Interaction} params.interaction - Discord interaction
 * @param {string} params.operationId - Operation tracker id
 * @param {string} params.userId - Discord user id
 * @param {string} params.username - Discord username
 * @param {string} params.url - Original social media URL
 * @param {string} params.stepName - Operation step name to log under
 * @returns {Promise<boolean>} true when a reply with URLs was sent
 */
async function replyWithDirectMediaUrls({
  interaction,
  operationId,
  userId,
  username,
  url,
  stepName,
}) {
  const { urls, direct } = await queueCobaltRequest(
    url,
    () => getCobaltMediaUrls(COBALT_API_URL, url),
    { skipCache: true, dedupeKey: `urlonly:${hashUrl(url)}` }
  );
  if (!direct || urls.length === 0) {
    return false;
  }
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
  await notifyCommandSuccess(username, 'download', { operationId, userId });
  return true;
}

/**
 * Clean up temporary files and directory
 * @param {Object} tmpDir - tmp directory object with removeCallback
 * @param {string[]} files - Array of file paths to delete
 */
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
async function processDownload(
  interaction,
  url,
  commandSource = null,
  startTime = null,
  duration = null
) {
  await runMediaCommand(
    'download',
    interaction,
    async ctx => {
      const { operationId, userId, username, adminUser, buildMetadata } = ctx;

      logOperationStep(operationId, 'url_validation', 'running', {
        message: 'Validating URL',
        metadata: { url },
      });

      // Check if URL has already been processed
      // Skip URL cache if time parameters are provided (trimmed videos are different from untrimmed)
      // Also skip cache if cached result is not a video (e.g., if it was converted to GIF)
      const urlHash = hashUrl(url);
      if (startTime === null && duration === null) {
        const processedUrl = await getProcessedUrl(urlHash);
        if (processedUrl) {
          // Only use cached URL if it's a video (download command expects video, not GIF/image)
          if (processedUrl.file_type === 'video') {
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
            await notifyCommandSuccess(username, 'download', { operationId, userId });
            return;
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

      const maxSize = adminUser ? Infinity : MAX_VIDEO_SIZE;
      const isYouTube = isYouTubeUrl(url);

      // URL-only mode (toggleable from the webui): reply with the direct media URL
      // from cobalt instead of downloading/uploading. Trim requests still need a real
      // download, and the yt-dlp (YouTube) path has no direct URL to hand out.
      if (
        COBALT_ENABLED &&
        !(isYouTube && YTDLP_ENABLED) &&
        startTime === null &&
        duration === null &&
        (await getBooleanSetting('url_only_mode', false))
      ) {
        logOperationStep(operationId, 'url_only_mode', 'running', {
          message: 'URL-only mode enabled, fetching direct media URL from cobalt',
          metadata: { url },
        });
        try {
          const replied = await replyWithDirectMediaUrls({
            interaction,
            operationId,
            userId,
            username,
            url,
            stepName: 'url_only_mode',
          });
          if (replied) {
            return;
          }
          logOperationStep(operationId, 'url_only_mode', 'success', {
            message: 'No direct URL available (tunnel response), falling back to normal download',
            metadata: { url },
          });
        } catch (urlModeError) {
          logger.warn(`URL-only mode failed, falling back to download: ${urlModeError.message}`);
          logOperationStep(operationId, 'url_only_mode', 'success', {
            message: 'URL-only mode failed, falling back to normal download',
            metadata: { url, reason: urlModeError.message },
          });
        }
      }

      // Determine download method based on URL type
      let downloadMethod;
      if (isYouTube && YTDLP_ENABLED) {
        downloadMethod = 'ytdlp';
        logger.info(`Downloading from YouTube via yt-dlp: ${url}`);
        logOperationStep(operationId, 'download_start', 'running', {
          message: 'Starting download from YouTube via yt-dlp',
          metadata: { url, maxSize: adminUser ? 'unlimited' : MAX_VIDEO_SIZE },
        });
      } else {
        downloadMethod = 'cobalt';
        logger.info(`Downloading file from Cobalt: ${url}`);
        logOperationStep(operationId, 'download_start', 'running', {
          message: 'Starting download from Cobalt',
          metadata: { url, maxSize: adminUser ? 'unlimited' : MAX_VIDEO_SIZE },
        });
      }

      // Download based on method
      let fileData;
      try {
        if (downloadMethod === 'ytdlp') {
          // if trimming is requested, yt-dlp will download ONLY the requested segment using --download-sections
          // this avoids downloading huge files and then trimming them
          // otherwise, enforce 5-minute limit to prevent large downloads
          const skipDurationLimit = startTime !== null || duration !== null;
          const maxDuration = skipDurationLimit || adminUser ? Infinity : 300;

          fileData = await downloadFromYouTube(
            url,
            adminUser,
            maxSize,
            adminUser ? null : YTDLP_QUALITY,
            maxDuration,
            startTime,
            duration
          );

          const trimmedByYtdlp = startTime !== null || duration !== null;
          logOperationStep(operationId, 'download_complete', 'success', {
            message: trimmedByYtdlp
              ? 'file segment downloaded successfully via yt-dlp (already trimmed)'
              : 'file downloaded successfully via yt-dlp',
            metadata: {
              url,
              fileCount: 1,
              trimmedByYtdlp,
              startTime,
              duration,
            },
          });
        } else {
          try {
            // Wrap Cobalt download in queue to handle concurrency and deduplication
            // If time parameters are provided, skip URL cache check (we need to download to trim)
            fileData = await queueCobaltRequest(
              url,
              async () => {
                return await downloadFromSocialMedia(COBALT_API_URL, url, adminUser, maxSize);
              },
              {
                skipCache: startTime !== null || duration !== null,
                expectedFileType: 'video',
              }
            );
            logOperationStep(operationId, 'download_complete', 'success', {
              message: 'File downloaded successfully',
              metadata: {
                url,
                fileCount: Array.isArray(fileData) ? fileData.length : 1,
              },
            });
          } catch (cobaltError) {
            const fallbackSite = isTwitterXUrl(url)
              ? 'X/Twitter'
              : isTikTokUrl(url)
                ? 'TikTok'
                : null;

            // Last resort for X/Twitter when downloading isn't possible (e.g. the
            // video is over the size cap and yt-dlp rejects it on the 5-minute
            // duration cap): hand out the direct video.twimg.com URL from cobalt.
            // Discord embeds it and plays the full video, so the caps don't apply.
            // Trim requests still need a real download. Twitter-only: other sites'
            // direct URLs (e.g. YouTube) don't reliably embed or exist at all.
            const tryTwitterDirectUrl = async () => {
              if (!isTwitterXUrl(url) || startTime !== null || duration !== null) {
                return false;
              }
              logOperationStep(operationId, 'direct_url_fallback', 'running', {
                message: 'Download failed for X/Twitter URL, trying direct media URL',
                metadata: { url },
              });
              try {
                const replied = await replyWithDirectMediaUrls({
                  interaction,
                  operationId,
                  userId,
                  username,
                  url,
                  stepName: 'direct_url_fallback',
                });
                if (replied) {
                  return true;
                }
                logOperationStep(operationId, 'direct_url_fallback', 'success', {
                  message: 'No direct URL available (tunnel response), surfacing download error',
                  metadata: { url },
                });
              } catch (directUrlError) {
                logger.warn(`Direct URL fallback failed: ${directUrlError.message}`);
                logOperationStep(operationId, 'direct_url_fallback', 'success', {
                  message: 'Direct URL fallback failed, surfacing download error',
                  metadata: { url, reason: directUrlError.message },
                });
              }
              return false;
            };

            if (!fallbackSite || !YTDLP_ENABLED) {
              if (await tryTwitterDirectUrl()) {
                return;
              }
              throw cobaltError;
            }

            logger.warn(
              `Cobalt failed for ${fallbackSite} URL, falling back to yt-dlp: ` +
                cobaltError.message
            );

            logOperationStep(operationId, 'download_fallback', 'running', {
              message: `Cobalt failed for ${fallbackSite} URL, retrying with yt-dlp`,
              metadata: { url, reason: cobaltError.message },
            });

            const skipDurationLimit = startTime !== null || duration !== null;
            const maxDuration = skipDurationLimit || adminUser ? Infinity : 300;

            try {
              fileData = await downloadWithYtdlp(
                url,
                adminUser,
                maxSize,
                adminUser ? null : YTDLP_QUALITY,
                maxDuration,
                startTime,
                duration
              );
            } catch (ytdlpFallbackError) {
              if (await tryTwitterDirectUrl()) {
                return;
              }
              throw ytdlpFallbackError;
            }

            // yt-dlp already trimmed via --download-sections; mark the method so the
            // ffmpeg trim step below is skipped (otherwise it re-trims the segment).
            downloadMethod = 'ytdlp';

            logOperationStep(operationId, 'download_fallback', 'success', {
              message: `yt-dlp fallback succeeded for ${fallbackSite} URL`,
              metadata: { url },
            });
            logOperationStep(operationId, 'download_complete', 'success', {
              message: 'file downloaded successfully via yt-dlp fallback',
              metadata: {
                url,
                fileCount: 1,
                fallbackFrom: 'cobalt',
              },
            });
          }
        }
      } catch (error) {
        // Handle yt-dlp rate limit error
        if (error instanceof YtdlpRateLimitError) {
          throw error;
        }
        // Handle cached URL error (only when no time parameters - should not happen if skipCache is true)
        if (error.message && error.message.startsWith('URL_ALREADY_PROCESSED:')) {
          // Extract URL properly (URL may contain colons, so use regex to extract everything after the prefix)
          const urlMatch = error.message.match(/^URL_ALREADY_PROCESSED:(.+)$/);
          if (urlMatch && urlMatch[1]) {
            const fileUrl = urlMatch[1];

            // Safety check: verify the cached entry is actually a video (defense in depth)
            // This should not happen with expectedFileType filtering, but check anyway
            const processedUrl = await getProcessedUrl(urlHash);
            if (processedUrl && processedUrl.file_type !== 'video') {
              logger.warn(
                `Cached entry file type mismatch (expected: video, got: ${processedUrl.file_type}), proceeding with download`
              );
              logOperationStep(operationId, 'url_cache_mismatch', 'running', {
                message: 'Cached entry file type mismatch, downloading video instead',
                metadata: { url, cachedType: processedUrl.file_type },
              });
              // Re-throw to proceed with download
              throw new Error('Cached entry file type mismatch, proceeding with download', {
                cause: error,
              });
            }

            updateOperationStatus(operationId, 'success', { fileSize: 0 });
            recordRateLimit(userId);
            await safeInteractionEditReply(interaction, {
              content: formatR2UrlWithDisclaimer(fileUrl, r2Config, adminUser),
            });
            await notifyCommandSuccess(username, 'download', { operationId, userId });
            return;
          }
        }
        throw error;
      }

      // Check if we got multiple media files (array) or single file
      if (Array.isArray(fileData)) {
        // Handle multiple media files from picker (photos and videos)
        logger.info(`Processing ${fileData.length} media files from picker`);
        const mediaResults = [];
        let totalSize = 0;

        // First pass: calculate total size
        for (let i = 0; i < fileData.length; i++) {
          const media = fileData[i];
          totalSize += media.size;
        }

        // Determine which files should go to Discord vs R2 (greedy packing)
        const shouldUploadToDiscord = [];
        if (totalSize < DISCORD_SIZE_LIMIT) {
          // All files fit in Discord
          logger.info(
            `Total size: ${(totalSize / (1024 * 1024)).toFixed(2)}MB, sending all files as Discord attachments`
          );
          for (let i = 0; i < fileData.length; i++) {
            shouldUploadToDiscord[i] = true;
          }
        } else {
          // Greedily pack files up to 8MB for Discord, rest go to R2
          let accumulatedSize = 0;
          let discordCount = 0;
          for (let i = 0; i < fileData.length; i++) {
            if (accumulatedSize + fileData[i].size < DISCORD_SIZE_LIMIT) {
              shouldUploadToDiscord[i] = true;
              accumulatedSize += fileData[i].size;
              discordCount++;
            } else {
              shouldUploadToDiscord[i] = false;
            }
          }
          logger.info(
            `Total size: ${(totalSize / (1024 * 1024)).toFixed(2)}MB, packing ${discordCount} file(s) for Discord (${(accumulatedSize / (1024 * 1024)).toFixed(2)}MB), ${fileData.length - discordCount} file(s) for R2`
          );
        }

        // Second pass: save all files
        for (let i = 0; i < fileData.length; i++) {
          const media = fileData[i];
          const hash = generateHash(media.buffer);
          const ext = path.extname(media.filename).toLowerCase() || '.jpg';
          const fileType = detectFileType(ext, media.contentType);

          let filePath;
          let fileUrl;
          let exists = false;
          let method;

          // Check if file already exists based on type
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
            // Save the file based on type
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
                buildMetadata()
              );
            } else if (fileType === 'image') {
              saveResult = await saveImage(
                media.buffer,
                hash,
                ext,
                GIF_STORAGE_PATH,
                buildMetadata()
              );
            } else if (fileType === 'gif') {
              saveResult = await saveGif(media.buffer, hash, GIF_STORAGE_PATH, buildMetadata());
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
            // File was saved locally but should be on R2, re-upload
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

        // Update operation to success
        updateOperationStatus(operationId, 'success', {
          fileSize: totalSize,
          mediaCount: mediaResults.length,
        });

        recordRateLimit(userId);

        // Separate files by intended upload method
        const discordFiles = mediaResults.filter((r, i) => shouldUploadToDiscord[i]);
        const r2Files = mediaResults.filter((r, i) => !shouldUploadToDiscord[i]);

        // Prepare Discord attachments
        const attachments = discordFiles.map(result => {
          const safeHash = result.hash.replace(/[^a-f0-9]/gi, '');
          const filename = `${safeHash}${result.ext}`;
          return new AttachmentBuilder(result.buffer, { name: filename });
        });

        // Prepare R2 URLs with single disclaimer
        const r2Urls = r2Files.map(r => r.url);
        const content = formatMultipleR2UrlsWithDisclaimer(r2Urls, r2Config, adminUser);

        // Send single message with both attachments and URLs
        logger.info(
          `Sending message with ${attachments.length} Discord attachment(s) and ${r2Urls.length} R2 URL(s)`
        );
        const message = await safeInteractionEditReply(interaction, {
          files: attachments.length > 0 ? attachments : undefined,
          content: content || undefined,
        });

        // Capture Discord attachment URLs for database tracking
        if (message && message.attachments && message.attachments.size > 0) {
          const attachmentArray = Array.from(message.attachments.values());
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
        }

        // Record R2 uploads in database
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

        // Send success notification
        await notifyCommandSuccess(username, 'download', { operationId, userId });
        return;
      }

      // Single file handling (existing code)
      // Generate hash
      let hash = generateHash(fileData.buffer);

      // Extract extension from filename
      const ext = path.extname(fileData.filename).toLowerCase() || '.mp4';

      // Detect file type
      const fileType = detectFileType(ext, fileData.contentType);

      // Determine CDN path prefix based on file type
      let cdnPath = '/gifs';
      if (fileType === 'video') {
        cdnPath = '/videos';
      } else if (fileType === 'image') {
        cdnPath = '/images';
      }

      // Check if video or GIF trimming is requested
      // note: for YouTube downloads with time parameters, yt-dlp already trimmed the video
      // using --download-sections, so we don't need to trim again with ffmpeg
      const alreadyTrimmedByYtdlp =
        downloadMethod === 'ytdlp' && (startTime !== null || duration !== null);
      const needsTrimming =
        (fileType === 'video' || fileType === 'gif') &&
        (startTime !== null || duration !== null) &&
        !alreadyTrimmedByYtdlp;

      // Check if file already exists and get appropriate path
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
          // Already an R2 URL
          fileUrl = filePath;
        } else {
          // Local path, construct URL
          const filename = path.basename(filePath);
          fileUrl = `${CDN_BASE_URL.replace('/gifs', cdnPath)}/${filename}`;
        }
        logger.info(`${fileType} already exists (hash: ${hash}) for user ${userId}`);
        // Get file size for existing file
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

        // Send success notification
        await notifyCommandSuccess(username, 'download', { operationId, userId });
        return;
      } else {
        // Save file based on type
        let finalBuffer = fileData.buffer;
        let finalUploadMethod = 'r2';
        // Determine the extension to use for saving
        // If video was trimmed, use .mp4 extension (trimVideo outputs MP4 format)
        let saveExt = ext;
        // Track if we're treating a video with .gif extension as a GIF
        let treatAsGif = false;
        if (fileType === 'gif') {
          // Check if GIF trimming is requested
          if (startTime !== null || duration !== null) {
            logger.info(
              `Trimming GIF (hash: ${hash}, extension: ${ext}, startTime: ${startTime}, duration: ${duration})`
            );
            logOperationStep(operationId, 'gif_trim', 'running', {
              message: 'Trimming GIF',
              metadata: { startTime, duration },
            });

            // Create temporary files for input and output
            const tmpDir = tmp.dirSync({ unsafeCleanup: true });
            const inputGifPath = path.join(tmpDir.name, `input${ext}`);
            const outputGifPath = path.join(tmpDir.name, 'output.gif');

            try {
              // Write original GIF to temp file
              await fs.writeFile(inputGifPath, fileData.buffer);

              // Trim the GIF
              await trimGif(inputGifPath, outputGifPath, {
                startTime,
                duration,
              });

              // Read trimmed GIF
              const trimmedBuffer = await fs.readFile(outputGifPath);

              // Generate new hash for trimmed GIF (since content changed)
              hash = generateHash(trimmedBuffer);
              // Always reflect the trimmed content, even if a file with this hash already exists
              // on disk - the early-return path below falls back to finalBuffer.length as a size
              // estimate, which must be the trimmed size, not the original untrimmed size.
              finalBuffer = trimmedBuffer;

              // Check if trimmed GIF already exists
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

              // Clean up temp files
              await cleanupTempFiles(tmpDir, [inputGifPath, outputGifPath]);
            } catch (trimError) {
              logOperationStep(operationId, 'gif_trim', 'error', {
                message: 'GIF trimming failed',
                metadata: { error: trimError.message },
              });
              logger.error(`GIF trimming failed: ${trimError.message}`);
              // Fall back to saving original GIF without trimming
              logger.info(`Falling back to saving original GIF without trimming`);
              finalBuffer = fileData.buffer;
              // Clean up temp files on error
              await cleanupTempFiles(tmpDir, [inputGifPath, outputGifPath]);
            }
          } else {
            finalBuffer = fileData.buffer;
          }

          // If trimmed GIF already exists, return early (similar to original file exists check)
          if (exists && filePath) {
            // filePath might be a local path or R2 URL
            let fileUrl;
            if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
              // Already an R2 URL
              fileUrl = filePath;
            } else {
              // Local path, construct URL
              const filename = path.basename(filePath);
              fileUrl = `${CDN_BASE_URL.replace('/gifs', cdnPath)}/${filename}`;
            }
            // Use 'gif' as fileType for database (we're in the GIF block)
            const dbFileType = 'gif';
            logger.info(`${dbFileType} already exists (hash: ${hash}) for user ${userId}`);
            // Get file size for existing file
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
            // Use .gif extension (we're in the GIF block)
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

            // Send success notification
            await notifyCommandSuccess(username, 'download', { operationId, userId });
            return;
          }

          // Save as GIF (we're in the GIF block)
          logger.info(`Saving GIF (hash: ${hash})`);
          const saveResult = await saveGif(finalBuffer, hash, GIF_STORAGE_PATH, buildMetadata());
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

            // Create temporary files for input and output
            const tmpDir = tmp.dirSync({ unsafeCleanup: true });
            const inputGifPath = path.join(tmpDir.name, `input${ext}`);
            const outputGifPath = path.join(tmpDir.name, 'output.gif');

            try {
              // Write original file to temp file
              await fs.writeFile(inputGifPath, fileData.buffer);

              // Trim as GIF (even though content is video, output should be GIF)
              await trimGif(inputGifPath, outputGifPath, {
                startTime,
                duration,
              });

              // Read trimmed GIF
              const trimmedBuffer = await fs.readFile(outputGifPath);

              // Generate new hash for trimmed GIF
              hash = generateHash(trimmedBuffer);
              // Always reflect the trimmed content, even if a file with this hash already exists
              // on disk - see the analogous fix in the GIF-trim branch above for why.
              finalBuffer = trimmedBuffer;

              // We're treating this as a GIF now (even though it was detected as video)
              // Update cdnPath and use .gif extension for saving
              cdnPath = '/gifs';
              treatAsGif = true;

              // Check if trimmed GIF already exists
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

              // Clean up temp files
              await cleanupTempFiles(tmpDir, [inputGifPath, outputGifPath]);
            } catch (trimError) {
              logOperationStep(operationId, 'gif_trim', 'error', {
                message: 'GIF trimming failed',
                metadata: { error: trimError.message },
              });
              logger.error(`GIF trimming failed: ${trimError.message}`);
              // Fall back to saving original file without trimming
              logger.info(`Falling back to saving original file without trimming`);
              finalBuffer = fileData.buffer;
              // Clean up temp files on error
              await cleanupTempFiles(tmpDir, [inputGifPath, outputGifPath]);
            }

            // If we trimmed as GIF (even though detected as video), handle it as GIF
            if (treatAsGif) {
              // Check if trimmed GIF already exists and return early
              if (exists && filePath) {
                // filePath might be a local path or R2 URL
                let fileUrl;
                if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
                  // Already an R2 URL
                  fileUrl = filePath;
                } else {
                  // Local path, construct URL
                  const filename = path.basename(filePath);
                  fileUrl = `${CDN_BASE_URL.replace('/gifs', cdnPath)}/${filename}`;
                }
                logger.info(`GIF already exists (hash: ${hash}) for user ${userId}`);
                // Get file size for existing file
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

                // Record processed URL in database
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

                // Send success notification
                await notifyCommandSuccess(username, 'download', { operationId, userId });
                return;
              }

              // Save the trimmed GIF
              logger.info(`Saving GIF (hash: ${hash}) - trimmed from video with .gif extension`);
              const saveResult = await saveGif(
                finalBuffer,
                hash,
                GIF_STORAGE_PATH,
                buildMetadata()
              );
              filePath = saveResult.url;
              finalBuffer = saveResult.buffer;
              finalUploadMethod = saveResult.method;
              // Note: We continue below to handle optimization and upload, but skip video-specific logic
            }
            // Close the if (ext === '.gif' && ...) block
          } else if (!alreadyTrimmedByYtdlp && (startTime !== null || duration !== null)) {
            // Regular video trimming (not .gif extension)
            logger.info(
              `Trimming video (hash: ${hash}, extension: ${ext}, startTime: ${startTime}, duration: ${duration})`
            );
            logOperationStep(operationId, 'video_trim', 'running', {
              message: 'Trimming video',
              metadata: { startTime, duration },
            });

            // Create temporary files for input and output
            // Always use .mp4 extension for video output (trimVideo outputs MP4 format)
            const tmpDir = tmp.dirSync({ unsafeCleanup: true });
            const inputVideoPath = path.join(tmpDir.name, `input${ext}`);
            const outputVideoPath = path.join(tmpDir.name, 'output.mp4');

            try {
              // Write original video to temp file
              await fs.writeFile(inputVideoPath, fileData.buffer);

              // Trim the video
              await trimVideo(inputVideoPath, outputVideoPath, {
                startTime,
                duration,
              });

              // Read trimmed video
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

              // Check if trimmed video already exists
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

              // Clean up temp files
              await cleanupTempFiles(tmpDir, [inputVideoPath, outputVideoPath]);
            } catch (trimError) {
              logOperationStep(operationId, 'video_trim', 'error', {
                message: 'Video trimming failed',
                metadata: { error: trimError.message },
              });
              logger.error(`Video trimming failed: ${trimError.message}`);
              // Fall back to saving original video without trimming
              logger.info(`Falling back to saving original video without trimming`);
              finalBuffer = fileData.buffer;
              // Clean up temp files on error
              await cleanupTempFiles(tmpDir, [inputVideoPath, outputVideoPath]);
            }
          } else {
            finalBuffer = fileData.buffer;
          }

          // Update saveExt for trimmed videos (but not if we're treating as GIF)
          if (fileType === 'video' && (startTime !== null || duration !== null) && !treatAsGif) {
            saveExt = '.mp4';
          }

          // If trimmed file already exists, return early (similar to original file exists check)
          if (exists && filePath) {
            // filePath might be a local path or R2 URL
            let fileUrl;
            if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
              // Already an R2 URL
              fileUrl = filePath;
            } else {
              // Local path, construct URL
              const filename = path.basename(filePath);
              fileUrl = `${CDN_BASE_URL.replace('/gifs', cdnPath)}/${filename}`;
            }
            logger.info(`${fileType} already exists (hash: ${hash}) for user ${userId}`);
            // Get file size for existing file
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
            // Use saveExt for trimmed videos, ext for others
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

            // Send success notification
            await notifyCommandSuccess(username, 'download', { operationId, userId });
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
              buildMetadata()
            );
            filePath = saveResult.url;
            finalBuffer = saveResult.buffer;
            finalUploadMethod = saveResult.method;
          }
          // If treatAsGif is true, we already saved it as GIF above, so skip video saving
        } else if (fileType === 'image') {
          logger.info(`Saving image (hash: ${hash}, extension: ${ext})`);
          const saveResult = await saveImage(
            fileData.buffer,
            hash,
            ext,
            GIF_STORAGE_PATH,
            buildMetadata()
          );
          filePath = saveResult.url;
          finalBuffer = saveResult.buffer;
          finalUploadMethod = saveResult.method;
        }

        // filePath might be a local path or R2 URL
        let fileUrl;
        let finalSize;
        if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
          // Already an R2 URL
          fileUrl = filePath;
          // Get size from buffer since we can't stat R2 files
          finalSize = finalBuffer.length;
        } else {
          // Local path, construct URL
          const filename = path.basename(filePath);
          fileUrl = `${CDN_BASE_URL.replace('/gifs', cdnPath)}/${filename}`;
          // Get final file size
          const finalStats = await fs.stat(filePath);
          finalSize = finalStats.size;
        }

        const finalSizeMB = (finalSize / (1024 * 1024)).toFixed(2);

        logger.info(
          `Successfully saved ${fileType} (hash: ${hash}, size: ${finalSizeMB}MB) for user ${userId}`
        );

        // Record processed URL in database
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

        // Track temporary upload if file was uploaded to R2
        if (finalUploadMethod === 'r2') {
          await trackR2UploadIfApplicable(urlHash, fileUrl, adminUser);
        }

        // Update operation to success with file size
        updateOperationStatus(operationId, 'success', { fileSize: finalSize });

        // Send as Discord attachment if < 8MB, otherwise send URL
        if (finalUploadMethod === 'discord') {
          const safeHash = hash.replace(/[^a-f0-9]/gi, '');
          const filename = `${safeHash}${dbExt}`;
          try {
            const message = await safeInteractionEditReply(interaction, {
              files: [new AttachmentBuilder(finalBuffer, { name: filename })],
            });

            // Capture Discord attachment URL and log
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

            // Log Discord upload with URL if captured
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
            // Discord upload failed, fallback to R2
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
                // Update database with R2 URL
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
                  content: formatR2UrlWithDisclaimer(r2Url, r2Config, adminUser),
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
            content: formatR2UrlWithDisclaimer(fileUrl, r2Config, adminUser),
          });
        }

        // Send success notification
        await notifyCommandSuccess(username, 'download', { operationId, userId });

        // Record rate limit after successful download
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

/**
 * Handle download context menu command
 * @param {Interaction} interaction - Discord interaction
 */
export async function handleDownloadContextMenuCommand(interaction) {
  if (!interaction.isMessageContextMenuCommand()) {
    return;
  }

  if (interaction.commandName !== 'download') {
    return;
  }

  const userId = interaction.user.id;
  const username = interaction.user.tag || interaction.user.username || 'unknown';
  const adminUser = isAdmin(userId);

  logger.info(
    `User ${userId} (${interaction.user.tag}) initiated download via context menu${adminUser ? ' [ADMIN]' : ''}`
  );

  if (
    await replyIfRateLimited(interaction, {
      type: 'download',
      action: 'downloading another video',
      commandSource: 'context-menu',
    })
  ) {
    return;
  }

  // Get the message that was right-clicked
  const targetMessage = interaction.targetMessage;

  // Extract URLs from message content
  let url = null;
  if (targetMessage.content) {
    // Extract URLs from message content
    const urlPattern = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
    const urls = targetMessage.content.match(urlPattern);
    if (urls && urls.length > 0) {
      url = urls[0]; // Use the first URL found
      logger.info(`Found URL in message content: ${url}`);
    }
  }

  // Check if URL was found
  if (!url) {
    logger.warn(`No URL found in message for user ${userId}`);
    const errorMessage = 'no URL found in this message.';
    createFailedOperation('download', userId, username, errorMessage, 'missing_url', {
      commandSource: 'context-menu',
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    await notifyCommandFailure(username, 'download', {
      userId,
      error: errorMessage,
    });
    return;
  }

  // Validate URL format
  const urlValidation = validateUrl(url);
  if (!urlValidation.valid) {
    logger.warn(`Invalid URL for user ${userId}: ${urlValidation.error}`);
    await safeInteractionReply(interaction, {
      content: `invalid URL: ${urlValidation.error}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Check if URL is from YouTube
  const isYouTube = isYouTubeUrl(url);

  // Check if URL is from YouTube but yt-dlp is disabled
  if (isYouTube && !YTDLP_ENABLED) {
    logger.warn(`User ${userId} attempted to download from YouTube (yt-dlp disabled)`);
    const errorMessage = 'youtube downloads are disabled.';
    createFailedOperation('download', userId, username, errorMessage, 'ytdlp_disabled', {
      originalUrl: url,
      commandSource: 'context-menu',
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Check if downloader is available for the URL type
  if (isYouTube) {
    // YouTube requires yt-dlp (already checked above that it's enabled)
    logger.info(`YouTube URL detected, will use yt-dlp for download`);
  } else if (!COBALT_ENABLED) {
    // Non-YouTube URLs require Cobalt
    const errorMessage = 'cobalt is not enabled.';
    createFailedOperation('download', userId, username, errorMessage, 'cobalt_disabled', {
      originalUrl: url,
      commandSource: 'context-menu',
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    await notifyCommandFailure(username, 'download', { userId, error: errorMessage });
    return;
  } else if (!isSocialMediaUrl(url)) {
    // Non-YouTube URLs must be from supported social media platforms
    const errorMessage = 'url is not from a supported social media platform.';
    createFailedOperation('download', userId, username, errorMessage, 'invalid_social_media_url', {
      originalUrl: url,
      commandSource: 'context-menu',
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    await notifyCommandFailure(username, 'download', {
      userId,
      error: errorMessage,
    });
    return;
  }

  // Defer reply since downloading may take time
  await safeInteractionDeferReply(interaction);

  await processDownload(interaction, url, 'context-menu');
}

/**
 * Handle download command
 * @param {Interaction} interaction - Discord interaction
 */
export async function handleDownloadCommand(interaction) {
  const userId = interaction.user.id;
  const username = interaction.user.tag || interaction.user.username || 'unknown';
  const adminUser = isAdmin(userId);

  logger.info(
    `User ${userId} (${interaction.user.tag}) initiated download${adminUser ? ' [ADMIN]' : ''}`
  );

  if (
    await replyIfRateLimited(interaction, {
      type: 'download',
      action: 'downloading another video',
      commandSource: 'slash',
    })
  ) {
    return;
  }

  // Get URL from command options
  const url = interaction.options.getString('url');
  const startTime = interaction.options.getNumber('start_time');
  const endTime = interaction.options.getNumber('end_time');

  // Validate time parameters if provided
  if (startTime !== null && endTime !== null) {
    if (endTime <= startTime) {
      logger.warn(
        `Invalid time range for user ${userId}: end_time (${endTime}) must be greater than start_time (${startTime})`
      );
      const errorMessage = 'end_time must be greater than start_time.';
      createFailedOperation('download', userId, username, errorMessage, 'invalid_time_range', {
        commandSource: 'slash',
        commandOptions: { startTime, endTime },
      });
      await safeInteractionReply(interaction, {
        content: errorMessage,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  // Convert start_time/end_time to startTime/duration format for video trimming
  // Only apply time parameters for videos (they will be ignored for images/gifs)
  let trimStartTime = null;
  let trimDuration = null;

  if (startTime !== null && endTime !== null) {
    // Both provided: use range
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
    createFailedOperation('download', userId, username, errorMessage, 'missing_url', {
      commandSource: 'slash',
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    await notifyCommandFailure(username, 'download', { userId, error: errorMessage });
    return;
  }

  // Validate URL format
  const urlValidation = validateUrl(url);
  if (!urlValidation.valid) {
    logger.warn(`Invalid URL for user ${userId}: ${urlValidation.error}`);
    const errorMessage = `invalid URL: ${urlValidation.error}`;
    createFailedOperation('download', userId, username, errorMessage, 'invalid_url', {
      originalUrl: url,
      commandSource: 'slash',
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Check if URL is from YouTube
  const isYouTube = isYouTubeUrl(url);

  // Check if URL is from YouTube but yt-dlp is disabled
  if (isYouTube && !YTDLP_ENABLED) {
    logger.warn(`User ${userId} attempted to download from YouTube (yt-dlp disabled)`);
    const errorMessage = 'youtube downloads are disabled.';
    createFailedOperation('download', userId, username, errorMessage, 'ytdlp_disabled', {
      originalUrl: url,
      commandSource: 'slash',
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Check if downloader is available for the URL type
  if (isYouTube) {
    // YouTube requires yt-dlp (already checked above that it's enabled)
    logger.info(`YouTube URL detected, will use yt-dlp for download`);
  } else if (!COBALT_ENABLED) {
    // Non-YouTube URLs require Cobalt
    const errorMessage = 'cobalt is not enabled. please enable it to use the download command.';
    createFailedOperation('download', userId, username, errorMessage, 'cobalt_disabled', {
      originalUrl: url,
      commandSource: 'slash',
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    await notifyCommandFailure(username, 'download', { userId, error: errorMessage });
    return;
  } else if (!isSocialMediaUrl(url)) {
    // Non-YouTube URLs must be from supported social media platforms
    const errorMessage = 'url is not from a supported social media platform.';
    createFailedOperation('download', userId, username, errorMessage, 'invalid_social_media_url', {
      originalUrl: url,
      commandSource: 'slash',
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    await notifyCommandFailure(username, 'download', {
      userId,
      error: errorMessage,
    });
    return;
  }

  // Defer reply since downloading may take time
  await safeInteractionDeferReply(interaction);

  await processDownload(interaction, url, 'slash', trimStartTime, trimDuration);
}
