import { MessageFlags, AttachmentBuilder } from 'discord.js';
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../utils/logger.js';
import { botConfig } from '../utils/config.js';
import { validateUrl } from '../utils/validation.js';
import {
  isSocialMediaUrl,
  downloadFromSocialMedia,
  getCobaltMediaUrls,
  getRemoteContentLength,
} from '../utils/cobalt.js';
import {
  getYtdlpSite,
  downloadFromYouTube,
  downloadWithYtdlp,
  YtdlpRateLimitError,
} from '../utils/ytdlp.js';
import { isHentaiGifzUrl, downloadFromHentaiGifz } from '../utils/hentaigifz.js';
import { isBooruUrl, downloadFromBooru } from '../utils/booru.js';
import { isPinterestUrl, downloadFromPinterest } from '../utils/pinterest.js';
import { isKlipyUrl, downloadFromKlipy } from '../utils/klipy.js';
import {
  isInstagramPostUrl,
  hasInstagramSession,
  downloadFromInstagram,
} from '../utils/instagram.js';
import { getDisabledServiceLabel } from '../utils/download-services.js';
import { AppError, ValidationError } from '../utils/errors.js';
import { batchAttachmentsForDelivery } from '../utils/attachment-helpers.js';
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
  resolveTtlHoursForSize,
} from '../utils/storage.js';
import { cleanupTempFiles as storageCleanupTempFiles } from '../utils/storage.js';
import {
  uploadGifToR2,
  uploadVideoToR2,
  uploadImageToR2,
  formatR2UrlWithDisclaimer,
  formatMultipleR2UrlsWithDisclaimer,
} from '../utils/r2-storage.js';
import { hashUrl } from '../utils/hashing.js';
import { notifyCommandSuccess, notifyCommandFailure } from '../utils/ntfy-notifier.js';
import { getProcessedUrl, getBooleanSetting, getSetting } from '../utils/database.js';
import { recordProcessedUrl, trackR2UploadIfApplicable } from './shared/url-cache.js';
import { runMediaCommand } from './shared/run-media-command.js';
import { replyIfRateLimited, resolveTimeOptions } from './shared/command-guards.js';
import { r2Config } from '../utils/config.js';
import { trimVideo, trimGif } from '../utils/video-processor.js';
import {
  safeInteractionReply,
  safeInteractionEditReply,
  safeInteractionFollowUp,
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

// Human-readable label for a Cobalt-primary host, used when a Cobalt download fails and we
// retry via yt-dlp. Cobalt's per-service extractors are flaky/auth-gated (Instagram, Reddit,
// etc.); yt-dlp handles many of the same hosts (and, with a cookies file, private/gated
// Instagram). Returning a non-null label makes any Cobalt failure eligible for the yt-dlp retry,
// not just X/Twitter and TikTok.
function cobaltFallbackLabel(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'this platform';
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
 * Non-admin duration backstop in seconds for yt-dlp downloads, live-editable from the
 * webui settings page (max_video_duration). Size is the primary gate now (yt-dlp aborts
 * oversized downloads via --max-filesize); this just caps pathological lengths. Falls back
 * to 3600 (60 minutes) when unset or unparsable.
 * @returns {Promise<number>} Cap in seconds
 */
async function getMaxVideoDuration() {
  const raw = await getSetting('max_video_duration', '3600');
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3600;
}

/**
 * Non-admin max download size in bytes, live-editable from the webui settings page
 * (max_video_size_mb, stored in MB). This is the primary download gate — oversized videos
 * are rejected before download via yt-dlp --max-filesize. Falls back to the MAX_VIDEO_SIZE
 * env/config default when unset or unparsable.
 * @returns {Promise<number>} Cap in bytes
 */
async function getMaxVideoSize() {
  const mb = parseInt(await getSetting('max_video_size_mb', ''), 10);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : MAX_VIDEO_SIZE;
}

/**
 * Reply with direct media URL(s) from cobalt instead of downloading/uploading.
 * Used by url-only mode and as a last-resort fallback for X/Twitter videos that
 * exceed the download limits (Discord embeds direct video.twimg.com URLs and
 * plays the full video, so length/size caps don't apply).
 * The concurrency limit lives inside cobalt.js, so lookups share the same cap as
 * regular downloads without the call site knowing about it.
 * Throws when the cobalt API call fails; callers decide whether to fall back.
 * @param {Object} params
 * @param {Interaction} params.interaction - Discord interaction
 * @param {string} params.operationId - Operation tracker id
 * @param {string} params.userId - Discord user id
 * @param {string} params.username - Discord username
 * @param {string} params.url - Original social media URL
 * @param {string} params.stepName - Operation step name to log under
 * @param {Function|null} [params.shouldServe] - Optional async predicate over the
 *   fetched URL list; return false to decline (caller falls back to downloading)
 * @returns {Promise<boolean>} true when a reply with URLs was sent
 */
async function replyWithDirectMediaUrls({
  interaction,
  operationId,
  userId,
  username,
  url,
  stepName,
  shouldServe = null,
}) {
  const { urls, direct } = await getCobaltMediaUrls(COBALT_API_URL, url);
  if (!direct || urls.length === 0) {
    return false;
  }
  if (shouldServe && !(await shouldServe(urls))) {
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
      if (startTime === null && duration === null) {
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
            await notifyCommandSuccess(username, 'download', { operationId, userId });
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

      const maxSize = adminUser ? Infinity : await getMaxVideoSize();
      const ytdlpSite = getYtdlpSite(url);
      const isHentaiGifz = isHentaiGifzUrl(url);
      const isBooru = isBooruUrl(url);
      const isPinterest = isPinterestUrl(url);
      const isKlipy = isKlipyUrl(url);
      // Instagram posts go through our own media-info extractor first, but only when a
      // session cookie is configured — without one it cannot work at all, and cobalt (the
      // previous behaviour) stays the only route.
      const useInstagram = isInstagramPostUrl(url) && hasInstagramSession();
      // yt-dlp sites (youtube, redgifs, imgur, the tube sites, etc.) download through
      // yt-dlp, not Cobalt.
      const useYtdlp = ytdlpSite !== null && YTDLP_ENABLED;

      // URL-only mode (toggleable from the webui): reply with the direct media URL
      // from cobalt instead of downloading/uploading. Trim requests still need a real
      // download, and the yt-dlp sites, hentaigifz, booru, and Pinterest have no cobalt
      // direct URL to hand out.
      if (
        COBALT_ENABLED &&
        !useYtdlp &&
        !isHentaiGifz &&
        !isBooru &&
        !isPinterest &&
        !isKlipy &&
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

      // Twitter delivery policy (webui setting twitter_delivery): serving the direct
      // video.twimg.com URL instead of rehosting skips the whole download+upload for
      // large videos, saving bandwidth and R2 storage. 'hybrid' serves the URL only
      // when the video wouldn't fit as a Discord attachment (small clips keep the
      // nicer attachment UX and survive tweet deletion); 'always_url' serves it
      // whenever cobalt offers one. Trim requests always need real bytes. Any
      // failure here falls through to the normal download path.
      if (COBALT_ENABLED && isTwitterXUrl(url) && startTime === null && duration === null) {
        const deliveryMode = await getSetting('twitter_delivery', 'hybrid');
        if (deliveryMode === 'always_url' || deliveryMode === 'hybrid') {
          try {
            const replied = await replyWithDirectMediaUrls({
              interaction,
              operationId,
              userId,
              username,
              url,
              stepName: 'twitter_delivery',
              shouldServe:
                deliveryMode === 'always_url'
                  ? null
                  : async urls => {
                      // hybrid: only bypass rehosting for a single video too big to attach
                      if (urls.length !== 1 || urls[0].type !== 'video') {
                        return false;
                      }
                      const size = await getRemoteContentLength(urls[0].url);
                      return size !== null && size > DISCORD_SIZE_LIMIT;
                    },
            });
            if (replied) {
              return;
            }
          } catch (deliveryError) {
            logger.warn(
              `Twitter delivery policy (${deliveryMode}) failed, downloading instead: ${deliveryError.message}`
            );
            logOperationStep(operationId, 'twitter_delivery', 'success', {
              message: 'Direct URL delivery failed, falling back to normal download',
              metadata: { url, deliveryMode, reason: deliveryError.message },
            });
          }
        }
      }

      let downloadMethod;
      if (useYtdlp) {
        downloadMethod = 'ytdlp';
        logger.info(`Downloading from ${ytdlpSite} via yt-dlp: ${url}`);
        logOperationStep(operationId, 'download_start', 'running', {
          message: `Starting download from ${ytdlpSite} via yt-dlp`,
          metadata: { url, maxSize: adminUser ? 'unlimited' : maxSize },
        });
      } else if (isHentaiGifz) {
        downloadMethod = 'hentaigifz';
        logger.info(`Downloading from hentaigifz page scrape: ${url}`);
        logOperationStep(operationId, 'download_start', 'running', {
          message: 'Starting download from hentaigifz',
          metadata: { url, maxSize: adminUser ? 'unlimited' : maxSize },
        });
      } else if (isBooru) {
        downloadMethod = 'booru';
        logger.info(`Downloading from booru API: ${url}`);
        logOperationStep(operationId, 'download_start', 'running', {
          message: 'Starting download from booru',
          metadata: { url, maxSize: adminUser ? 'unlimited' : maxSize },
        });
      } else if (isPinterest) {
        downloadMethod = 'pinterest';
        logger.info(`Downloading from Pinterest page scrape: ${url}`);
        logOperationStep(operationId, 'download_start', 'running', {
          message: 'Starting download from Pinterest',
          metadata: { url, maxSize: adminUser ? 'unlimited' : maxSize },
        });
      } else if (isKlipy) {
        downloadMethod = 'klipy';
        logger.info(`Downloading from Klipy page scrape: ${url}`);
        logOperationStep(operationId, 'download_start', 'running', {
          message: 'Starting download from Klipy',
          metadata: { url, maxSize: adminUser ? 'unlimited' : maxSize },
        });
      } else if (useInstagram) {
        downloadMethod = 'instagram';
        logger.info(`Downloading from Instagram media-info API: ${url}`);
        logOperationStep(operationId, 'download_start', 'running', {
          message: 'Starting download from Instagram',
          metadata: { url, maxSize: adminUser ? 'unlimited' : maxSize },
        });
      } else {
        downloadMethod = 'cobalt';
        logger.info(`Downloading file from Cobalt: ${url}`);
        logOperationStep(operationId, 'download_start', 'running', {
          message: 'Starting download from Cobalt',
          metadata: { url, maxSize: adminUser ? 'unlimited' : maxSize },
        });
      }

      let fileData;
      try {
        if (downloadMethod === 'ytdlp') {
          // if trimming is requested, yt-dlp will download ONLY the requested segment using --download-sections
          // this avoids downloading huge files and then trimming them
          const skipDurationLimit = startTime !== null || duration !== null;
          const maxDuration =
            skipDurationLimit || adminUser ? Infinity : await getMaxVideoDuration();

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
        } else if (downloadMethod === 'hentaigifz') {
          fileData = await downloadFromHentaiGifz(url, adminUser);
          logOperationStep(operationId, 'download_complete', 'success', {
            message: 'file downloaded successfully via hentaigifz',
            metadata: { url, fileCount: 1 },
          });
        } else if (downloadMethod === 'booru') {
          fileData = await downloadFromBooru(url, adminUser);
          logOperationStep(operationId, 'download_complete', 'success', {
            message: 'file downloaded successfully via booru',
            metadata: { url, fileCount: 1 },
          });
        } else if (downloadMethod === 'pinterest') {
          fileData = await downloadFromPinterest(url, adminUser);
          logOperationStep(operationId, 'download_complete', 'success', {
            message: 'file downloaded successfully via Pinterest',
            metadata: { url, fileCount: 1 },
          });
        } else if (downloadMethod === 'klipy') {
          fileData = await downloadFromKlipy(url, adminUser);
          logOperationStep(operationId, 'download_complete', 'success', {
            message: 'file downloaded successfully via Klipy',
            metadata: { url, fileCount: 1 },
          });
        } else if (downloadMethod === 'instagram') {
          // Cobalt stays the safety net: an expired session or a shape change must not take
          // out reels, which cobalt still handles. Falling through can only add coverage.
          try {
            fileData = await downloadFromInstagram(url, adminUser);
            logOperationStep(operationId, 'download_complete', 'success', {
              message: 'file downloaded successfully via Instagram',
              metadata: { url, fileCount: 1 },
            });
          } catch (instagramError) {
            logger.warn(
              `Instagram extractor failed, falling back to cobalt: ${instagramError.message}`
            );
            logOperationStep(operationId, 'download_fallback', 'running', {
              message: 'Instagram extractor failed, retrying with cobalt',
              metadata: { url, reason: instagramError.message },
            });
            downloadMethod = 'cobalt';
          }
        }

        if (downloadMethod === 'cobalt') {
          try {
            // Concurrency is capped inside cobalt.js. The URL cache was already consulted
            // above (and deliberately skipped when trimming), so there is no second check here.
            fileData = await downloadFromSocialMedia(COBALT_API_URL, url, adminUser, maxSize);
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
                : cobaltFallbackLabel(url);

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
              if (!(await getBooleanSetting('twitter_direct_url_fallback', true))) {
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
            const maxDuration =
              skipDurationLimit || adminUser ? Infinity : await getMaxVideoDuration();

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
        if (error instanceof YtdlpRateLimitError) {
          throw error;
        }
        throw error;
      }

      if (Array.isArray(fileData)) {
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

        await notifyCommandSuccess(username, 'download', { operationId, userId });
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

        await notifyCommandSuccess(username, 'download', { operationId, userId });
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

            await notifyCommandSuccess(username, 'download', { operationId, userId });
            return;
          }

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

                await notifyCommandSuccess(username, 'download', { operationId, userId });
                return;
              }

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

        // Send as Discord attachment if < 8MB, otherwise send URL
        if (finalUploadMethod === 'discord') {
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

        await notifyCommandSuccess(username, 'download', { operationId, userId });

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

  const targetMessage = interaction.targetMessage;

  let url = null;
  if (targetMessage.content) {
    const urlPattern = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
    const urls = targetMessage.content.match(urlPattern);
    if (urls && urls.length > 0) {
      url = urls[0]; // Use the first URL found
      logger.info(`Found URL in message content: ${url}`);
    }
  }

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

  const urlValidation = validateUrl(url);
  if (!urlValidation.valid) {
    logger.warn(`Invalid URL for user ${userId}: ${urlValidation.error}`);
    await safeInteractionReply(interaction, {
      content: `invalid URL: ${urlValidation.error}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Classify the URL: yt-dlp site (youtube/redgifs/imgur/...) or not
  const ytdlpSite = getYtdlpSite(url);

  if (ytdlpSite && !YTDLP_ENABLED) {
    logger.warn(`User ${userId} attempted to download from ${ytdlpSite} (yt-dlp disabled)`);
    const errorMessage = `${ytdlpSite.toLowerCase()} downloads are disabled.`;
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

  if (ytdlpSite) {
    // yt-dlp sites require yt-dlp (already checked above that it's enabled)
    logger.info(`${ytdlpSite} URL detected, will use yt-dlp for download`);
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
  } else if (!COBALT_ENABLED) {
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

  const url = interaction.options.getString('url');

  // Parse and validate start_time/end_time (accepts seconds or MM:SS / HH:MM:SS timestamps)
  const times = await resolveTimeOptions(interaction, { type: 'download' });
  if (times === null) {
    return;
  }
  const { startTime, endTime } = times;

  // Convert start_time/end_time to startTime/duration format for video trimming
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

  // Classify the URL: yt-dlp site (youtube/redgifs/imgur/...) or not
  const ytdlpSite = getYtdlpSite(url);

  if (ytdlpSite && !YTDLP_ENABLED) {
    logger.warn(`User ${userId} attempted to download from ${ytdlpSite} (yt-dlp disabled)`);
    const errorMessage = `${ytdlpSite.toLowerCase()} downloads are disabled.`;
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

  if (ytdlpSite) {
    // yt-dlp sites require yt-dlp (already checked above that it's enabled)
    logger.info(`${ytdlpSite} URL detected, will use yt-dlp for download`);
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
  } else if (!COBALT_ENABLED) {
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
