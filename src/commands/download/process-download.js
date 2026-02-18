/**
 * Main download processing orchestrator
 */
import { createLogger } from '../../utils/logger.js';
import { botConfig, r2Config } from '../../utils/config.js';
import { isAdmin, recordRateLimit } from '../../utils/rate-limit.js';
import { downloadFromSocialMedia, RateLimitError } from '../../utils/cobalt.js';
import { isYouTubeUrl, downloadFromYouTube, YtdlpRateLimitError } from '../../utils/ytdlp.js';
import { queueCobaltRequest, hashUrlWithParams } from '../../utils/cobalt-queue.js';
import { getProcessedUrl } from '../../utils/database.js';
import { initializeDatabaseWithErrorHandling } from '../../utils/database-init.js';
import { formatR2UrlWithDisclaimer } from '../../utils/r2-storage.js';
import { notifyCommandSuccess, notifyCommandFailure } from '../../utils/ntfy-notifier.js';
import { safeInteractionEditReply } from '../../utils/interaction-helpers.js';
import {
  createOperation,
  updateOperationStatus,
  logOperationStep,
  logOperationError,
} from '../../utils/operations-tracker.js';
import { DOWNLOAD_LIMITS } from './utils.js';
import { processPickerResponse } from './process-picker.js';
import { processSingleFile } from './process-single.js';

const logger = createLogger('download');

const {
  maxVideoSize: MAX_VIDEO_SIZE,
  cobaltApiUrl: COBALT_API_URL,
  ytdlpQuality: YTDLP_QUALITY,
} = botConfig;

/**
 * Process download from URL
 * @param {Interaction} interaction - Discord interaction
 * @param {string} url - URL to download from
 * @param {string} [commandSource] - Command source ('slash' or 'context-menu')
 * @param {number|null} [startTime] - Start time in seconds for video trimming
 * @param {number|null} [duration] - Duration in seconds for video trimming
 */
export async function processDownload(
  interaction,
  url,
  commandSource = null,
  startTime = null,
  duration = null
) {
  const userId = interaction.user.id;
  const username = interaction.user.tag || interaction.user.username || 'unknown';
  const adminUser = isAdmin(userId);

  // Build operation context
  const operationContext = { originalUrl: url };
  if (commandSource) {
    operationContext.commandSource = commandSource;
  }

  // Create operation tracking
  const operationId = createOperation('download', userId, username, operationContext);

  try {
    // Initialize database
    const dbInitSuccess = await initializeDatabaseWithErrorHandling({
      operationId,
      userId,
      username,
      commandName: 'download',
      interaction,
      context: { url },
    });
    if (!dbInitSuccess) {
      return;
    }

    updateOperationStatus(operationId, 'running');

    // Check URL cache
    const cacheResult = await checkUrlCache({
      url,
      startTime,
      duration,
      operationId,
      userId,
      username,
      adminUser,
      interaction,
    });
    if (cacheResult.handled) {
      return;
    }

    const urlHash = cacheResult.urlHash;

    // Download the file
    const downloadResult = await downloadFile({
      url,
      startTime,
      duration,
      adminUser,
      operationId,
      urlHash,
      interaction,
      userId,
      username,
    });
    if (downloadResult.handled) {
      return;
    }

    const { fileData, downloadMethod } = downloadResult;

    // Process the downloaded file(s)
    if (Array.isArray(fileData)) {
      await processPickerResponse({
        interaction,
        fileData,
        operationId,
        urlHash,
        userId,
        username,
        adminUser,
      });
    } else {
      await processSingleFile({
        interaction,
        fileData,
        operationId,
        urlHash,
        userId,
        username,
        adminUser,
        startTime,
        duration,
        downloadMethod,
      });
    }
  } catch (error) {
    await handleDownloadError({
      error,
      url,
      operationId,
      userId,
      username,
      interaction,
    });
  }
}

/**
 * Check URL cache for existing processed file
 * @param {Object} params - Parameters
 * @returns {Promise<{handled: boolean, urlHash: string}>}
 */
async function checkUrlCache({
  url,
  startTime,
  duration,
  operationId,
  userId,
  username,
  adminUser,
  interaction,
}) {
  logOperationStep(operationId, 'url_validation', 'running', {
    message: 'Validating URL',
    metadata: { url },
  });

  const urlHash = hashUrlWithParams(url, { startTime, duration });
  const processedUrl = await getProcessedUrl(urlHash);

  if (processedUrl && processedUrl.file_type === 'video') {
    logger.info(
      `URL already processed as video (hash: ${urlHash.substring(0, 8)}..., startTime: ${startTime}, duration: ${duration}), returning existing file URL: ${processedUrl.file_url}`
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
        startTime,
        duration,
      },
    });

    updateOperationStatus(operationId, 'success', { fileSize: 0 });
    recordRateLimit(userId);

    await safeInteractionEditReply(interaction, {
      content: formatR2UrlWithDisclaimer(processedUrl.file_url, r2Config, adminUser),
    });
    await notifyCommandSuccess(username, 'download', { operationId, userId });

    return { handled: true, urlHash };
  }

  if (processedUrl) {
    logger.info(
      `URL cache exists but file type is ${processedUrl.file_type} (not video), skipping cache to download video`
    );
    logOperationStep(operationId, 'url_cache_mismatch', 'running', {
      message: 'URL cached with different file type, downloading video instead',
      metadata: { url, cachedType: processedUrl.file_type },
    });
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

  return { handled: false, urlHash };
}

/**
 * Download file from URL
 * @param {Object} params - Parameters
 * @returns {Promise<{handled: boolean, fileData?: Object|Array, downloadMethod?: string}>}
 */
async function downloadFile({
  url,
  startTime,
  duration,
  adminUser,
  operationId,
  urlHash,
  interaction,
  userId,
  username,
}) {
  const maxSize = adminUser ? Infinity : MAX_VIDEO_SIZE;
  const isYouTube = isYouTubeUrl(url);

  // Determine download method
  let downloadMethod;
  if (isYouTube) {
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

  let fileData;
  try {
    if (downloadMethod === 'ytdlp') {
      const skipDurationLimit = startTime !== null || duration !== null;
      const maxDuration =
        skipDurationLimit || adminUser ? Infinity : DOWNLOAD_LIMITS.MAX_YOUTUBE_DURATION;

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
        metadata: { url, fileCount: 1, trimmedByYtdlp, startTime, duration },
      });
    } else {
      fileData = await queueCobaltRequest(
        url,
        async () => downloadFromSocialMedia(COBALT_API_URL, url, adminUser, maxSize),
        { skipCache: startTime !== null || duration !== null, expectedFileType: 'video' }
      );

      logOperationStep(operationId, 'download_complete', 'success', {
        message: 'File downloaded successfully',
        metadata: { url, fileCount: Array.isArray(fileData) ? fileData.length : 1 },
      });
    }
  } catch (error) {
    // Handle yt-dlp rate limit error
    if (error instanceof YtdlpRateLimitError) {
      throw error;
    }

    // Handle cached URL error
    if (error.message && error.message.startsWith('URL_ALREADY_PROCESSED:')) {
      const urlMatch = error.message.match(/^URL_ALREADY_PROCESSED:(.+)$/);
      if (urlMatch && urlMatch[1]) {
        const fileUrl = urlMatch[1];
        const processedUrl = await getProcessedUrl(urlHash);

        if (processedUrl && processedUrl.file_type !== 'video') {
          logger.warn(
            `Cached entry file type mismatch (expected: video, got: ${processedUrl.file_type}), proceeding with download`
          );
          logOperationStep(operationId, 'url_cache_mismatch', 'running', {
            message: 'Cached entry file type mismatch, downloading video instead',
            metadata: { url, cachedType: processedUrl.file_type },
          });
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

        return { handled: true };
      }
    }

    throw error;
  }

  return { handled: false, fileData, downloadMethod };
}

/**
 * Handle download error
 * @param {Object} params - Parameters
 */
async function handleDownloadError({ error, url, operationId, userId, username, interaction }) {
  logger.error(`Download failed for user ${userId}:`, error);

  const errorMetadata = {
    originalUrl: url,
    errorMessage: error.message || 'unknown error',
    errorName: error.name || 'Error',
    errorCode: error.code || null,
    isRateLimit: error instanceof RateLimitError,
  };

  // Extract error message
  let errorMessage = 'an error occurred while downloading the file.';
  if (error) {
    if (typeof error.message === 'string' && error.message) {
      errorMessage = error.message;
    } else if (typeof error === 'string') {
      errorMessage = error;
    } else if (error.response?.data) {
      const data = error.response.data;
      if (typeof data?.text === 'string') {
        errorMessage = data.text;
      } else if (typeof data?.message === 'string') {
        errorMessage = data.message;
      } else if (typeof data?.error === 'string') {
        errorMessage = data.error;
      }
    }
  }

  logOperationError(operationId, error, { metadata: errorMetadata });
  updateOperationStatus(operationId, 'error', {
    error: errorMessage,
    stackTrace: error.stack || null,
  });

  await safeInteractionEditReply(interaction, { content: errorMessage });
  await notifyCommandFailure(username, 'download', { operationId, userId, error: errorMessage });
}
