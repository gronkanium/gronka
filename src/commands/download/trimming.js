/**
 * Video and GIF trimming utilities for download command
 */
import fs from 'fs/promises';
import path from 'path';
import tmp from 'tmp';
import { createLogger } from '../../utils/logger.js';
import { generateHash } from '../../utils/file-downloader.js';
import { trimVideo, trimGif } from '../../utils/video-processor.js';
import { gifExists, getGifPath, videoExists, getVideoPath } from '../../utils/storage.js';
import { logOperationStep } from '../../utils/operations-tracker.js';
import { cleanupTempFiles } from './utils.js';

const logger = createLogger('download:trim');

/**
 * Trim a GIF file
 * @param {Object} params - Parameters object
 * @param {Buffer} params.buffer - Original GIF buffer
 * @param {string} params.hash - Original file hash
 * @param {string} params.ext - File extension
 * @param {number|null} params.startTime - Start time in seconds
 * @param {number|null} params.duration - Duration in seconds
 * @param {string} params.storagePath - Storage path for checking existing files
 * @param {string} params.operationId - Operation ID for logging
 * @param {string} params.userId - User ID for logging
 * @returns {Promise<{buffer: Buffer, hash: string, exists: boolean, filePath: string|null}>}
 */
export async function trimGifFile({
  buffer,
  hash,
  ext,
  startTime,
  duration,
  storagePath,
  operationId,
  userId,
}) {
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
    await fs.writeFile(inputGifPath, buffer);
    await trimGif(inputGifPath, outputGifPath, { startTime, duration });

    const trimmedBuffer = await fs.readFile(outputGifPath);
    const trimmedHash = generateHash(trimmedBuffer);

    // Check if trimmed GIF already exists
    const trimmedExists = await gifExists(trimmedHash, storagePath);
    let filePath = null;

    if (trimmedExists) {
      filePath = getGifPath(trimmedHash, storagePath);
      logger.info(
        `Trimmed GIF already exists (hash: ${trimmedHash}) for user ${userId} with requested parameters (startTime: ${startTime}, duration: ${duration})`
      );
    }

    logOperationStep(operationId, 'gif_trim', 'success', {
      message: 'GIF trimmed successfully',
      metadata: {
        startTime,
        duration,
        originalSize: buffer.length,
        trimmedSize: trimmedBuffer.length,
        alreadyExists: trimmedExists,
      },
    });

    await cleanupTempFiles(tmpDir, [inputGifPath, outputGifPath]);

    return {
      buffer: trimmedBuffer,
      hash: trimmedHash,
      exists: trimmedExists,
      filePath,
    };
  } catch (trimError) {
    logOperationStep(operationId, 'gif_trim', 'error', {
      message: 'GIF trimming failed',
      metadata: { error: trimError.message },
    });
    logger.error(`GIF trimming failed: ${trimError.message}`);
    logger.info(`Falling back to saving original GIF without trimming`);

    await cleanupTempFiles(tmpDir, [inputGifPath, outputGifPath]);

    return {
      buffer,
      hash,
      exists: false,
      filePath: null,
    };
  }
}

/**
 * Trim a video file
 * @param {Object} params - Parameters object
 * @param {Buffer} params.buffer - Original video buffer
 * @param {string} params.hash - Original file hash
 * @param {string} params.ext - File extension
 * @param {number|null} params.startTime - Start time in seconds
 * @param {number|null} params.duration - Duration in seconds
 * @param {string} params.storagePath - Storage path for checking existing files
 * @param {string} params.operationId - Operation ID for logging
 * @param {string} params.userId - User ID for logging
 * @returns {Promise<{buffer: Buffer, hash: string, exists: boolean, filePath: string|null, ext: string}>}
 */
export async function trimVideoFile({
  buffer,
  hash,
  ext,
  startTime,
  duration,
  storagePath,
  operationId,
  userId,
}) {
  logger.info(
    `Trimming video (hash: ${hash}, extension: ${ext}, startTime: ${startTime}, duration: ${duration})`
  );
  logOperationStep(operationId, 'video_trim', 'running', {
    message: 'Trimming video',
    metadata: { startTime, duration },
  });

  const tmpDir = tmp.dirSync({ unsafeCleanup: true });
  const inputVideoPath = path.join(tmpDir.name, `input${ext}`);
  const outputVideoPath = path.join(tmpDir.name, 'output.mp4');

  try {
    await fs.writeFile(inputVideoPath, buffer);
    await trimVideo(inputVideoPath, outputVideoPath, { startTime, duration });

    const trimmedBuffer = await fs.readFile(outputVideoPath);
    const trimmedHash = generateHash(trimmedBuffer);

    // Check if trimmed video already exists (always .mp4 output)
    const videoExt = '.mp4';
    const trimmedExists = await videoExists(trimmedHash, videoExt, storagePath);
    let filePath = null;

    if (trimmedExists) {
      filePath = getVideoPath(trimmedHash, videoExt, storagePath);
      logger.info(
        `Trimmed video already exists (hash: ${trimmedHash}) for user ${userId} with requested parameters (startTime: ${startTime}, duration: ${duration})`
      );
    }

    logOperationStep(operationId, 'video_trim', 'success', {
      message: 'Video trimmed successfully',
      metadata: {
        startTime,
        duration,
        originalSize: buffer.length,
        trimmedSize: trimmedBuffer.length,
        alreadyExists: trimmedExists,
      },
    });

    await cleanupTempFiles(tmpDir, [inputVideoPath, outputVideoPath]);

    return {
      buffer: trimmedBuffer,
      hash: trimmedHash,
      exists: trimmedExists,
      filePath,
      ext: videoExt,
    };
  } catch (trimError) {
    logOperationStep(operationId, 'video_trim', 'error', {
      message: 'Video trimming failed',
      metadata: { error: trimError.message },
    });
    logger.error(`Video trimming failed: ${trimError.message}`);
    logger.info(`Falling back to saving original video without trimming`);

    await cleanupTempFiles(tmpDir, [inputVideoPath, outputVideoPath]);

    return {
      buffer,
      hash,
      exists: false,
      filePath: null,
      ext,
    };
  }
}

/**
 * Trim a video file that has .gif extension (outputs as GIF)
 * @param {Object} params - Parameters object
 * @returns {Promise<{buffer: Buffer, hash: string, exists: boolean, filePath: string|null, treatAsGif: boolean}>}
 */
export async function trimVideoAsGif({
  buffer,
  hash,
  ext,
  startTime,
  duration,
  storagePath,
  operationId,
  userId,
}) {
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
    await fs.writeFile(inputGifPath, buffer);
    await trimGif(inputGifPath, outputGifPath, { startTime, duration });

    const trimmedBuffer = await fs.readFile(outputGifPath);
    const trimmedHash = generateHash(trimmedBuffer);

    const trimmedExists = await gifExists(trimmedHash, storagePath);
    let filePath = null;

    if (trimmedExists) {
      filePath = getGifPath(trimmedHash, storagePath);
      logger.info(
        `Trimmed GIF already exists (hash: ${trimmedHash}) for user ${userId} with requested parameters (startTime: ${startTime}, duration: ${duration})`
      );
    }

    logOperationStep(operationId, 'gif_trim', 'success', {
      message: 'GIF trimmed successfully (from video source)',
      metadata: {
        startTime,
        duration,
        originalSize: buffer.length,
        trimmedSize: trimmedBuffer.length,
        alreadyExists: trimmedExists,
      },
    });

    await cleanupTempFiles(tmpDir, [inputGifPath, outputGifPath]);

    return {
      buffer: trimmedBuffer,
      hash: trimmedHash,
      exists: trimmedExists,
      filePath,
      treatAsGif: true,
    };
  } catch (trimError) {
    logOperationStep(operationId, 'gif_trim', 'error', {
      message: 'GIF trimming failed',
      metadata: { error: trimError.message },
    });
    logger.error(`GIF trimming failed: ${trimError.message}`);
    logger.info(`Falling back to saving original file without trimming`);

    await cleanupTempFiles(tmpDir, [inputGifPath, outputGifPath]);

    return {
      buffer,
      hash,
      exists: false,
      filePath: null,
      treatAsGif: false,
    };
  }
}

/**
 * Check if trimming is needed based on parameters and file type
 * @param {string} fileType - File type ('gif', 'video', 'image')
 * @param {number|null} startTime - Start time
 * @param {number|null} duration - Duration
 * @param {string} downloadMethod - Download method ('ytdlp' or 'cobalt')
 * @returns {boolean} Whether trimming is needed
 */
export function needsTrimming(fileType, startTime, duration, downloadMethod) {
  // yt-dlp already trims using --download-sections
  const alreadyTrimmedByYtdlp =
    downloadMethod === 'ytdlp' && (startTime !== null || duration !== null);

  return (
    (fileType === 'video' || fileType === 'gif') &&
    (startTime !== null || duration !== null) &&
    !alreadyTrimmedByYtdlp
  );
}
