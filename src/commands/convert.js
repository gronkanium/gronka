import { MessageFlags, AttachmentBuilder } from 'discord.js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from '../utils/logger.js';
import { botConfig } from '../utils/config.js';
import { validateUrl, validateFileExtension } from '../utils/validation.js';
import { ValidationError } from '../utils/errors.js';
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
import {
  gifExists,
  getGifPath,
  getVideoPath,
  getImagePath,
  cleanupTempFiles,
  saveGif,
  shouldUploadToDiscord,
} from '../utils/storage.js';
import {
  uploadGifToR2,
  downloadGifFromR2,
  gifExistsInR2,
  getR2PublicUrl,
} from '../utils/r2-storage.js';
import { getUserConfig } from '../utils/user-config.js';
import { trackRecentConversion } from '../utils/user-tracking.js';
import { optimizeGif } from '../utils/gif-optimizer.js';
import {
  createOperation,
  updateOperationStatus,
  logOperationStep,
  logOperationError,
} from '../utils/operations-tracker.js';
import { notifyCommandSuccess, notifyCommandFailure } from '../utils/ntfy-notifier.js';
import { hashUrl } from '../utils/cobalt-queue.js';
import { insertProcessedUrl, initDatabase, getProcessedUrl } from '../utils/database.js';
import { isSocialMediaUrl } from '../utils/cobalt.js';
import { r2Config } from '../utils/config.js';

const logger = createLogger('convert');

const {
  gifStoragePath: GIF_STORAGE_PATH,
  cdnBaseUrl: CDN_BASE_URL,
  maxGifWidth: MAX_GIF_WIDTH,
  maxGifDuration: MAX_GIF_DURATION,
  defaultFps: DEFAULT_FPS,
} = botConfig;

// Video file signature constants
// ftyp box type signature (used by MP4 and MOV)
const FTYP_BOX_TYPE = Buffer.from([0x66, 0x74, 0x79, 0x70]); // "ftyp" in ASCII

// Fixed signatures for formats that don't use ftyp boxes
const FIXED_VIDEO_SIGNATURES = {
  webm: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), // WebM
  avi: Buffer.from('RIFF'),
};

const MAX_VIDEO_SIZE = 100 * 1024 * 1024; // 100MB limit for videos

/**
 * Validate video buffer before writing to filesystem
 * Checks file signature (magic bytes), size limits, and basic structure
 * @param {Buffer} buffer - File buffer to validate
 * @throws {ValidationError} If buffer is invalid
 */
function validateVideoBuffer(buffer) {
  // Check buffer exists and has minimum size
  if (!buffer || buffer.length < 12) {
    throw new ValidationError('invalid or empty file buffer');
  }

  // Check file size limit
  if (buffer.length > MAX_VIDEO_SIZE) {
    throw new ValidationError(
      `file too large. maximum size for video files is ${MAX_VIDEO_SIZE / 1024 / 1024}mb.`
    );
  }

  // Check for MP4/MOV files by looking for ftyp box type
  // MP4/MOV files have a box structure where:
  // - First 4 bytes: box size (can vary)
  // - Bytes 4-7: box type "ftyp" (0x66, 0x74, 0x79, 0x70)
  // Some variants might have ftyp at offset 0
  const isMp4OrMov =
    (buffer.length >= 8 && buffer.slice(4, 8).equals(FTYP_BOX_TYPE)) ||
    (buffer.length >= 4 && buffer.slice(0, 4).equals(FTYP_BOX_TYPE));

  // Check for fixed signatures (WebM, AVI)
  const header = buffer.slice(0, 12);
  const hasFixedSignature = Object.entries(FIXED_VIDEO_SIGNATURES).some(([_format, signature]) => {
    return header.slice(0, signature.length).equals(signature);
  });

  if (!isMp4OrMov && !hasFixedSignature) {
    throw new ValidationError(
      'file is not a valid video format. supported formats: mp4, webm, avi, mov.'
    );
  }

  return true;
}

/**
 * Write a validated file buffer to the filesystem
 * This function ensures validation happens before write so CodeQL can track the data flow
 * @param {string} filePath - Path where the file should be written
 * @param {Buffer} buffer - File buffer to write (must be validated)
 * @param {string} attachmentType - Type of attachment ('video' or 'image')
 * @throws {ValidationError} If buffer validation fails
 * @returns {Promise<void>}
 */
async function writeValidatedFileBuffer(filePath, buffer, attachmentType) {
  // Validate file buffer before writing to filesystem (only for videos)
  if (attachmentType === 'video') {
    try {
      validateVideoBuffer(buffer);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      throw new ValidationError('file validation failed: ' + error.message);
    }
  }
  // For images, validation is done through file extension checks (allowedExtensions)
  // Only validated network data is written to filesystem
  // Note: CodeQL flags this as network data to file, but the data is validated above
  // If validation fails, an error is thrown and execution never reaches this point
  await fs.writeFile(filePath, buffer);
}

/**
 * Check if a CDN URL points to a local file and return the file buffer if it exists
 * @param {string} url - CDN URL to check (e.g., https://cdn.gronka.p1x.dev/gifs/abc123.gif)
 * @param {string} storagePath - Base storage path
 * @returns {Promise<{exists: boolean, buffer?: Buffer, filePath?: string, contentType?: string, filename?: string}>}
 */
async function checkAndReadLocalFileFromCdnUrl(url, storagePath) {
  try {
    const urlObj = new URL(url);

    // Check if it's a p1x.dev subdomain URL
    if (!urlObj.hostname.endsWith('.p1x.dev')) {
      return { exists: false };
    }

    // Parse path patterns: /gifs/{hash}.gif, /videos/{hash}.{ext}, /images/{hash}.{ext}
    const gifPathMatch = urlObj.pathname.match(/^\/gifs\/([a-f0-9]+)\.gif$/i);
    if (gifPathMatch && gifPathMatch[1]) {
      const hash = gifPathMatch[1];
      const filePath = getGifPath(hash, storagePath);
      try {
        // Read file directly to avoid TOCTOU race condition
        // readFile will throw if file doesn't exist or is inaccessible
        const buffer = await fs.readFile(filePath);
        return {
          exists: true,
          buffer,
          filePath,
          contentType: 'image/gif',
          filename: `${hash}.gif`,
        };
      } catch {
        return { exists: false };
      }
    }

    const videoPathMatch = urlObj.pathname.match(
      /^\/videos\/([a-f0-9]+)\.(mp4|webm|mov|avi|mkv)$/i
    );
    if (videoPathMatch && videoPathMatch[1] && videoPathMatch[2]) {
      const hash = videoPathMatch[1];
      const extension = `.${videoPathMatch[2]}`;
      const filePath = getVideoPath(hash, extension, storagePath);
      try {
        // Read file directly to avoid TOCTOU race condition
        // readFile will throw if file doesn't exist or is inaccessible
        const buffer = await fs.readFile(filePath);
        // Determine content type from extension
        const contentTypeMap = {
          '.mp4': 'video/mp4',
          '.webm': 'video/webm',
          '.mov': 'video/quicktime',
          '.avi': 'video/x-msvideo',
          '.mkv': 'video/x-matroska',
        };
        const contentType = contentTypeMap[extension.toLowerCase()] || 'video/mp4';
        return {
          exists: true,
          buffer,
          filePath,
          contentType,
          filename: `${hash}${extension}`,
        };
      } catch {
        return { exists: false };
      }
    }

    const imagePathMatch = urlObj.pathname.match(/^\/images\/([a-f0-9]+)\.(png|jpg|jpeg|webp)$/i);
    if (imagePathMatch && imagePathMatch[1] && imagePathMatch[2]) {
      const hash = imagePathMatch[1];
      const extension = `.${imagePathMatch[2]}`;
      const filePath = getImagePath(hash, extension, storagePath);
      try {
        // Read file directly to avoid TOCTOU race condition
        // readFile will throw if file doesn't exist or is inaccessible
        const buffer = await fs.readFile(filePath);
        // Determine content type from extension
        const contentTypeMap = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.webp': 'image/webp',
        };
        const contentType = contentTypeMap[extension.toLowerCase()] || 'image/png';
        return {
          exists: true,
          buffer,
          filePath,
          contentType,
          filename: `${hash}${extension}`,
        };
      } catch {
        return { exists: false };
      }
    }

    return { exists: false };
  } catch {
    return { exists: false };
  }
}

/**
 * Process conversion from attachment to GIF
 * @param {Interaction} interaction - Discord interaction
 * @param {Attachment} attachment - Discord attachment to convert
 * @param {string} attachmentType - Type of attachment ('video' or 'image')
 * @param {boolean} adminUser - Whether the user is an admin
 * @param {Buffer} [preDownloadedBuffer] - Optional pre-downloaded buffer (to avoid double download)
 * @param {Object} [options] - Optional conversion options (startTime, duration, width, fps, quality)
 * @param {string} [originalUrl] - Original URL if this conversion came from a URL (not Discord attachment)
 * @param {string} [commandSource] - Command source ('slash' or 'context-menu')
 */
export async function processConversion(
  interaction,
  attachment,
  attachmentType,
  adminUser,
  preDownloadedBuffer = null,
  options = {},
  originalUrl = null,
  commandSource = null
) {
  const userId = interaction.user.id;
  const username = interaction.user.tag || interaction.user.username || 'unknown';
  const tempFiles = [];

  // Build operation context
  const operationContext = {
    commandOptions: options,
  };
  if (originalUrl) {
    operationContext.originalUrl = originalUrl;
  }
  if (attachment) {
    operationContext.attachment = {
      name: attachment.name || null,
      size: attachment.size || null,
      contentType: attachment.contentType || null,
      url: attachment.url || null,
    };
  }
  if (commandSource) {
    operationContext.commandSource = commandSource;
  }

  // Create operation tracking with context
  const operationId = createOperation('convert', userId, username, operationContext);

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
    // Initialize database if needed (for URL tracking)
    if (originalUrl) {
      await initDatabase();
      logOperationStep(operationId, 'url_validation', 'running', {
        message: 'Validating and processing URL',
        metadata: { originalUrl },
      });
    }

    // Download file (video or image) if not already downloaded
    // Admins bypass size limits in download
    if (!preDownloadedBuffer) {
      logOperationStep(operationId, 'download_start', 'running', {
        message: `Starting download from ${attachment.url}`,
        metadata: {
          sourceUrl: attachment.url,
          attachmentType,
          expectedSize: attachment.size || null,
        },
      });
    }

    const fileBuffer =
      preDownloadedBuffer ||
      (attachmentType === 'video'
        ? await downloadVideo(attachment.url, adminUser)
        : await downloadImage(attachment.url, adminUser));

    if (!preDownloadedBuffer) {
      logOperationStep(operationId, 'download_complete', 'success', {
        message: 'File downloaded successfully',
        metadata: {
          downloadedSize: fileBuffer.length,
          sourceUrl: attachment.url,
        },
      });
    }

    // Generate hash
    const hash = generateHash(fileBuffer);

    // Update operation to running
    updateOperationStatus(operationId, 'running');

    logOperationStep(operationId, 'validation_start', 'running', {
      message: 'Validating file',
      metadata: {
        hash: hash.substring(0, 8) + '...',
        attachmentType,
        fileName: attachment.name,
        fileSize: attachment.size,
        contentType: attachment.contentType,
      },
    });

    // Check if URL has already been processed (only for URL-based conversions)
    if (originalUrl) {
      const urlHash = hashUrl(originalUrl);
      const processedUrl = await getProcessedUrl(urlHash);
      if (processedUrl) {
        // Skip cache for social media URLs if cached result is not a GIF
        // This allows social media URLs to be processed fresh through Cobalt for conversion
        const isSocialMedia = isSocialMediaUrl(originalUrl);
        const isCachedGif =
          processedUrl.file_type === 'gif' || processedUrl.file_extension === '.gif';

        if (isSocialMedia && !isCachedGif) {
          logger.info(
            `URL is social media and cached result is not a GIF (type: ${processedUrl.file_type}, ext: ${processedUrl.file_extension}), skipping cache to process through Cobalt`
          );
          logOperationStep(operationId, 'url_validation', 'success', {
            message: 'URL validation complete',
            metadata: { originalUrl },
          });
          logOperationStep(operationId, 'url_cache_skip', 'success', {
            message: 'Skipping cache for social media URL to process through Cobalt',
            metadata: { originalUrl, cachedType: processedUrl.file_type },
          });
        } else {
          logger.info(
            `URL already processed (hash: ${urlHash.substring(0, 8)}...), returning existing file URL: ${processedUrl.file_url}`
          );
          logOperationStep(operationId, 'url_validation', 'success', {
            message: 'URL validation complete',
            metadata: { originalUrl },
          });
          logOperationStep(operationId, 'url_cache_hit', 'success', {
            message: 'URL already processed, returning cached result',
            metadata: { originalUrl, cachedUrl: processedUrl.file_url },
          });
          updateOperationStatus(operationId, 'success', { fileSize: 0 });
          recordRateLimit(userId);
          await interaction.editReply({
            content: processedUrl.file_url,
          });
          await notifyCommandSuccess(username, 'convert', { operationId, userId });
          return;
        }
      }
      logOperationStep(operationId, 'url_validation', 'success', {
        message: 'URL validation complete',
        metadata: { originalUrl },
      });
      logOperationStep(operationId, 'url_cache_miss', 'running', {
        message: 'URL not found in cache, proceeding with conversion',
        metadata: { originalUrl },
      });
      logOperationStep(operationId, 'url_cache_miss', 'success', {
        message: 'URL cache check complete, proceeding with conversion',
        metadata: { originalUrl },
      });
    }

    // Check if GIF already exists
    const exists = await gifExists(hash, GIF_STORAGE_PATH);
    if (exists && !options.optimize) {
      logger.info(`GIF already exists (hash: ${hash}) for user ${userId}`);
      logOperationStep(operationId, 'gif_cache_hit', 'success', {
        message: 'GIF already exists, checking if should upload to Discord',
        metadata: { hash: hash.substring(0, 8) + '...' },
      });

      // Read the GIF file from R2 or local disk
      let gifBuffer = null;
      let fileSize = 0;
      let existsInR2 = false;

      // Check if file exists in R2
      if (
        r2Config.accountId &&
        r2Config.accessKeyId &&
        r2Config.secretAccessKey &&
        r2Config.bucketName
      ) {
        existsInR2 = await gifExistsInR2(hash, r2Config);
        if (existsInR2) {
          try {
            gifBuffer = await downloadGifFromR2(hash, r2Config);
            fileSize = gifBuffer.length;
          } catch (error) {
            logger.warn(`Failed to download GIF from R2, trying local disk: ${error.message}`);
            existsInR2 = false;
          }
        }
      }

      // If not in R2 or download failed, try local disk
      if (!gifBuffer) {
        const gifPath = getGifPath(hash, GIF_STORAGE_PATH);
        try {
          gifBuffer = await fs.readFile(gifPath);
          fileSize = gifBuffer.length;
        } catch (error) {
          logger.error(`Failed to read GIF from local disk: ${error.message}`);
          // Fallback: return R2 URL if it exists in R2, otherwise construct CDN URL
          const gifUrl = existsInR2
            ? getR2PublicUrl(`gifs/${hash.replace(/[^a-f0-9]/gi, '')}.gif`, r2Config)
            : `${CDN_BASE_URL}/${hash}.gif`;
          updateOperationStatus(operationId, 'success', { fileSize: 0 });
          recordRateLimit(userId);
          await interaction.editReply({
            content: gifUrl,
          });
          return;
        }
      }

      // Check if file should be uploaded to Discord (< 8MB)
      if (shouldUploadToDiscord(gifBuffer)) {
        logger.info(
          `Cached GIF is small enough for Discord (${(fileSize / (1024 * 1024)).toFixed(2)}MB), uploading to Discord`
        );
        logOperationStep(operationId, 'discord_upload', 'running', {
          message: 'Uploading cached GIF to Discord',
          metadata: { fileSize },
        });

        const safeHash = hash.replace(/[^a-f0-9]/gi, '');
        const filename = `${safeHash}.gif`;
        try {
          const message = await interaction.editReply({
            files: [new AttachmentBuilder(gifBuffer, { name: filename })],
          });

          // Capture Discord attachment URL and save to database
          // Try to get attachments from the returned message first
          let discordUrl = null;
          if (message && message.attachments && message.attachments.size > 0) {
            const discordAttachment = message.attachments.first();
            if (discordAttachment && discordAttachment.url) {
              discordUrl = discordAttachment.url;
              logger.debug(
                `Captured Discord attachment URL for cached GIF from editReply: ${discordUrl.substring(0, 60)}...`
              );
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
                  logger.debug(
                    `Captured Discord attachment URL for cached GIF from fetched message: ${discordUrl.substring(0, 60)}...`
                  );
                }
              }
            } catch (fetchError) {
              logger.warn(
                `Failed to fetch message to get attachment URL for cached GIF: ${fetchError.message}`
              );
            }
          }

          // Save Discord attachment URL to database if we got one
          if (discordUrl) {
            // For cached files, use the hash as urlHash since there's no originalUrl
            const urlHash = hash;
            await insertProcessedUrl(
              urlHash,
              hash,
              'gif',
              '.gif',
              discordUrl,
              Date.now(),
              userId,
              fileSize
            );
            logger.debug(
              `Recorded Discord attachment URL in database for cached GIF (urlHash: ${urlHash.substring(0, 8)}..., url: ${discordUrl.substring(0, 50)}...)`
            );
            logger.info(`Uploaded to Discord: ${discordUrl}`);
          } else {
            logger.warn(
              `Failed to capture Discord attachment URL for cached GIF - message: ${message ? 'exists' : 'null'}, attachments: ${message?.attachments?.size || 0}, messageId: ${message?.id || 'none'}`
            );
          }

          logOperationStep(operationId, 'discord_upload', 'success', {
            message: 'Cached GIF uploaded to Discord successfully',
          });
          updateOperationStatus(operationId, 'success', { fileSize });
          recordRateLimit(userId);
          await notifyCommandSuccess(username, 'convert', { operationId, userId });
          return;
        } catch (discordError) {
          // Discord upload failed, fallback to R2 URL
          logger.warn(
            `Discord attachment upload failed for cached GIF, falling back to R2 URL: ${discordError.message}`
          );
          logOperationStep(operationId, 'discord_upload', 'error', {
            message: 'Discord upload failed, falling back to R2 URL',
            metadata: { error: discordError.message },
          });

          // Upload to R2 as fallback
          try {
            const r2Url = await uploadGifToR2(gifBuffer, hash, r2Config, buildMetadata());
            if (r2Url) {
              updateOperationStatus(operationId, 'success', { fileSize });
              recordRateLimit(userId);
              await interaction.editReply({
                content: r2Url,
              });
              await notifyCommandSuccess(username, 'convert', { operationId, userId });
              return;
            }
          } catch (r2Error) {
            logger.error(`R2 fallback upload also failed: ${r2Error.message}`);
          }

          // Last resort: construct CDN URL
          const gifUrl = `${CDN_BASE_URL}/${hash}.gif`;
          updateOperationStatus(operationId, 'success', { fileSize });
          recordRateLimit(userId);
          await interaction.editReply({
            content: gifUrl,
          });
          await notifyCommandSuccess(username, 'convert', { operationId, userId });
          return;
        }
      } else {
        // File is >= 8MB, return R2 URL or CDN URL
        logger.info(
          `Cached GIF is too large for Discord (${(fileSize / (1024 * 1024)).toFixed(2)}MB), returning URL`
        );
        const gifUrl = existsInR2
          ? getR2PublicUrl(`gifs/${hash.replace(/[^a-f0-9]/gi, '')}.gif`, r2Config)
          : `${CDN_BASE_URL}/${hash}.gif`;
        updateOperationStatus(operationId, 'success', { fileSize });
        recordRateLimit(userId);
        await interaction.editReply({
          content: gifUrl,
        });
        await notifyCommandSuccess(username, 'convert', { operationId, userId });
        return;
      }
    }

    logOperationStep(operationId, 'validation_complete', 'success', {
      message: 'File validation passed',
      metadata: {
        hash: hash.substring(0, 8) + '...',
        attachmentType,
        needsConversion: !exists,
        willOptimize: options.optimize || false,
      },
    });

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

    // Generate safe temp file path - validate to prevent path injection
    const filePrefix = attachmentType === 'video' ? 'video' : 'image';
    // Sanitize extension to prevent path traversal
    const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, '');
    const tempFileName = `${filePrefix}_${Date.now()}${safeExt}`;
    const tempFilePath = path.join(tempDir, tempFileName);

    // Validate path stays within temp directory to prevent path traversal
    const resolvedTempDir = path.resolve(tempDir);
    const resolvedFilePath = path.resolve(tempFilePath);
    if (!resolvedFilePath.startsWith(resolvedTempDir)) {
      throw new Error('Invalid temp file path detected');
    }

    // Write validated buffer to filesystem
    // This function ensures validation happens before write so CodeQL can track the data flow
    await writeValidatedFileBuffer(tempFilePath, fileBuffer, attachmentType);
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
          await notifyCommandFailure(username, 'convert', {
            operationId,
            userId,
            error: `video is too long (${Math.ceil(duration)}s)`,
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
      logOperationStep(operationId, 'conversion_start', 'running', {
        message: `Starting ${attachmentType} to GIF conversion`,
        metadata: {
          inputFile: attachment.name,
          inputSize: attachment.size,
          inputType: attachment.contentType,
          hash: hash.substring(0, 8) + '...',
        },
      });

      if (attachmentType === 'video') {
        // Build conversion options, using provided options, user config, or defaults
        const conversionOptions = {
          width:
            options.width ??
            (userConfig.width !== null ? userConfig.width : Math.min(MAX_GIF_WIDTH, 480)),
          fps: options.fps ?? (userConfig.fps !== null ? userConfig.fps : DEFAULT_FPS),
          quality: options.quality ?? (userConfig.quality !== null ? userConfig.quality : 'high'),
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
              await notifyCommandFailure(username, 'convert', {
                operationId,
                userId,
                error: `requested timeframe exceeds video length`,
              });
              return;
            }
          } catch (error) {
            logger.warn('Failed to get video metadata for timeframe validation:', error.message);
            // Continue anyway, FFmpeg will handle it
          }
        }

        await convertToGif(tempFilePath, gifPath, conversionOptions);
        logOperationStep(operationId, 'conversion_complete', 'success', {
          message: 'Video to GIF conversion completed',
          metadata: {
            conversionOptions,
            outputPath: gifPath,
          },
        });
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
              logOperationStep(operationId, 'conversion_complete', 'success', {
                message: 'GIF copied directly (within size limits)',
                metadata: { gifWidth, maxWidth: MAX_GIF_WIDTH },
              });
            } else {
              // GIF exceeds size limits or custom width requested, resize with convertImageToGif
              logger.info(
                `Input GIF exceeds size limits or custom width requested (${gifWidth || 'unknown'}px), resizing to ${targetWidth}px`
              );
              await convertImageToGif(tempFilePath, gifPath, {
                width: targetWidth,
                quality:
                  options.quality ?? (userConfig.quality !== null ? userConfig.quality : 'high'),
              });
              logOperationStep(operationId, 'conversion_complete', 'success', {
                message: 'GIF resized and converted',
                metadata: { originalWidth: gifWidth, targetWidth },
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
                options.quality ?? (userConfig.quality !== null ? userConfig.quality : 'high'),
            });
            logOperationStep(operationId, 'conversion_complete', 'success', {
              message: 'Image to GIF conversion completed (fallback)',
            });
          }
        } else {
          // Not a GIF, proceed with normal conversion
          await convertImageToGif(tempFilePath, gifPath, {
            width:
              options.width ??
              (userConfig.width !== null ? userConfig.width : Math.min(MAX_GIF_WIDTH, 720)),
            quality: options.quality ?? (userConfig.quality !== null ? userConfig.quality : 'high'),
          });
          logOperationStep(operationId, 'conversion_complete', 'success', {
            message: 'Image to GIF conversion completed',
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
    let optimizedSize = originalSize;
    let wasAutoOptimized = false;
    let finalGifUrl = null;
    let finalGifBuffer = gifBuffer;
    let finalUploadMethod = 'r2';

    // Only upload initial GIF to R2 if optimization is NOT going to happen
    // (if optimization or auto-optimization is enabled, we'll upload the optimized version instead)
    // If lossy is provided, treat it as an implicit optimization request
    const shouldOptimize =
      options.optimize || (options.lossy !== undefined && options.lossy !== null);
    const willOptimize = shouldOptimize || userConfig.autoOptimize;
    if (!willOptimize) {
      try {
        const saveResult = await saveGif(gifBuffer, hash, GIF_STORAGE_PATH, buildMetadata());
        finalGifUrl = saveResult.url;
        finalGifBuffer = saveResult.buffer;
        finalUploadMethod = saveResult.method;
      } catch (error) {
        logger.warn(`Failed to upload initial GIF to R2, continuing:`, error.message);
      }
    }

    if (shouldOptimize) {
      logOperationStep(operationId, 'optimization_start', 'running', {
        message: 'Starting GIF optimization',
        metadata: {
          originalSize,
          lossy: options.lossy !== undefined && options.lossy !== null ? options.lossy : null,
        },
      });

      // Generate hash for optimized file (include lossy level in hash for uniqueness)
      const optimizedHash = crypto.createHash('sha256');
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
        // Upload optimized version to R2 if not already there
        const saveResult = await saveGif(
          optimizedBuffer,
          optimizedHashValue,
          GIF_STORAGE_PATH,
          buildMetadata()
        );
        finalGifUrl = saveResult.url;
        finalGifBuffer = saveResult.buffer;
        finalUploadMethod = saveResult.method;
        logOperationStep(operationId, 'optimization_complete', 'success', {
          message: 'Optimized GIF found in cache',
          metadata: {
            originalSize,
            optimizedSize,
            reduction: `${((1 - optimizedSize / originalSize) * 100).toFixed(1)}%`,
          },
        });
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
        // Upload optimized version to R2
        const saveResult = await saveGif(
          optimizedBuffer,
          optimizedHashValue,
          GIF_STORAGE_PATH,
          buildMetadata()
        );
        finalGifUrl = saveResult.url;
        finalGifBuffer = saveResult.buffer;
        finalUploadMethod = saveResult.method;
        logOperationStep(operationId, 'optimization_complete', 'success', {
          message: 'GIF optimization completed',
          metadata: {
            originalSize,
            optimizedSize,
            reduction: `${((1 - optimizedSize / originalSize) * 100).toFixed(1)}%`,
          },
        });
      }
    } else if (userConfig.autoOptimize) {
      // Auto-optimize if enabled in user config
      const optimizedHash = crypto.createHash('sha256');
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
        wasAutoOptimized = true;
        // Upload optimized version to R2 if not already there
        const saveResult = await saveGif(
          optimizedBuffer,
          optimizedHashValue,
          GIF_STORAGE_PATH,
          buildMetadata()
        );
        finalGifUrl = saveResult.url;
        finalGifBuffer = saveResult.buffer;
        finalUploadMethod = saveResult.method;
      } else {
        // Auto-optimize the GIF with default lossy level
        logger.info(`Auto-optimizing GIF: ${gifPath} -> ${optimizedGifPath} (lossy: 35)`);
        await optimizeGif(gifPath, optimizedGifPath, { lossy: 35 });

        // Read optimized file and get its size
        const optimizedBuffer = await fs.readFile(optimizedGifPath);
        optimizedSize = optimizedBuffer.length;
        finalHash = optimizedHashValue;
        wasAutoOptimized = true;
        // Upload optimized version to R2
        const saveResult = await saveGif(
          optimizedBuffer,
          optimizedHashValue,
          GIF_STORAGE_PATH,
          buildMetadata()
        );
        finalGifUrl = saveResult.url;
        finalGifBuffer = saveResult.buffer;
        finalUploadMethod = saveResult.method;
      }
    }

    // Generate final URL - use R2 URL if available, otherwise construct from CDN_BASE_URL
    let gifUrl;
    if (finalGifUrl && (finalGifUrl.startsWith('http://') || finalGifUrl.startsWith('https://'))) {
      // Already an R2 URL
      gifUrl = finalGifUrl;
    } else if (finalGifUrl) {
      // Local path, construct URL
      const filename = path.basename(finalGifUrl);
      gifUrl = `${CDN_BASE_URL}/${filename}`;
    } else {
      // Fallback to constructing URL from CDN_BASE_URL
      gifUrl = `${CDN_BASE_URL}/${finalHash}.gif`;
    }

    // Track recent conversion
    trackRecentConversion(userId, gifUrl);

    // Record processed URL in database only for R2 uploads
    // Discord uploads are tracked separately when we capture the attachment URL
    if (finalUploadMethod === 'r2') {
      const urlHash = originalUrl ? hashUrl(originalUrl) : finalHash;
      await insertProcessedUrl(
        urlHash,
        finalHash,
        'gif',
        '.gif',
        gifUrl,
        Date.now(),
        userId,
        optimizedSize
      );
      logger.debug(`Recorded processed URL in database (urlHash: ${urlHash.substring(0, 8)}...)`);
    }

    logger.info(
      `Successfully created GIF (hash: ${finalHash}, size: ${(optimizedSize / (1024 * 1024)).toFixed(2)}MB) for user ${userId}${options.optimize ? ' [OPTIMIZED]' : ''}${wasAutoOptimized ? ' [AUTO-OPTIMIZED]' : ''}`
    );

    // Update operation to success with file size
    updateOperationStatus(operationId, 'success', { fileSize: optimizedSize });

    // Send as Discord attachment if < 8MB, otherwise send URL
    if (finalUploadMethod === 'discord') {
      const safeHash = finalHash.replace(/[^a-f0-9]/gi, '');
      const filename = `${safeHash}.gif`;
      try {
        const message = await interaction.editReply({
          files: [new AttachmentBuilder(finalGifBuffer, { name: filename })],
        });

        // Capture Discord attachment URL and save to database
        // Try to get attachments from the returned message first
        let discordUrl = null;
        if (message && message.attachments && message.attachments.size > 0) {
          const discordAttachment = message.attachments.first();
          if (discordAttachment && discordAttachment.url) {
            discordUrl = discordAttachment.url;
            logger.debug(
              `Captured Discord attachment URL from editReply response: ${discordUrl.substring(0, 60)}...`
            );
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
                logger.debug(
                  `Captured Discord attachment URL from fetched message: ${discordUrl.substring(0, 60)}...`
                );
              }
            }
          } catch (fetchError) {
            logger.warn(`Failed to fetch message to get attachment URL: ${fetchError.message}`);
          }
        }

        // Save Discord attachment URL to database if we got one
        if (discordUrl) {
          const urlHash = originalUrl ? hashUrl(originalUrl) : finalHash;
          await insertProcessedUrl(
            urlHash,
            finalHash,
            'gif',
            '.gif',
            discordUrl,
            Date.now(),
            userId,
            optimizedSize
          );
          logger.debug(
            `Recorded Discord attachment URL in database (urlHash: ${urlHash.substring(0, 8)}..., url: ${discordUrl.substring(0, 50)}...)`
          );
          logger.info(`Uploaded to Discord: ${discordUrl}`);
        } else {
          logger.warn(
            `Failed to capture Discord attachment URL - message: ${message ? 'exists' : 'null'}, attachments: ${message?.attachments?.size || 0}, messageId: ${message?.id || 'none'}`
          );
        }
      } catch (discordError) {
        // Discord upload failed, fallback to R2
        logger.warn(
          `Discord attachment upload failed, falling back to R2: ${discordError.message}`
        );
        try {
          const r2Url = await uploadGifToR2(finalGifBuffer, finalHash, r2Config, buildMetadata());

          if (r2Url) {
            // Update database with R2 URL
            const urlHash = originalUrl ? hashUrl(originalUrl) : finalHash;
            await insertProcessedUrl(
              urlHash,
              finalHash,
              'gif',
              '.gif',
              r2Url,
              Date.now(),
              userId,
              optimizedSize
            );
            await interaction.editReply({
              content: r2Url,
            });
          } else {
            // If R2 upload also fails, use the original gifUrl
            await interaction.editReply({
              content: gifUrl,
            });
          }
        } catch (r2Error) {
          logger.error(`R2 fallback upload also failed: ${r2Error.message}`);
          // Last resort: use the original gifUrl
          await interaction.editReply({
            content: gifUrl,
          });
        }
      }
    } else {
      await interaction.editReply({
        content: gifUrl,
      });
    }

    // Send success notification
    await notifyCommandSuccess(username, 'convert', { operationId, userId });

    // Record rate limit after successful conversion
    recordRateLimit(userId);
  } catch (error) {
    logger.error(`Conversion failed for user ${userId} (${interaction.user.tag}):`, error);

    // Build comprehensive error metadata
    const errorMetadata = {
      originalUrl: originalUrl || null,
      attachment: attachment
        ? {
            name: attachment.name || null,
            size: attachment.size || null,
            contentType: attachment.contentType || null,
            url: attachment.url || null,
          }
        : null,
      commandOptions: options,
      attachmentType,
      errorMessage: error.message || 'unknown error',
      errorName: error.name || 'Error',
      errorCode: error.code || null,
    };

    // Log detailed error with full context
    logOperationError(operationId, error, {
      metadata: errorMetadata,
    });

    updateOperationStatus(operationId, 'error', {
      error: error.message || 'unknown error',
      stackTrace: error.stack || null,
    });

    await interaction.editReply({
      content: error.message || 'an error occurred while converting the file.',
    });

    // Send failure notification
    await notifyCommandFailure(username, 'convert', {
      operationId,
      userId,
      error: error.message || 'unknown error',
    });
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
  const username = interaction.user.tag || interaction.user.username || 'unknown';
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
  let originalUrlForConversion = null;

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
      await notifyCommandFailure(username, 'convert');
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
      await notifyCommandFailure(username, 'convert');
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
      await notifyCommandFailure(username, 'convert');
      return;
    }

    // Defer reply since downloading may take time
    await interaction.deferReply();

    try {
      // Check if it's a cdn.gronka.p1x.dev URL and try to use local file
      const localFileCheck = await checkAndReadLocalFileFromCdnUrl(url, GIF_STORAGE_PATH);
      let useLocalFile = false;

      if (localFileCheck.exists) {
        useLocalFile = true;
        logger.info(`Using local file for cdn URL: ${localFileCheck.filePath}`);
        preDownloadedBuffer = localFileCheck.buffer;
        attachment = {
          url: url,
          name: localFileCheck.filename,
          size: localFileCheck.buffer.length,
          contentType: localFileCheck.contentType,
        };
        // Don't set originalUrlForConversion for CDN URLs (they're already processed)
      }

      if (!useLocalFile) {
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
            await notifyCommandFailure(username, 'convert');
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
        // Store original URL for database tracking
        originalUrlForConversion = actualUrl;
      }

      // Determine attachment type based on content type
      if (attachment.contentType && ALLOWED_VIDEO_TYPES.includes(attachment.contentType)) {
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
          await notifyCommandFailure(username, 'convert');
          return;
        }
      } else if (attachment.contentType && ALLOWED_IMAGE_TYPES.includes(attachment.contentType)) {
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
          await notifyCommandFailure(username, 'convert');
          return;
        }
      } else {
        logger.warn(`Invalid attachment type for user ${userId}`);
        await interaction.editReply({
          content:
            'unsupported file format. please provide a video (mp4, mov, webm, avi, mkv) or image (png, jpg, jpeg, webp, gif).',
        });
        await notifyCommandFailure(username, 'convert');
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
    await notifyCommandFailure(username, 'convert');
    return;
  }

  // Defer reply if not already deferred (for attachment case)
  if (!url) {
    await interaction.deferReply();
  }

  await processConversion(
    interaction,
    attachment,
    attachmentType,
    adminUser,
    preDownloadedBuffer,
    {},
    originalUrlForConversion,
    'context-menu'
  );
}

/**
 * Handle convert slash command
 * @param {Interaction} interaction - Discord interaction
 */
export async function handleConvertCommand(interaction) {
  const userId = interaction.user.id;
  const username = interaction.user.tag || interaction.user.username || 'unknown';
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
  let originalUrlForConversion = null;

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
      await notifyCommandFailure(username, 'convert');
      return;
    }

    // Defer reply since downloading may take time
    await interaction.deferReply();

    try {
      // Check if it's a cdn.gronka.p1x.dev URL and try to use local file
      const localFileCheck = await checkAndReadLocalFileFromCdnUrl(url, GIF_STORAGE_PATH);
      let useLocalFile = false;

      if (localFileCheck.exists) {
        useLocalFile = true;
        logger.info(`Using local file for cdn URL: ${localFileCheck.filePath}`);
        preDownloadedBuffer = localFileCheck.buffer;
        finalAttachment = {
          url: url,
          name: localFileCheck.filename,
          size: localFileCheck.buffer.length,
          contentType: localFileCheck.contentType,
        };
        // Don't set originalUrlForConversion for CDN URLs (they're already processed)
      }

      if (!useLocalFile) {
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
        // Store original URL for database tracking
        originalUrlForConversion = actualUrl;
      }
    } catch (error) {
      logger.error(`Failed to download file from URL for user ${userId}:`, error);
      await interaction.editReply({
        content: error.message || 'failed to download file from URL.',
      });
      await notifyCommandFailure(username, 'convert');
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
      await notifyCommandFailure(username, 'convert');
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
      await notifyCommandFailure(username, 'convert');
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
    await notifyCommandFailure(username, 'convert');
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
    },
    url ? originalUrlForConversion : null,
    'slash'
  );
}
