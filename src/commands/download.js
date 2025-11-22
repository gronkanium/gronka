import { MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
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
import { createOperation, updateOperationStatus } from '../utils/operations-tracker.js';
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
import { optimizeGif } from '../utils/gif-optimizer.js';
import { queueCobaltRequest, hashUrl } from '../utils/cobalt-queue.js';
import { notifyCommandSuccess, notifyCommandFailure } from '../utils/ntfy-notifier.js';
import { getProcessedUrl, insertProcessedUrl, initDatabase } from '../utils/database.js';

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
 */
async function processDownload(interaction, url) {
  const userId = interaction.user.id;
  const username = interaction.user.tag || interaction.user.username || 'unknown';
  const adminUser = isAdmin(userId);
  const userConfig = await getUserConfig(userId);

  // Create operation tracking
  const operationId = createOperation('download', userId, username);

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

    // Check if URL has already been processed
    const urlHash = hashUrl(url);
    const processedUrl = await getProcessedUrl(urlHash);
    if (processedUrl) {
      logger.info(
        `URL already processed (hash: ${urlHash.substring(0, 8)}...), returning existing file URL: ${processedUrl.file_url}`
      );
      const fileUrl = processedUrl.file_url;
      updateOperationStatus(operationId, 'success', { fileSize: 0 });
      recordRateLimit(userId);
      await interaction.editReply({
        content: fileUrl,
      });
      await notifyCommandSuccess(username, 'download');
      return;
    }

    logger.info(`Downloading file from Cobalt: ${url}`);
    const maxSize = adminUser ? Infinity : MAX_VIDEO_SIZE;

    // Wrap Cobalt download in queue to handle concurrency and deduplication
    let fileData;
    try {
      fileData = await queueCobaltRequest(url, async () => {
        return await downloadFromSocialMedia(COBALT_API_URL, url, adminUser, maxSize);
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
        await notifyCommandSuccess(username, 'download');
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
          filePath = await saveImage(photo.buffer, hash, ext, GIF_STORAGE_PATH, buildMetadata());

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

    // Check if file already exists and get appropriate path
    let exists = false;
    let filePath = null;
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
      await insertProcessedUrl(urlHash, hash, fileType, ext, fileUrl, Date.now(), userId);
      logger.debug(`Recorded processed URL in database (urlHash: ${urlHash.substring(0, 8)}...)`);

      updateOperationStatus(operationId, 'success', { fileSize: existingSize });
      recordRateLimit(userId);
      await interaction.editReply({
        content: fileUrl,
      });

      // Send success notification
      await notifyCommandSuccess(username, 'download');
      return;
    } else {
      // Save file based on type
      if (fileType === 'gif') {
        logger.info(`Saving GIF (hash: ${hash})`);
        filePath = await saveGif(fileData.buffer, hash, GIF_STORAGE_PATH, buildMetadata());

        // Auto-optimize if enabled in user config
        if (userConfig.autoOptimize) {
          const _originalSize = fileData.buffer.length;
          const optimizedHash = crypto.createHash('md5');
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
            }
          }
        }
      } else if (fileType === 'video') {
        logger.info(`Saving video (hash: ${hash}, extension: ${ext})`);
        filePath = await saveVideo(fileData.buffer, hash, ext, GIF_STORAGE_PATH, buildMetadata());
      } else if (fileType === 'image') {
        logger.info(`Saving image (hash: ${hash}, extension: ${ext})`);
        filePath = await saveImage(fileData.buffer, hash, ext, GIF_STORAGE_PATH, buildMetadata());
      }

      // filePath might be a local path or R2 URL
      let fileUrl;
      let finalSize;
      if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
        // Already an R2 URL
        fileUrl = filePath;
        // Get size from buffer since we can't stat R2 files
        finalSize = fileData.buffer.length;
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
      await insertProcessedUrl(urlHash, hash, fileType, ext, fileUrl, Date.now(), userId);
      logger.debug(`Recorded processed URL in database (urlHash: ${urlHash.substring(0, 8)}...)`);

      // Update operation to success with file size
      updateOperationStatus(operationId, 'success', { fileSize: finalSize });

      await interaction.editReply({
        content: fileUrl,
      });

      // Send success notification
      await notifyCommandSuccess(username, 'download');

      // Record rate limit after successful download
      recordRateLimit(userId);
    }
  } catch (error) {
    logger.error(`Download failed for user ${userId}:`, error);

    // Check if this is a rate limit error after retries
    if (error instanceof RateLimitError) {
      logger.warn(`Rate limit error for user ${userId}, showing deferred download option`);

      // Create buttons for user to choose
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`defer_download:${Buffer.from(url).toString('base64')}`)
          .setLabel('try again later')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('cancel_download')
          .setLabel('cancel')
          .setStyle(ButtonStyle.Secondary)
      );

      updateOperationStatus(operationId, 'error', { error: 'rate limited' });

      await interaction.editReply({
        content:
          "download failed due to rate limiting. would you like to try again later? you'll receive a notification when it's ready.",
        components: [row],
      });

      // Send failure notification for rate limit
      await notifyCommandFailure(username, 'download');
      return;
    }

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

    updateOperationStatus(operationId, 'error', { error: errorMessage });
    await interaction.editReply({
      content: errorMessage,
    });

    // Send failure notification
    await notifyCommandFailure(username, 'download');
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
    await notifyCommandFailure(username, 'download');
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
    await notifyCommandFailure(username, 'download');
    return;
  }

  // Check if URL is from social media
  if (!isSocialMediaUrl(url)) {
    await interaction.reply({
      content: 'url is not from a supported social media platform.',
      flags: MessageFlags.Ephemeral,
    });
    await notifyCommandFailure(username, 'download');
    return;
  }

  // Defer reply since downloading may take time
  await interaction.deferReply();

  await processDownload(interaction, url);
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

  if (!url) {
    logger.warn(`No URL provided for user ${userId}`);
    await interaction.reply({
      content: 'please provide a URL to download from.',
      flags: MessageFlags.Ephemeral,
    });
    await notifyCommandFailure(username, 'download');
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
    await notifyCommandFailure(username, 'download');
    return;
  }

  if (!isSocialMediaUrl(url)) {
    await interaction.reply({
      content: 'url is not from a supported social media platform.',
      flags: MessageFlags.Ephemeral,
    });
    await notifyCommandFailure(username, 'download');
    return;
  }

  // Defer reply since downloading may take time
  await interaction.deferReply();

  await processDownload(interaction, url);
}
