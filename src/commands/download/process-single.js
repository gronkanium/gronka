/**
 * Process a single downloaded file
 */
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '../../utils/logger.js';
import { botConfig, r2Config } from '../../utils/config.js';
import { generateHash } from '../../utils/file-downloader.js';
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
  trackTemporaryUpload,
} from '../../utils/storage.js';
import { extractR2KeyFromUrl, formatR2UrlWithDisclaimer } from '../../utils/r2-storage.js';
import { insertProcessedUrl } from '../../utils/database.js';
import { updateOperationStatus } from '../../utils/operations-tracker.js';
import { recordRateLimit } from '../../utils/rate-limit.js';
import { notifyCommandSuccess } from '../../utils/ntfy-notifier.js';
import { safeInteractionEditReply } from '../../utils/interaction-helpers.js';
import { buildMetadata, getCdnPath } from './utils.js';
import { buildFileUrl, sendSingleFileToDiscord } from './upload.js';
import { trimGifFile, trimVideoFile, trimVideoAsGif, needsTrimming } from './trimming.js';

const logger = createLogger('download:single');

const { gifStoragePath: GIF_STORAGE_PATH } = botConfig;

/**
 * Process a single downloaded file
 * @param {Object} params - Parameters object
 * @param {Object} params.interaction - Discord interaction
 * @param {Object} params.fileData - File data object with buffer, filename, contentType, size
 * @param {string} params.operationId - Operation ID
 * @param {string} params.urlHash - URL hash for caching
 * @param {string} params.userId - User ID
 * @param {string} params.username - Username
 * @param {boolean} params.adminUser - Whether user is admin
 * @param {number|null} params.startTime - Start time for trimming
 * @param {number|null} params.duration - Duration for trimming
 * @param {string} params.downloadMethod - Download method ('ytdlp' or 'cobalt')
 * @returns {Promise<void>}
 */
export async function processSingleFile({
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
}) {
  const metadata = buildMetadata(userId, username);
  let hash = generateHash(fileData.buffer);
  let ext = path.extname(fileData.filename).toLowerCase() || '.mp4';
  let fileType = detectFileType(ext, fileData.contentType);
  let cdnPath = getCdnPath(fileType);
  let finalBuffer = fileData.buffer;
  let saveExt = ext;
  let treatAsGif = false;

  // Check if trimming is needed
  const shouldTrim = needsTrimming(fileType, startTime, duration, downloadMethod);

  // Check if file already exists (skip if we need to trim with ffmpeg)
  if (!shouldTrim) {
    const existsResult = await checkExistingFile(hash, ext, fileType);
    if (existsResult.exists) {
      return await handleExistingFile({
        interaction,
        filePath: existsResult.filePath,
        fileType,
        hash,
        ext,
        urlHash,
        userId,
        username,
        adminUser,
        operationId,
        buffer: fileData.buffer,
        cdnPath,
      });
    }
  }

  // Handle GIF trimming
  if (fileType === 'gif' && (startTime !== null || duration !== null)) {
    const trimResult = await trimGifFile({
      buffer: fileData.buffer,
      hash,
      ext,
      startTime,
      duration,
      storagePath: GIF_STORAGE_PATH,
      operationId,
      userId,
    });

    hash = trimResult.hash;
    finalBuffer = trimResult.buffer;

    if (trimResult.exists && trimResult.filePath) {
      return await handleExistingFile({
        interaction,
        filePath: trimResult.filePath,
        fileType: 'gif',
        hash,
        ext: '.gif',
        urlHash,
        userId,
        username,
        adminUser,
        operationId,
        buffer: finalBuffer,
        cdnPath: '/gifs',
      });
    }

    // Save the trimmed GIF
    const saveResult = await saveGif(finalBuffer, hash, GIF_STORAGE_PATH, metadata);
    return await finalizeSave({
      interaction,
      saveResult,
      fileType: 'gif',
      hash,
      ext: '.gif',
      urlHash,
      userId,
      username,
      adminUser,
      operationId,
      cdnPath: '/gifs',
    });
  }

  // Handle video processing
  if (fileType === 'video') {
    // Special case: video with .gif extension - trim as GIF
    if (ext === '.gif' && (startTime !== null || duration !== null)) {
      const trimResult = await trimVideoAsGif({
        buffer: fileData.buffer,
        hash,
        ext,
        startTime,
        duration,
        storagePath: GIF_STORAGE_PATH,
        operationId,
        userId,
      });

      if (trimResult.treatAsGif) {
        hash = trimResult.hash;
        finalBuffer = trimResult.buffer;

        if (trimResult.exists && trimResult.filePath) {
          return await handleExistingFile({
            interaction,
            filePath: trimResult.filePath,
            fileType: 'gif',
            hash,
            ext: '.gif',
            urlHash,
            userId,
            username,
            adminUser,
            operationId,
            buffer: finalBuffer,
            cdnPath: '/gifs',
          });
        }

        // Save as GIF
        const saveResult = await saveGif(finalBuffer, hash, GIF_STORAGE_PATH, metadata);
        return await finalizeSave({
          interaction,
          saveResult,
          fileType: 'gif',
          hash,
          ext: '.gif',
          urlHash,
          userId,
          username,
          adminUser,
          operationId,
          cdnPath: '/gifs',
        });
      }
    }

    // Regular video trimming
    if (startTime !== null || duration !== null) {
      const trimResult = await trimVideoFile({
        buffer: fileData.buffer,
        hash,
        ext,
        startTime,
        duration,
        storagePath: GIF_STORAGE_PATH,
        operationId,
        userId,
      });

      hash = trimResult.hash;
      finalBuffer = trimResult.buffer;
      saveExt = trimResult.ext;

      if (trimResult.exists && trimResult.filePath) {
        return await handleExistingFile({
          interaction,
          filePath: trimResult.filePath,
          fileType: 'video',
          hash,
          ext: saveExt,
          urlHash,
          userId,
          username,
          adminUser,
          operationId,
          buffer: finalBuffer,
          cdnPath: '/videos',
        });
      }
    }

    // Save the video (skip if we already saved as GIF)
    if (!treatAsGif) {
      logger.info(`Saving video (hash: ${hash}, extension: ${saveExt})`);
      const saveResult = await saveVideo(finalBuffer, hash, saveExt, GIF_STORAGE_PATH, metadata);
      return await finalizeSave({
        interaction,
        saveResult,
        fileType: 'video',
        hash,
        ext: saveExt,
        urlHash,
        userId,
        username,
        adminUser,
        operationId,
        cdnPath: '/videos',
      });
    }
  }

  // Handle image
  if (fileType === 'image') {
    logger.info(`Saving image (hash: ${hash}, extension: ${ext})`);
    const saveResult = await saveImage(fileData.buffer, hash, ext, GIF_STORAGE_PATH, metadata);
    return await finalizeSave({
      interaction,
      saveResult,
      fileType: 'image',
      hash,
      ext,
      urlHash,
      userId,
      username,
      adminUser,
      operationId,
      cdnPath: '/images',
    });
  }

  // Default: save as GIF
  logger.info(`Saving GIF (hash: ${hash})`);
  const saveResult = await saveGif(finalBuffer, hash, GIF_STORAGE_PATH, metadata);
  return await finalizeSave({
    interaction,
    saveResult,
    fileType: 'gif',
    hash,
    ext: '.gif',
    urlHash,
    userId,
    username,
    adminUser,
    operationId,
    cdnPath: '/gifs',
  });
}

/**
 * Check if a file already exists in storage
 * @param {string} hash - File hash
 * @param {string} ext - File extension
 * @param {string} fileType - File type
 * @returns {Promise<{exists: boolean, filePath: string|null}>}
 */
async function checkExistingFile(hash, ext, fileType) {
  if (fileType === 'gif') {
    const exists = await gifExists(hash, GIF_STORAGE_PATH);
    return { exists, filePath: exists ? getGifPath(hash, GIF_STORAGE_PATH) : null };
  } else if (fileType === 'video') {
    const exists = await videoExists(hash, ext, GIF_STORAGE_PATH);
    return { exists, filePath: exists ? getVideoPath(hash, ext, GIF_STORAGE_PATH) : null };
  } else if (fileType === 'image') {
    const exists = await imageExists(hash, ext, GIF_STORAGE_PATH);
    return { exists, filePath: exists ? getImagePath(hash, ext, GIF_STORAGE_PATH) : null };
  }
  return { exists: false, filePath: null };
}

/**
 * Handle an existing file (return cached URL)
 * @param {Object} params - Parameters
 * @returns {Promise<void>}
 */
async function handleExistingFile({
  interaction,
  filePath,
  fileType,
  hash,
  ext,
  urlHash,
  userId,
  username,
  adminUser,
  operationId,
  buffer,
  cdnPath,
}) {
  const fileUrl = buildFileUrl(filePath, cdnPath);
  logger.info(`${fileType} already exists (hash: ${hash}) for user ${userId}`);

  // Get file size
  let existingSize = buffer.length;
  if (!filePath.startsWith('http://') && !filePath.startsWith('https://')) {
    try {
      const stats = await fs.stat(filePath);
      existingSize = stats.size;
    } catch {
      logger.debug(`File exists in R2 but not locally, using buffer size: ${existingSize}`);
    }
  }

  // Record in database
  await insertProcessedUrl(urlHash, hash, fileType, ext, fileUrl, Date.now(), userId, existingSize);
  logger.debug(`Recorded processed URL in database (urlHash: ${urlHash.substring(0, 8)}...)`);

  updateOperationStatus(operationId, 'success', { fileSize: existingSize });
  recordRateLimit(userId);

  await safeInteractionEditReply(interaction, {
    content: formatR2UrlWithDisclaimer(fileUrl, r2Config, adminUser),
  });

  await notifyCommandSuccess(username, 'download', { operationId, userId });
}

/**
 * Finalize saving a file and send response
 * @param {Object} params - Parameters
 * @returns {Promise<void>}
 */
async function finalizeSave({
  interaction,
  saveResult,
  fileType,
  hash,
  ext,
  urlHash,
  userId,
  username,
  adminUser,
  operationId,
  cdnPath,
}) {
  const filePath = saveResult.url;
  const finalBuffer = saveResult.buffer;
  const finalUploadMethod = saveResult.method;
  const fileUrl = buildFileUrl(filePath, cdnPath);

  // Get file size
  let finalSize;
  if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
    finalSize = finalBuffer.length;
  } else {
    const finalStats = await fs.stat(filePath);
    finalSize = finalStats.size;
  }

  const finalSizeMB = (finalSize / (1024 * 1024)).toFixed(2);
  logger.info(
    `Successfully saved ${fileType} (hash: ${hash}, size: ${finalSizeMB}MB) for user ${userId}`
  );

  // Record in database
  await insertProcessedUrl(urlHash, hash, fileType, ext, fileUrl, Date.now(), userId, finalSize);
  logger.debug(`Recorded processed URL in database (urlHash: ${urlHash.substring(0, 8)}...)`);

  // Track temporary upload if R2
  if (finalUploadMethod === 'r2' && fileUrl.startsWith('https://')) {
    const r2Key = extractR2KeyFromUrl(fileUrl, r2Config);
    if (r2Key) {
      await trackTemporaryUpload(urlHash, r2Key, null, adminUser);
    }
  }

  updateOperationStatus(operationId, 'success', { fileSize: finalSize });

  // Send response
  if (finalUploadMethod === 'discord') {
    await sendSingleFileToDiscord({
      interaction,
      buffer: finalBuffer,
      hash,
      ext,
      fileType,
      fileUrl,
      urlHash,
      userId,
      username,
      fileSize: finalSize,
      adminUser,
    });
  } else {
    await safeInteractionEditReply(interaction, {
      content: formatR2UrlWithDisclaimer(fileUrl, r2Config, adminUser),
    });
  }

  await notifyCommandSuccess(username, 'download', { operationId, userId });
  recordRateLimit(userId);
}
