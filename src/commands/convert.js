import { MessageFlags } from 'discord.js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from '../utils/logger.js';
import { botConfig } from '../utils/config.js';
import { validateUrl, validateFileExtension } from '../utils/validation.js';
import {
  downloadVideo,
  downloadImage,
  downloadFileFromUrl,
  parseTenorUrl,
  generateHash,
} from '../utils/file-downloader.js';
import { checkRateLimit, isAdmin, recordRateLimit } from '../utils/rate-limit.js';
import {
  ALLOWED_VIDEO_TYPES,
  ALLOWED_IMAGE_TYPES,
  validateVideoAttachment,
  validateImageAttachment,
} from '../utils/attachment-helpers.js';
import { convertToGif, getVideoMetadata, convertImageToGif } from '../utils/video-processor.js';
import { gifExists, getGifPath, cleanupTempFiles, saveGif } from '../utils/storage.js';
import { getUserConfig } from '../utils/user-config.js';
import { trackRecentConversion } from '../utils/user-tracking.js';
import { optimizeGif } from '../utils/gif-optimizer.js';
import { createOperation, updateOperationStatus } from '../utils/operations-tracker.js';
import { notifyCommandSuccess, notifyCommandFailure } from '../utils/ntfy-notifier.js';

const logger = createLogger('convert');

const {
  gifStoragePath: GIF_STORAGE_PATH,
  cdnBaseUrl: CDN_BASE_URL,
  maxGifWidth: MAX_GIF_WIDTH,
  maxGifDuration: MAX_GIF_DURATION,
  defaultFps: DEFAULT_FPS,
} = botConfig;

/**
 * Process conversion from attachment to GIF
 * @param {Interaction} interaction - Discord interaction
 * @param {Attachment} attachment - Discord attachment to convert
 * @param {string} attachmentType - Type of attachment ('video' or 'image')
 * @param {boolean} adminUser - Whether the user is an admin
 * @param {Buffer} [preDownloadedBuffer] - Optional pre-downloaded buffer (to avoid double download)
 * @param {Object} [options] - Optional conversion options (startTime, duration, width, fps, quality)
 */
export async function processConversion(
  interaction,
  attachment,
  attachmentType,
  adminUser,
  preDownloadedBuffer = null,
  options = {}
) {
  const userId = interaction.user.id;
  const username = interaction.user.tag || interaction.user.username || 'unknown';
  const tempFiles = [];

  // Create operation tracking
  const operationId = createOperation('convert', userId, username);

  // Build metadata object for R2 uploads
  const buildMetadata = () => ({
    'user-id': userId,
    'upload-timestamp': new Date().toISOString(),
    'operation-type': 'convert',
    username: username,
  });

  // Load user config
  const userConfig = await getUserConfig(userId);

  try {
    // Download file (video or image) if not already downloaded
    // Admins bypass size limits in download
    const fileBuffer =
      preDownloadedBuffer ||
      (attachmentType === 'video'
        ? await downloadVideo(attachment.url, adminUser)
        : await downloadImage(attachment.url, adminUser));

    // Generate hash
    const hash = generateHash(fileBuffer);

    // Update operation to running
    updateOperationStatus(operationId, 'running');

    // Check if GIF already exists
    const exists = await gifExists(hash, GIF_STORAGE_PATH);
    if (exists && !options.optimize) {
      logger.info(`GIF already exists (hash: ${hash}) for user ${userId}`);
      // Get file size for existing GIF
      const gifPath = getGifPath(hash, GIF_STORAGE_PATH);
      let gifUrl;
      let fileSize = 0;
      if (gifPath.startsWith('http://') || gifPath.startsWith('https://')) {
        // Already an R2 URL
        gifUrl = gifPath;
        // Can't stat R2 URLs, use 0 as placeholder
        fileSize = 0;
      } else {
        // Local path, construct URL
        gifUrl = `${CDN_BASE_URL}/${hash}.gif`;
        const stats = await fs.stat(gifPath);
        fileSize = stats.size;
      }
      updateOperationStatus(operationId, 'success', { fileSize });
      recordRateLimit(userId);
      await interaction.editReply({
        content: gifUrl,
      });
      return;
    }

    // If optimization is requested and original GIF exists, we'll optimize it directly
    // Otherwise, we need to convert first
    const needsConversion = !exists;
    logger.info(
      `Starting ${attachmentType} to GIF conversion (hash: ${hash})${options.optimize ? ' with optimization' : ''}${exists ? ' (original GIF exists, will optimize)' : ''}`
    );

    // Validate file extension
    const allowedVideoExtensions = ['.mp4', '.mov', '.webm', '.avi', '.mkv'];
    const allowedImageExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
    const allowedExtensions =
      attachmentType === 'video' ? allowedVideoExtensions : allowedImageExtensions;

    let ext = path.extname(attachment.name).toLowerCase();
    if (!ext || !validateFileExtension(attachment.name, allowedExtensions)) {
      // If extension is invalid or missing, use default based on type
      ext = attachmentType === 'video' ? '.mp4' : '.png';
      logger.warn(
        `Invalid or missing file extension for ${attachment.name}, using default: ${ext}`
      );
    }

    // Save file to temp directory
    const tempDir = path.join(process.cwd(), 'temp');
    await fs.mkdir(tempDir, { recursive: true });

    const filePrefix = attachmentType === 'video' ? 'video' : 'image';
    const tempFilePath = path.join(tempDir, `${filePrefix}_${Date.now()}${ext}`);
    await fs.writeFile(tempFilePath, fileBuffer);
    tempFiles.push(tempFilePath);

    // Get video duration to check limits (only for videos, admins bypass this)
    if (attachmentType === 'video' && !adminUser) {
      try {
        const metadata = await getVideoMetadata(tempFilePath);
        const duration = metadata.format.duration;

        if (duration > MAX_GIF_DURATION) {
          await interaction.editReply({
            content: `video is too long (${Math.ceil(duration)}s). maximum duration: ${MAX_GIF_DURATION}s`,
          });
          return;
        }
      } catch (error) {
        logger.warn('Failed to get video metadata:', error.message);
        // Continue anyway
      }
    } else if (attachmentType === 'video' && adminUser) {
      try {
        const metadata = await getVideoMetadata(tempFilePath);
        const duration = metadata.format.duration;
        if (duration > MAX_GIF_DURATION) {
          logger.info(
            `Video duration limit bypassed for admin (${Math.ceil(duration)}s > ${MAX_GIF_DURATION}s)`
          );
        }
      } catch {
        // Ignore metadata errors for admin bypass logging
      }
    }

    // Convert to GIF
    const gifPath = getGifPath(hash, GIF_STORAGE_PATH);

    // Only convert if the GIF doesn't already exist
    if (needsConversion) {
      if (attachmentType === 'video') {
        // Build conversion options, using provided options, user config, or defaults
        const conversionOptions = {
          width:
            options.width ??
            (userConfig.width !== null ? userConfig.width : Math.min(MAX_GIF_WIDTH, 480)),
          fps: options.fps ?? (userConfig.fps !== null ? userConfig.fps : DEFAULT_FPS),
          quality: options.quality ?? (userConfig.quality !== null ? userConfig.quality : 'medium'),
          startTime: options.startTime ?? null,
          duration: options.duration ?? null,
        };

        // Validate duration against video length if startTime and duration are provided
        if (conversionOptions.startTime !== null && conversionOptions.duration !== null) {
          try {
            const metadata = await getVideoMetadata(tempFilePath);
            const videoDuration = metadata.format.duration;
            const requestedEnd = conversionOptions.startTime + conversionOptions.duration;

            if (requestedEnd > videoDuration) {
              await interaction.editReply({
                content: `requested timeframe (${conversionOptions.startTime}s to ${requestedEnd.toFixed(1)}s) exceeds video length (${videoDuration.toFixed(1)}s).`,
              });
              return;
            }
          } catch (error) {
            logger.warn('Failed to get video metadata for timeframe validation:', error.message);
            // Continue anyway, FFmpeg will handle it
          }
        }

        await convertToGif(tempFilePath, gifPath, conversionOptions);
      } else {
        // Check if input is already a GIF
        const isGif = attachment.contentType === 'image/gif' || ext === '.gif';

        if (isGif) {
          // Get GIF dimensions to check if we need to resize
          try {
            const metadata = await getVideoMetadata(tempFilePath);
            const videoStream = metadata.streams?.find(s => s.codec_type === 'video');
            const gifWidth = videoStream?.width;

            // Use provided width, user config, or check against limits
            const targetWidth =
              options.width ??
              (userConfig.width !== null ? userConfig.width : Math.min(MAX_GIF_WIDTH, 720));

            if (
              gifWidth &&
              gifWidth <= MAX_GIF_WIDTH &&
              !options.width &&
              (userConfig.width === null || gifWidth <= userConfig.width)
            ) {
              // GIF is within size limits, copy directly without re-encoding
              logger.info(
                `Input GIF is within size limits (${gifWidth}px <= ${MAX_GIF_WIDTH}px), copying directly`
              );
              await fs.copyFile(tempFilePath, gifPath);
            } else {
              // GIF exceeds size limits or custom width requested, resize with convertImageToGif
              logger.info(
                `Input GIF exceeds size limits or custom width requested (${gifWidth || 'unknown'}px), resizing to ${targetWidth}px`
              );
              await convertImageToGif(tempFilePath, gifPath, {
                width: targetWidth,
                quality:
                  options.quality ?? (userConfig.quality !== null ? userConfig.quality : 'medium'),
              });
            }
          } catch (error) {
            // If metadata extraction fails, fall back to normal conversion
            logger.warn(`Failed to get GIF metadata, falling back to conversion: ${error.message}`);
            await convertImageToGif(tempFilePath, gifPath, {
              width:
                options.width ??
                (userConfig.width !== null ? userConfig.width : Math.min(MAX_GIF_WIDTH, 720)),
              quality:
                options.quality ?? (userConfig.quality !== null ? userConfig.quality : 'medium'),
            });
          }
        } else {
          // Not a GIF, proceed with normal conversion
          await convertImageToGif(tempFilePath, gifPath, {
            width:
              options.width ??
              (userConfig.width !== null ? userConfig.width : Math.min(MAX_GIF_WIDTH, 720)),
            quality:
              options.quality ?? (userConfig.quality !== null ? userConfig.quality : 'medium'),
          });
        }
      }
    } else {
      // GIF already exists, read it directly
      logger.info(`Using existing GIF (hash: ${hash}) for user ${userId}`);
    }

    // Read the generated GIF to verify it was created (or read existing one)
    let gifBuffer = await fs.readFile(gifPath);
    const originalSize = gifBuffer.length;

    // Check if optimization is requested
    let finalHash = hash;
    let _finalGifPath = gifPath;
    let optimizedSize = originalSize;
    let wasAutoOptimized = false;
    let finalGifUrl = null;

    // Only upload initial GIF to R2 if optimization is NOT going to happen
    // (if optimization or auto-optimization is enabled, we'll upload the optimized version instead)
    const willOptimize = options.optimize || userConfig.autoOptimize;
    if (!willOptimize) {
      try {
        finalGifUrl = await saveGif(gifBuffer, hash, GIF_STORAGE_PATH, buildMetadata());
      } catch (error) {
        logger.warn(`Failed to upload initial GIF to R2, continuing:`, error.message);
      }
    }

    if (options.optimize) {
      // Generate hash for optimized file (include lossy level in hash for uniqueness)
      const optimizedHash = crypto.createHash('md5');
      optimizedHash.update(gifBuffer);
      optimizedHash.update('optimized');
      if (options.lossy !== undefined && options.lossy !== null) {
        optimizedHash.update(options.lossy.toString());
      }
      const optimizedHashValue = optimizedHash.digest('hex');
      const optimizedGifPath = getGifPath(optimizedHashValue, GIF_STORAGE_PATH);

      // Check if optimized GIF already exists
      const optimizedExists = await gifExists(optimizedHashValue, GIF_STORAGE_PATH);
      if (optimizedExists) {
        logger.info(
          `Optimized GIF already exists (hash: ${optimizedHashValue}) for user ${userId}`
        );
        const optimizedBuffer = await fs.readFile(optimizedGifPath);
        optimizedSize = optimizedBuffer.length;
        finalHash = optimizedHashValue;
        _finalGifPath = optimizedGifPath;
        // Upload optimized version to R2 if not already there
        finalGifUrl = await saveGif(
          optimizedBuffer,
          optimizedHashValue,
          GIF_STORAGE_PATH,
          buildMetadata()
        );
      } else {
        // Optimize the GIF with specified lossy level
        const optimizeOptions =
          options.lossy !== undefined && options.lossy !== null ? { lossy: options.lossy } : {};
        logger.info(
          `Optimizing GIF: ${gifPath} -> ${optimizedGifPath}${options.lossy !== undefined && options.lossy !== null ? ` (lossy: ${options.lossy})` : ''}`
        );
        await optimizeGif(gifPath, optimizedGifPath, optimizeOptions);

        // Read optimized file and get its size
        const optimizedBuffer = await fs.readFile(optimizedGifPath);
        optimizedSize = optimizedBuffer.length;
        finalHash = optimizedHashValue;
        _finalGifPath = optimizedGifPath;
        // Upload optimized version to R2
        finalGifUrl = await saveGif(
          optimizedBuffer,
          optimizedHashValue,
          GIF_STORAGE_PATH,
          buildMetadata()
        );
      }
    } else if (userConfig.autoOptimize) {
      // Auto-optimize if enabled in user config
      const optimizedHash = crypto.createHash('md5');
      optimizedHash.update(gifBuffer);
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
        const optimizedBuffer = await fs.readFile(optimizedGifPath);
        optimizedSize = optimizedBuffer.length;
        finalHash = optimizedHashValue;
        _finalGifPath = optimizedGifPath;
        wasAutoOptimized = true;
        // Upload optimized version to R2 if not already there
        finalGifUrl = await saveGif(
          optimizedBuffer,
          optimizedHashValue,
          GIF_STORAGE_PATH,
          buildMetadata()
        );
      } else {
        // Auto-optimize the GIF with default lossy level
        logger.info(`Auto-optimizing GIF: ${gifPath} -> ${optimizedGifPath} (lossy: 35)`);
        await optimizeGif(gifPath, optimizedGifPath, { lossy: 35 });

        // Read optimized file and get its size
        const optimizedBuffer = await fs.readFile(optimizedGifPath);
        optimizedSize = optimizedBuffer.length;
        finalHash = optimizedHashValue;
        _finalGifPath = optimizedGifPath;
        wasAutoOptimized = true;
        // Upload optimized version to R2
        finalGifUrl = await saveGif(
          optimizedBuffer,
          optimizedHashValue,
          GIF_STORAGE_PATH,
          buildMetadata()
        );
      }
    }

    // Generate final URL - use R2 URL if available, otherwise construct from CDN_BASE_URL
    let gifUrl;
    if (finalGifUrl && (finalGifUrl.startsWith('http://') || finalGifUrl.startsWith('https://'))) {
      // Already an R2 URL
      gifUrl = finalGifUrl;
    } else {
      // Fallback to constructing URL from CDN_BASE_URL
      gifUrl = `${CDN_BASE_URL}/${finalHash}.gif`;
    }

    // Track recent conversion
    trackRecentConversion(userId, gifUrl);

    logger.info(
      `Successfully created GIF (hash: ${finalHash}, size: ${(optimizedSize / (1024 * 1024)).toFixed(2)}MB) for user ${userId}${options.optimize ? ' [OPTIMIZED]' : ''}${wasAutoOptimized ? ' [AUTO-OPTIMIZED]' : ''}`
    );

    // Update operation to success with file size
    updateOperationStatus(operationId, 'success', { fileSize: optimizedSize });

    await interaction.editReply({
      content: gifUrl,
    });

    // Send success notification
    await notifyCommandSuccess(username, 'convert');

    // Record rate limit after successful conversion
    recordRateLimit(userId);
  } catch (error) {
    logger.error(`Conversion failed for user ${userId} (${interaction.user.tag}):`, error);
    updateOperationStatus(operationId, 'error', { error: error.message || 'unknown error' });
    await interaction.editReply({
      content: 'an error occurred',
    });

    // Send failure notification
    await notifyCommandFailure(username, 'convert');
  } finally {
    // Clean up temp files
    if (tempFiles.length > 0) {
      await cleanupTempFiles(tempFiles);
    }
  }
}

/**
 * Handle convert context menu command
 * @param {Interaction} interaction - Discord interaction
 */
export async function handleConvertContextMenu(interaction) {
  if (!interaction.isMessageContextMenuCommand()) {
    return;
  }

  if (interaction.commandName !== 'convert to gif') {
    return;
  }

  const userId = interaction.user.id;
  const adminUser = isAdmin(userId);

  logger.info(
    `User ${userId} (${interaction.user.tag}) initiated conversion${adminUser ? ' [ADMIN]' : ''}`
  );

  // Check rate limit (admins bypass this check)
  if (checkRateLimit(userId)) {
    logger.warn(`User ${userId} (${interaction.user.tag}) is rate limited`);
    await interaction.reply({
      content: 'please wait 30 seconds before converting another video or image.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Get the message that was right-clicked
  const targetMessage = interaction.targetMessage;

  // Find video or image attachment
  const videoAttachment = targetMessage.attachments.find(
    att => att.contentType && ALLOWED_VIDEO_TYPES.includes(att.contentType)
  );

  const imageAttachment = targetMessage.attachments.find(
    att => att.contentType && ALLOWED_IMAGE_TYPES.includes(att.contentType)
  );

  // Check for URLs in message content if no attachments found
  let url = null;
  if (!videoAttachment && !imageAttachment && targetMessage.content) {
    // Extract URLs from message content
    const urlPattern = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
    const urls = targetMessage.content.match(urlPattern);
    if (urls && urls.length > 0) {
      url = urls[0]; // Use the first URL found
      logger.info(`Found URL in message content: ${url}`);
    }
  }

  // Determine attachment type and validate
  let attachment = null;
  let attachmentType = null;
  let preDownloadedBuffer = null;

  if (videoAttachment) {
    attachment = videoAttachment;
    attachmentType = 'video';
    logger.info(
      `Processing video: ${videoAttachment.name} (${(videoAttachment.size / (1024 * 1024)).toFixed(2)}MB)`
    );
    const validation = validateVideoAttachment(videoAttachment, adminUser);
    if (!validation.valid) {
      logger.warn(`Video validation failed for user ${userId}: ${validation.error}`);
      await interaction.reply({
        content: validation.error,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } else if (imageAttachment) {
    attachment = imageAttachment;
    attachmentType = 'image';
    logger.info(
      `Processing image: ${imageAttachment.name} (${(imageAttachment.size / (1024 * 1024)).toFixed(2)}MB)`
    );
    const validation = validateImageAttachment(imageAttachment, adminUser);
    if (!validation.valid) {
      logger.warn(`Image validation failed for user ${userId}: ${validation.error}`);
      await interaction.reply({
        content: validation.error,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } else if (url) {
    // Validate URL format and protocol (strict validation)
    const urlValidation = validateUrl(url);
    if (!urlValidation.valid) {
      logger.warn(`Invalid URL for user ${userId}: ${urlValidation.error}`);
      await interaction.reply({
        content: `invalid URL: ${urlValidation.error}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Defer reply since downloading may take time
    await interaction.deferReply();

    try {
      // Check if URL is a Tenor GIF link and parse it
      let actualUrl = url;
      const isTenorUrl = /^https?:\/\/(www\.)?tenor\.com\/view\/.+-gif-\d+/i.test(url);
      if (isTenorUrl) {
        logger.info(`Detected Tenor URL, parsing to extract GIF URL: ${url}`);
        try {
          actualUrl = await parseTenorUrl(url);
          logger.info(`Resolved Tenor URL to: ${actualUrl}`);
        } catch (error) {
          logger.error(`Failed to parse Tenor URL for user ${userId}:`, error);
          await interaction.editReply({
            content: error.message || 'failed to parse Tenor URL.',
          });
          return;
        }
      }

      logger.info(`Downloading file from URL: ${actualUrl}`);
      const fileData = await downloadFileFromUrl(actualUrl, adminUser, interaction.client);

      // Store the buffer to avoid double download
      preDownloadedBuffer = fileData.buffer;

      // Create a pseudo-attachment object
      attachment = {
        url: actualUrl,
        name: fileData.filename,
        size: fileData.size,
        contentType: fileData.contentType,
      };

      // Determine attachment type based on content type
      if (fileData.contentType && ALLOWED_VIDEO_TYPES.includes(fileData.contentType)) {
        attachmentType = 'video';
        logger.info(
          `Processing video from URL: ${attachment.name} (${(attachment.size / (1024 * 1024)).toFixed(2)}MB)`
        );
        const validation = validateVideoAttachment(attachment, adminUser);
        if (!validation.valid) {
          logger.warn(`Video validation failed for user ${userId}: ${validation.error}`);
          await interaction.editReply({
            content: validation.error,
          });
          return;
        }
      } else if (fileData.contentType && ALLOWED_IMAGE_TYPES.includes(fileData.contentType)) {
        attachmentType = 'image';
        logger.info(
          `Processing image from URL: ${attachment.name} (${(attachment.size / (1024 * 1024)).toFixed(2)}MB)`
        );
        const validation = validateImageAttachment(attachment, adminUser);
        if (!validation.valid) {
          logger.warn(`Image validation failed for user ${userId}: ${validation.error}`);
          await interaction.editReply({
            content: validation.error,
          });
          return;
        }
      } else {
        logger.warn(`Invalid attachment type for user ${userId}`);
        await interaction.editReply({
          content:
            'unsupported file format. please provide a video (mp4, mov, webm, avi, mkv) or image (png, jpg, jpeg, webp, gif).',
        });
        return;
      }
    } catch (error) {
      logger.error(`Failed to download file from URL for user ${userId}:`, error);
      await interaction.editReply({
        content: error.message || 'failed to download file from URL.',
      });
      return;
    }
  } else {
    logger.warn(`No video or image attachment or URL found for user ${userId}`);
    await interaction.reply({
      content: 'no video or image attachment or URL found in this message.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Defer reply if not already deferred (for attachment case)
  if (!url) {
    await interaction.deferReply();
  }

  await processConversion(interaction, attachment, attachmentType, adminUser, preDownloadedBuffer);
}

/**
 * Handle convert slash command
 * @param {Interaction} interaction - Discord interaction
 */
export async function handleConvertCommand(interaction) {
  const userId = interaction.user.id;
  const adminUser = isAdmin(userId);

  logger.info(
    `User ${userId} (${interaction.user.tag}) initiated conversion via slash command${adminUser ? ' [ADMIN]' : ''}`
  );

  // Check rate limit (admins bypass this check)
  if (checkRateLimit(userId)) {
    logger.warn(`User ${userId} (${interaction.user.tag}) is rate limited`);
    await interaction.reply({
      content: 'please wait 30 seconds before converting another video or image.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Get attachment or URL from command options
  const attachment = interaction.options.getAttachment('file');
  const url = interaction.options.getString('url');
  const optimize = interaction.options.getBoolean('optimize') ?? false;
  const lossy = interaction.options.getNumber('lossy');

  if (!attachment && !url) {
    logger.warn(`No attachment or URL provided for user ${userId}`);
    await interaction.reply({
      content: 'please provide either a video/image attachment or a URL to a video/image file.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (attachment && url) {
    logger.warn(`Both attachment and URL provided for user ${userId}`);
    await interaction.reply({
      content: 'please provide either a file attachment or a URL, not both.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let finalAttachment = attachment;
  let attachmentType = null;
  let preDownloadedBuffer = null;

  // If URL is provided, download the file first
  if (url) {
    // Validate URL format and protocol (strict validation)
    const urlValidation = validateUrl(url);
    if (!urlValidation.valid) {
      logger.warn(`Invalid URL for user ${userId}: ${urlValidation.error}`);
      await interaction.reply({
        content: `invalid URL: ${urlValidation.error}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Defer reply since downloading may take time
    await interaction.deferReply();

    try {
      // Check if URL is a Tenor GIF link and parse it
      let actualUrl = url;
      const isTenorUrl = /^https?:\/\/(www\.)?tenor\.com\/view\/.+-gif-\d+/i.test(url);
      if (isTenorUrl) {
        logger.info(`Detected Tenor URL, parsing to extract GIF URL: ${url}`);
        try {
          actualUrl = await parseTenorUrl(url);
          logger.info(`Resolved Tenor URL to: ${actualUrl}`);
        } catch (error) {
          logger.error(`Failed to parse Tenor URL for user ${userId}:`, error);
          await interaction.editReply({
            content: error.message || 'failed to parse Tenor URL.',
          });
          return;
        }
      }

      logger.info(`Downloading file from URL: ${actualUrl}`);
      const fileData = await downloadFileFromUrl(actualUrl, adminUser, interaction.client);

      // Store the buffer to avoid double download
      preDownloadedBuffer = fileData.buffer;

      // Create a pseudo-attachment object
      finalAttachment = {
        url: actualUrl,
        name: fileData.filename,
        size: fileData.size,
        contentType: fileData.contentType,
      };
    } catch (error) {
      logger.error(`Failed to download file from URL for user ${userId}:`, error);
      await interaction.editReply({
        content: error.message || 'failed to download file from URL.',
      });
      return;
    }
  }

  // Determine attachment type and validate
  if (finalAttachment.contentType && ALLOWED_VIDEO_TYPES.includes(finalAttachment.contentType)) {
    attachmentType = 'video';
    logger.info(
      `Processing video: ${finalAttachment.name} (${(finalAttachment.size / (1024 * 1024)).toFixed(2)}MB)`
    );
    const validation = validateVideoAttachment(finalAttachment, adminUser);
    if (!validation.valid) {
      logger.warn(`Video validation failed for user ${userId}: ${validation.error}`);
      if (url) {
        await interaction.editReply({
          content: validation.error,
        });
      } else {
        await interaction.reply({
          content: validation.error,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }
  } else if (
    finalAttachment.contentType &&
    ALLOWED_IMAGE_TYPES.includes(finalAttachment.contentType)
  ) {
    attachmentType = 'image';
    logger.info(
      `Processing image: ${finalAttachment.name} (${(finalAttachment.size / (1024 * 1024)).toFixed(2)}MB)`
    );
    const validation = validateImageAttachment(finalAttachment, adminUser);
    if (!validation.valid) {
      logger.warn(`Image validation failed for user ${userId}: ${validation.error}`);
      if (url) {
        await interaction.editReply({
          content: validation.error,
        });
      } else {
        await interaction.reply({
          content: validation.error,
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }
  } else {
    logger.warn(`Invalid attachment type for user ${userId}`);
    const errorMsg =
      'unsupported file format. please provide a video (mp4, mov, webm, avi, mkv) or image (png, jpg, jpeg, webp, gif).';
    if (url) {
      await interaction.editReply({
        content: errorMsg,
      });
    } else {
      await interaction.reply({
        content: errorMsg,
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  // Defer reply if not already deferred (for attachment case)
  if (!url) {
    await interaction.deferReply();
  }

  await processConversion(
    interaction,
    finalAttachment,
    attachmentType,
    adminUser,
    preDownloadedBuffer,
    {
      optimize,
      lossy: lossy !== null ? lossy : undefined,
    }
  );
}
