import { MessageFlags, AttachmentBuilder } from 'discord.js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from '../utils/logger.js';
import { botConfig } from '../utils/config.js';
import { validateUrl } from '../utils/validation.js';
import { isSocialMediaUrl, downloadFromSocialMedia, RateLimitError } from '../utils/cobalt.js';
import { checkRateLimit, isAdmin, recordRateLimit } from '../utils/rate-limit.js';
import { getUserConfig } from '../utils/user-config.js';
import { generateHash } from '../utils/file-downloader.js';
import {
  createOperation,
  updateOperationStatus,
  logOperationStep,
  logOperationError,
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
  shouldUploadToDiscord,
} from '../utils/storage.js';
import { uploadGifToR2, uploadVideoToR2, uploadImageToR2 } from '../utils/r2-storage.js';
import { optimizeGif } from '../utils/gif-optimizer.js';
import { queueCobaltRequest, hashUrl } from '../utils/cobalt-queue.js';
import { notifyCommandSuccess, notifyCommandFailure } from '../utils/ntfy-notifier.js';
import { getProcessedUrl, insertProcessedUrl, initDatabase } from '../utils/database.js';
import { r2Config } from '../utils/config.js';
import { trimVideo } from '../utils/video-processor.js';
import tmp from 'tmp';

const logger = createLogger('download');

const {
  gifStoragePath: GIF_STORAGE_PATH,
  cdnBaseUrl: CDN_BASE_URL,
  maxVideoSize: MAX_VIDEO_SIZE,
  cobaltApiUrl: COBALT_API_URL,
  cobaltEnabled: COBALT_ENABLED,
} = botConfig;

/**
 * Check if a URL is from YouTube
 * @param {string} url - URL to check
 * @returns {boolean} True if URL is from YouTube
 */
function isYouTubeUrl(url) {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase().replace(/^www\./, '');
    return (
      hostname === 'youtube.com' ||
      hostname === 'youtu.be' ||
      hostname === 'm.youtube.com' ||
      hostname.endsWith('.youtube.com')
    );
  } catch {
    return false;
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
  const userId = interaction.user.id;
  const username = interaction.user.tag || interaction.user.username || 'unknown';
  const adminUser = isAdmin(userId);
  const userConfig = await getUserConfig(userId);

  // Build operation context
  const operationContext = {
    originalUrl: url,
  };
  if (commandSource) {
    operationContext.commandSource = commandSource;
  }

  // Create operation tracking with context
  const operationId = createOperation('download', userId, username, operationContext);

  // Build metadata object for R2 uploads
  const buildMetadata = () => ({
    'user-id': userId,
    'upload-timestamp': new Date().toISOString(),
    'operation-type': 'download',
    username: username,
  });

  try {
    // Update operation to running
    updateOperationStatus(operationId, 'running');

    // Initialize database if needed
    await initDatabase();

    logOperationStep(operationId, 'url_validation', 'running', {
      message: 'Validating URL',
      metadata: { url },
    });

    // Check if URL has already been processed
    // Skip URL cache if time parameters are provided (trimmed videos are different from untrimmed, crazy right?)
    const urlHash = hashUrl(url);
    let processedUrl = null;
    if (startTime === null && duration === null) {
      processedUrl = await getProcessedUrl(urlHash);
      if (processedUrl) {
        logger.info(
          `URL already processed (hash: ${urlHash.substring(0, 8)}...), returning existing file URL: ${processedUrl.file_url}`
        );
        logOperationStep(operationId, 'url_validation', 'success', {
          message: 'URL validation complete',
          metadata: { url },
        });
        logOperationStep(operationId, 'url_cache_hit', 'success', {
          message: 'URL already processed, returning cached result',
          metadata: { url, cachedUrl: processedUrl.file_url },
        });
        const fileUrl = processedUrl.file_url;
        updateOperationStatus(operationId, 'success', { fileSize: 0 });
        recordRateLimit(userId);
        await interaction.editReply({
          content: fileUrl,
        });
        await notifyCommandSuccess(username, 'download', { operationId, userId });
        return;
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

    logger.info(`Downloading file from Cobalt: ${url}`);
    logOperationStep(operationId, 'download_start', 'running', {
      message: 'Starting download from Cobalt',
      metadata: { url, maxSize: adminUser ? 'unlimited' : MAX_VIDEO_SIZE },
    });

    const maxSize = adminUser ? Infinity : MAX_VIDEO_SIZE;

    // Wrap Cobalt download in queue to handle concurrency and deduplication
    let fileData;
    try {
      fileData = await queueCobaltRequest(url, async () => {
        return await downloadFromSocialMedia(COBALT_API_URL, url, adminUser, maxSize);
      });
      logOperationStep(operationId, 'download_complete', 'success', {
        message: 'File downloaded successfully',
        metadata: {
          url,
          fileCount: Array.isArray(fileData) ? fileData.length : 1,
        },
      });
    } catch (error) {
      // Handle cached URL error
      if (error.message && error.message.startsWith('URL_ALREADY_PROCESSED:')) {
        const fileUrl = error.message.split(':')[1];
        updateOperationStatus(operationId, 'success', { fileSize: 0 });
        recordRateLimit(userId);
        await interaction.editReply({
          content: fileUrl,
        });
        await notifyCommandSuccess(username, 'download', { operationId, userId });
        return;
      }
      throw error;
    }

    // Check if we got multiple photos (array) or single file
    if (Array.isArray(fileData)) {
      // Handle multiple photos from picker
      logger.info(`Processing ${fileData.length} photos from picker`);
      const photoResults = [];
      let totalSize = 0;

      for (let i = 0; i < fileData.length; i++) {
        const photo = fileData[i];
        const hash = generateHash(photo.buffer);
        const ext = path.extname(photo.filename).toLowerCase() || '.jpg';
        const _fileType = detectFileType(ext, photo.contentType);

        // Check if photo already exists
        const exists = await imageExists(hash, ext, GIF_STORAGE_PATH);
        let filePath;
        let fileUrl;

        if (exists) {
          filePath = getImagePath(hash, ext, GIF_STORAGE_PATH);
          if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
            fileUrl = filePath;
          } else {
            const filename = path.basename(filePath);
            fileUrl = `${CDN_BASE_URL.replace('/gifs', '/images')}/${filename}`;
          }
          logger.info(`Photo ${i + 1} already exists (hash: ${hash})`);
        } else {
          // Save the photo
          logger.info(`Saving photo ${i + 1} (hash: ${hash}, extension: ${ext})`);
          const saveResult = await saveImage(
            photo.buffer,
            hash,
            ext,
            GIF_STORAGE_PATH,
            buildMetadata()
          );
          filePath = saveResult.url;

          if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
            fileUrl = filePath;
          } else {
            const filename = path.basename(filePath);
            fileUrl = `${CDN_BASE_URL.replace('/gifs', '/images')}/${filename}`;
          }
          logger.info(`Successfully saved photo ${i + 1} (hash: ${hash})`);
        }

        photoResults.push({ url: fileUrl, size: photo.size });
        totalSize += photo.size;
      }

      // Update operation to success
      updateOperationStatus(operationId, 'success', {
        fileSize: totalSize,
        photoCount: photoResults.length,
      });

      // Build reply with all photo URLs
      const photoUrls = photoResults.map(p => p.url).join('\n');
      const replyContent = photoUrls;

      // Note: For multiple photos, we don't record the URL in processed_urls
      // because each photo has its own URL, and we can't track which photo came from which picker selection
      // The file hash deduplication handles this case

      recordRateLimit(userId);
      await interaction.editReply({
        content: replyContent,
      });
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

    // Check if video trimming is requested
    // If so, skip checking for original file existence (we need the trimmed version)
    const needsTrimming = fileType === 'video' && (startTime !== null || duration !== null);

    // Check if file already exists and get appropriate path
    // Skip this check if trimming is needed (we'll check for trimmed file later)
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
      await insertProcessedUrl(
        urlHash,
        hash,
        fileType,
        ext,
        fileUrl,
        Date.now(),
        userId,
        existingSize
      );
      logger.debug(`Recorded processed URL in database (urlHash: ${urlHash.substring(0, 8)}...)`);

      updateOperationStatus(operationId, 'success', { fileSize: existingSize });
      recordRateLimit(userId);
      await interaction.editReply({
        content: fileUrl,
      });

      // Send success notification
      await notifyCommandSuccess(username, 'download', { operationId, userId });
      return;
    } else {
      // Save file based on type
      let finalBuffer = fileData.buffer;
      let finalUploadMethod = 'r2';
      if (fileType === 'gif') {
        logger.info(`Saving GIF (hash: ${hash})`);
        const saveResult = await saveGif(fileData.buffer, hash, GIF_STORAGE_PATH, buildMetadata());
        filePath = saveResult.url;
        finalBuffer = saveResult.buffer;
        finalUploadMethod = saveResult.method;

        // Auto-optimize if enabled in user config
        if (userConfig.autoOptimize) {
          const _originalSize = fileData.buffer.length;
          const optimizedHash = crypto.createHash('sha256');
          optimizedHash.update(fileData.buffer);
          optimizedHash.update('optimized');
          optimizedHash.update('35'); // Default lossy level
          const optimizedHashValue = optimizedHash.digest('hex');
          const optimizedGifPath = getGifPath(optimizedHashValue, GIF_STORAGE_PATH);

          // Check if optimized GIF already exists
          const optimizedExists = await gifExists(optimizedHashValue, GIF_STORAGE_PATH);
          if (optimizedExists) {
            logger.info(
              `Auto-optimized GIF already exists (hash: ${optimizedHashValue}) for user ${userId}`
            );
            filePath = optimizedGifPath;
            hash = optimizedHashValue;
            cdnPath = '/gifs';
            // Read optimized buffer and re-check upload method
            finalBuffer = await fs.readFile(optimizedGifPath);
            finalUploadMethod = shouldUploadToDiscord(finalBuffer) ? 'discord' : 'r2';
          } else {
            // Check if filePath is a URL (R2-stored files return URLs, not local paths)
            if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
              logger.warn(
                `Auto-optimization skipped: GIF is stored in R2 (URL: ${filePath}). File must be available locally for optimization. User can manually optimize later if needed.`
              );
            } else {
              // Auto-optimize the GIF with default lossy level
              logger.info(
                `Auto-optimizing downloaded GIF: ${filePath} -> ${optimizedGifPath} (lossy: 35)`
              );
              await optimizeGif(filePath, optimizedGifPath, { lossy: 35 });
              filePath = optimizedGifPath;
              hash = optimizedHashValue;
              cdnPath = '/gifs';
              // Read optimized buffer and re-check upload method
              finalBuffer = await fs.readFile(optimizedGifPath);
              finalUploadMethod = shouldUploadToDiscord(finalBuffer) ? 'discord' : 'r2';
            }
          }
        }
      } else if (fileType === 'video') {
        // Check if video trimming is requested
        if (startTime !== null || duration !== null) {
          logger.info(
            `Trimming video (hash: ${hash}, extension: ${ext}, startTime: ${startTime}, duration: ${duration})`
          );
          logOperationStep(operationId, 'video_trim', 'running', {
            message: 'Trimming video',
            metadata: { startTime, duration },
          });

          // Create temporary files for input and output
          const tmpDir = tmp.dirSync({ unsafeCleanup: true });
          const inputVideoPath = path.join(tmpDir.name, `input${ext}`);
          const outputVideoPath = path.join(tmpDir.name, `output${ext}`);

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

            // Check if trimmed video already exists
            // This checks if we've previously created a video with this exact content (hash).
            // If the user requested different trim parameters, the hash will be different,
            // so we won't return the wrong cached version.
            const trimmedExists = await videoExists(hash, ext, GIF_STORAGE_PATH);
            if (trimmedExists) {
              filePath = getVideoPath(hash, ext, GIF_STORAGE_PATH);
              exists = true;
              logger.info(
                `Trimmed video already exists (hash: ${hash}) for user ${userId} with requested parameters (startTime: ${startTime}, duration: ${duration})`
              );
              // Clean up temp files since we're using existing file
              try {
                await fs.unlink(inputVideoPath);
                await fs.unlink(outputVideoPath);
                tmpDir.removeCallback();
              } catch (cleanupError) {
                logger.warn(`Failed to clean up temp files: ${cleanupError.message}`);
              }
            } else {
              // Use trimmed buffer for saving
              finalBuffer = trimmedBuffer;
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
            try {
              await fs.unlink(inputVideoPath);
              await fs.unlink(outputVideoPath);
              tmpDir.removeCallback();
            } catch (cleanupError) {
              logger.warn(`Failed to clean up temp files: ${cleanupError.message}`);
            }
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
            try {
              await fs.unlink(inputVideoPath).catch(() => {});
              await fs.unlink(outputVideoPath).catch(() => {});
              tmpDir.removeCallback();
            } catch {
              // Ignore cleanup errors
            }
          }
        } else {
          finalBuffer = fileData.buffer;
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
              logger.debug(`File exists in R2 but not locally, using buffer size: ${existingSize}`);
            }
          }

          // Record processed URL in database (file exists but URL might not be recorded yet)
          await insertProcessedUrl(
            urlHash,
            hash,
            fileType,
            ext,
            fileUrl,
            Date.now(),
            userId,
            existingSize
          );
          logger.debug(
            `Recorded processed URL in database (urlHash: ${urlHash.substring(0, 8)}...)`
          );

          updateOperationStatus(operationId, 'success', { fileSize: existingSize });
          recordRateLimit(userId);
          await interaction.editReply({
            content: fileUrl,
          });

          // Send success notification
          await notifyCommandSuccess(username, 'download', { operationId, userId });
          return;
        }

        logger.info(`Saving video (hash: ${hash}, extension: ${ext})`);
        const saveResult = await saveVideo(
          finalBuffer,
          hash,
          ext,
          GIF_STORAGE_PATH,
          buildMetadata()
        );
        filePath = saveResult.url;
        finalBuffer = saveResult.buffer;
        finalUploadMethod = saveResult.method;
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
        `Successfully saved ${fileType} (hash: ${hash}, size: ${finalSizeMB}MB) for user ${userId}${userConfig.autoOptimize && fileType === 'gif' ? ' [AUTO-OPTIMIZED]' : ''}`
      );

      // Record processed URL in database
      await insertProcessedUrl(
        urlHash,
        hash,
        fileType,
        ext,
        fileUrl,
        Date.now(),
        userId,
        finalSize
      );
      logger.debug(`Recorded processed URL in database (urlHash: ${urlHash.substring(0, 8)}...)`);

      // Update operation to success with file size
      updateOperationStatus(operationId, 'success', { fileSize: finalSize });

      // Send as Discord attachment if < 8MB, otherwise send URL
      if (finalUploadMethod === 'discord') {
        const safeHash = hash.replace(/[^a-f0-9]/gi, '');
        const filename = `${safeHash}${ext}`;
        try {
          const message = await interaction.editReply({
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
            await insertProcessedUrl(
              urlHash,
              hash,
              fileType,
              ext,
              discordUrl,
              Date.now(),
              userId,
              finalSize
            );
            logger.debug(
              `Updated processed URL in database with Discord URL (urlHash: ${urlHash.substring(0, 8)}...)`
            );
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
              r2Url = await uploadVideoToR2(finalBuffer, hash, ext, r2Config, buildMetadata());
            } else if (fileType === 'image') {
              r2Url = await uploadImageToR2(finalBuffer, hash, ext, r2Config, buildMetadata());
            }

            if (r2Url) {
              // Update database with R2 URL
              await insertProcessedUrl(
                urlHash,
                hash,
                fileType,
                ext,
                r2Url,
                Date.now(),
                userId,
                finalSize
              );
              await interaction.editReply({
                content: r2Url,
              });
            } else {
              // If R2 upload also fails, use the original fileUrl
              await interaction.editReply({
                content: fileUrl,
              });
            }
          } catch (r2Error) {
            logger.error(`R2 fallback upload also failed: ${r2Error.message}`);
            // Last resort: use the original fileUrl
            await interaction.editReply({
              content: fileUrl,
            });
          }
        }
      } else {
        await interaction.editReply({
          content: fileUrl,
        });
      }

      // Send success notification
      await notifyCommandSuccess(username, 'download', { operationId, userId });

      // Record rate limit after successful download
      recordRateLimit(userId);
    }
  } catch (error) {
    logger.error(`Download failed for user ${userId}:`, error);

    // Build comprehensive error metadata
    const errorMetadata = {
      originalUrl: url,
      errorMessage: error.message || 'unknown error',
      errorName: error.name || 'Error',
      errorCode: error.code || null,
      isRateLimit: error instanceof RateLimitError,
    };

    // Safely extract error message, handling cases where it might be an object or undefined
    let errorMessage = 'an error occurred while downloading the file.';
    if (error) {
      if (typeof error.message === 'string' && error.message) {
        errorMessage = error.message;
      } else if (typeof error === 'string') {
        errorMessage = error;
      } else if (error.response?.data) {
        // Try to extract message from axios error response
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

    logOperationError(operationId, error, {
      metadata: errorMetadata,
    });

    updateOperationStatus(operationId, 'error', {
      error: errorMessage,
      stackTrace: error.stack || null,
    });
    await interaction.editReply({
      content: errorMessage,
    });

    // Send failure notification
    await notifyCommandFailure(username, 'download', { operationId, userId, error: errorMessage });
  }
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

  // Check rate limit (admins bypass this check)
  if (checkRateLimit(userId)) {
    logger.warn(`User ${userId} (${interaction.user.tag}) is rate limited`);
    await interaction.reply({
      content: 'please wait 30 seconds before downloading another video.',
      flags: MessageFlags.Ephemeral,
    });
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
    await interaction.reply({
      content: 'no URL found in this message.',
      flags: MessageFlags.Ephemeral,
    });
    await notifyCommandFailure(username, 'download', {
      userId,
      error: 'no URL found in this message',
    });
    return;
  }

  // Validate URL format
  const urlValidation = validateUrl(url);
  if (!urlValidation.valid) {
    logger.warn(`Invalid URL for user ${userId}: ${urlValidation.error}`);
    await interaction.reply({
      content: `invalid URL: ${urlValidation.error}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Check if URL is from YouTube (blacklisted)
  if (isYouTubeUrl(url)) {
    logger.warn(`User ${userId} attempted to download from YouTube (blacklisted)`);
    await interaction.reply({
      content: 'youtube downloads are disabled.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Check if Cobalt is enabled
  if (!COBALT_ENABLED) {
    await interaction.reply({
      content: 'cobalt is not enabled.',
      flags: MessageFlags.Ephemeral,
    });
    await notifyCommandFailure(username, 'download', { userId, error: 'cobalt is not enabled' });
    return;
  }

  // Check if URL is from social media
  if (!isSocialMediaUrl(url)) {
    await interaction.reply({
      content: 'url is not from a supported social media platform.',
      flags: MessageFlags.Ephemeral,
    });
    await notifyCommandFailure(username, 'download', {
      userId,
      error: 'url is not from a supported social media platform',
    });
    return;
  }

  // Defer reply since downloading may take time
  await interaction.deferReply();

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

  // Check rate limit (admins bypass this check)
  if (checkRateLimit(userId)) {
    logger.warn(`User ${userId} (${interaction.user.tag}) is rate limited`);
    await interaction.reply({
      content: 'please wait 30 seconds before downloading another video.',
      flags: MessageFlags.Ephemeral,
    });
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
      await interaction.reply({
        content: 'end_time must be greater than start_time.',
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
    await interaction.reply({
      content: 'please provide a URL to download from.',
      flags: MessageFlags.Ephemeral,
    });
    await notifyCommandFailure(username, 'download', { userId, error: 'no URL provided' });
    return;
  }

  // Validate URL format
  const urlValidation = validateUrl(url);
  if (!urlValidation.valid) {
    logger.warn(`Invalid URL for user ${userId}: ${urlValidation.error}`);
    await interaction.reply({
      content: `invalid URL: ${urlValidation.error}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Check if URL is from YouTube (blacklisted)
  if (isYouTubeUrl(url)) {
    logger.warn(`User ${userId} attempted to download from YouTube (blacklisted)`);
    await interaction.reply({
      content: 'youtube downloads are disabled.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Check if Cobalt is enabled and URL is from social media
  if (!COBALT_ENABLED) {
    await interaction.reply({
      content: 'cobalt is not enabled. please enable it to use the download command.',
      flags: MessageFlags.Ephemeral,
    });
    await notifyCommandFailure(username, 'download', { userId, error: 'cobalt is not enabled' });
    return;
  }

  if (!isSocialMediaUrl(url)) {
    await interaction.reply({
      content: 'url is not from a supported social media platform.',
      flags: MessageFlags.Ephemeral,
    });
    await notifyCommandFailure(username, 'download', {
      userId,
      error: 'url is not from a supported social media platform',
    });
    return;
  }

  // Defer reply since downloading may take time
  await interaction.deferReply();

  await processDownload(interaction, url, 'slash', trimStartTime, trimDuration);
}
