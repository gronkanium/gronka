import { MessageFlags } from 'discord.js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from '../utils/logger.js';
import { botConfig } from '../utils/config.js';
import { validateUrl } from '../utils/validation.js';
import { isSocialMediaUrl, downloadFromSocialMedia } from '../utils/cobalt.js';
import { checkRateLimit, isAdmin } from '../utils/rate-limit.js';
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
import { optimizeGif, calculateSizeReduction, formatSizeMb } from '../utils/gif-optimizer.js';

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

    logger.info(`Downloading file from Cobalt: ${url}`);
    const maxSize = adminUser ? Infinity : MAX_VIDEO_SIZE;
    const fileData = await downloadFromSocialMedia(COBALT_API_URL, url, adminUser, maxSize);

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
        const stats = await fs.stat(filePath);
        existingSize = stats.size;
      }
      updateOperationStatus(operationId, 'success', { fileSize: existingSize });
      await interaction.editReply({
        content: `${fileType} already exists : ${fileUrl}`,
      });
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

      // Update operation to success with file size
      updateOperationStatus(operationId, 'success', { fileSize: finalSize });

      let replyContent = `${fileType} downloaded : ${fileUrl}\n-# ${fileType} size: ${finalSizeMB} mb`;

      // Show optimization info if auto-optimized
      if (userConfig.autoOptimize && fileType === 'gif') {
        const originalSize = fileData.buffer.length;
        const reduction = calculateSizeReduction(originalSize, finalSize);
        const reductionText = reduction >= 0 ? `-${reduction}%` : `+${Math.abs(reduction)}%`;
        replyContent = `${fileType} downloaded : ${fileUrl}\n-# ${fileType} size: ${formatSizeMb(finalSize)} (${reductionText})`;
      }

      await interaction.editReply({
        content: replyContent,
      });
    }
  } catch (error) {
    logger.error(`Download failed for user ${userId}:`, error);

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
    return;
  }

  // Check if URL is from social media
  if (!isSocialMediaUrl(url)) {
    await interaction.reply({
      content: 'url is not from a supported social media platform.',
      flags: MessageFlags.Ephemeral,
    });
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
    return;
  }

  if (!isSocialMediaUrl(url)) {
    await interaction.reply({
      content: 'url is not from a supported social media platform.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Defer reply since downloading may take time
  await interaction.deferReply();

  await processDownload(interaction, url);
}
