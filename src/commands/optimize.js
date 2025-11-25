import {
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  AttachmentBuilder,
} from 'discord.js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from '../utils/logger.js';
import { botConfig } from '../utils/config.js';
import { validateUrl } from '../utils/validation.js';
import { ValidationError } from '../utils/errors.js';
import { downloadImage, downloadFileFromUrl, parseTenorUrl } from '../utils/file-downloader.js';
import { checkRateLimit, isAdmin, recordRateLimit } from '../utils/rate-limit.js';
import {
  isGifFile,
  extractHashFromCdnUrl,
  checkLocalGif,
  optimizeGif,
  calculateSizeReduction,
} from '../utils/gif-optimizer.js';
import { getGifPath, cleanupTempFiles, saveGif } from '../utils/storage.js';
import { uploadGifToR2 } from '../utils/r2-storage.js';
import {
  createOperation,
  updateOperationStatus,
  logOperationError,
} from '../utils/operations-tracker.js';
import { notifyCommandSuccess, notifyCommandFailure } from '../utils/ntfy-notifier.js';
import { hashUrl } from '../utils/cobalt-queue.js';
import { insertProcessedUrl, initDatabase, getProcessedUrl } from '../utils/database.js';
import { r2Config } from '../utils/config.js';

const logger = createLogger('optimize');

const { gifStoragePath: GIF_STORAGE_PATH, cdnBaseUrl: CDN_BASE_URL } = botConfig;

/**
 * Safely reply to an interaction with error handling
 * @param {Interaction} interaction - Discord interaction
 * @param {Object} options - Reply options
 * @returns {Promise<boolean>} True if reply was successful, false otherwise
 */
async function safeReply(interaction, options) {
  if (interaction.replied || interaction.deferred) {
    logger.debug(`Interaction already responded to, skipping reply`);
    return false;
  }

  try {
    await interaction.reply(options);
    return true;
  } catch (error) {
    // Handle expired interactions (code 10062) or already acknowledged (code 40060)
    if (error.code === 10062 || error.code === 40060) {
      logger.debug(`Interaction expired or already acknowledged: ${error.message}`);
    } else {
      logger.error(`Failed to reply to interaction:`, error);
    }
    return false;
  }
}

/**
 * Safely show a modal with error handling
 * @param {Interaction} interaction - Discord interaction
 * @param {ModalBuilder} modal - Modal to show
 * @returns {Promise<boolean>} True if modal was shown successfully, false otherwise
 */
async function safeShowModal(interaction, modal) {
  if (interaction.replied || interaction.deferred) {
    logger.debug(`Interaction already responded to, cannot show modal`);
    return false;
  }

  try {
    await interaction.showModal(modal);
    return true;
  } catch (error) {
    // Handle expired interactions (code 10062) or already acknowledged (code 40060)
    if (error.code === 10062 || error.code === 40060) {
      logger.debug(
        `Interaction expired or already acknowledged when showing modal: ${error.message}`
      );
    } else {
      logger.error(`Failed to show modal:`, error);
    }
    return false;
  }
}

// GIF file signature constants
const ALLOWED_GIF_SIGNATURES = [
  Buffer.from('GIF87a'), // GIF87a signature
  Buffer.from('GIF89a'), // GIF89a signature
];

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB limit

/**
 * Validate GIF buffer before writing to filesystem
 * Checks file signature (magic bytes), size limits, and basic structure
 * @param {Buffer} buffer - File buffer to validate
 * @throws {ValidationError} If buffer is invalid
 */
function validateGifBuffer(buffer) {
  // Check buffer exists and has minimum size
  if (!buffer || buffer.length < 6) {
    throw new ValidationError('invalid or empty file buffer');
  }

  // Check file size limit
  if (buffer.length > MAX_FILE_SIZE) {
    throw new ValidationError(
      `file too large. maximum size for gif files is ${MAX_FILE_SIZE / 1024 / 1024}mb.`
    );
  }

  // Verify GIF file signature (magic bytes)
  const signature = buffer.slice(0, 6);
  const isValidGif = ALLOWED_GIF_SIGNATURES.some(validSig => signature.equals(validSig));

  if (!isValidGif) {
    throw new ValidationError('file is not a valid gif format. please provide a gif file.');
  }

  return true;
}

/**
 * Process GIF optimization
 * @param {Interaction} interaction - Discord interaction
 * @param {Attachment} attachment - Discord attachment (GIF file)
 * @param {boolean} adminUser - Whether the user is an admin
 * @param {Buffer} [preDownloadedBuffer] - Optional pre-downloaded buffer
 * @param {number} [lossyLevel] - Lossy compression level (0-100, default: 35)
 * @param {string} [originalUrl] - Original URL if this optimization came from a URL (not Discord attachment or CDN)
 * @param {string} [commandSource] - Command source ('slash' or 'context-menu')
 */
export async function processOptimization(
  interaction,
  attachment,
  adminUser,
  preDownloadedBuffer = null,
  lossyLevel = null,
  originalUrl = null,
  commandSource = null
) {
  const userId = interaction.user.id;
  const username = interaction.user.tag || interaction.user.username || 'unknown';
  const tempFiles = [];

  // Build operation context
  const operationContext = {
    commandOptions: { lossy: lossyLevel },
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
  const operationId = createOperation('optimize', userId, username, operationContext);

  // Build metadata object for R2 uploads
  const buildMetadata = () => ({
    'user-id': userId,
    'upload-timestamp': new Date().toISOString(),
    'operation-type': 'optimize',
    username: username,
  });

  try {
    // Initialize database if needed (for URL tracking)
    if (originalUrl) {
      await initDatabase();
    }

    // Update operation to running
    updateOperationStatus(operationId, 'running');

    // Check if URL has already been processed (only for external URL-based optimizations)
    if (originalUrl) {
      const urlHash = hashUrl(originalUrl);
      const processedUrl = await getProcessedUrl(urlHash);
      if (processedUrl) {
        logger.info(
          `URL already processed (hash: ${urlHash.substring(0, 8)}...), returning existing file URL: ${processedUrl.file_url}`
        );
        updateOperationStatus(operationId, 'success', { fileSize: 0 });
        recordRateLimit(userId);
        await interaction.editReply({
          content: processedUrl.file_url,
        });
        await notifyCommandSuccess(username, 'optimize', { operationId, userId });
        return;
      }
    }

    // Download file if not already downloaded
    let fileBuffer = preDownloadedBuffer;
    if (!fileBuffer) {
      logger.info(`Downloading GIF: ${attachment.name}`);
      fileBuffer = await downloadImage(attachment.url, adminUser);
    }

    // Generate hash for the original file
    const _originalHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const originalSize = fileBuffer.length;

    // Save original to temp directory for optimization
    const tempDir = path.join(process.cwd(), 'temp');
    await fs.mkdir(tempDir, { recursive: true });

    // Generate safe temp file path - validate to prevent path injection
    const tempFileName = `gif_input_${Date.now()}.gif`;
    const tempInputPath = path.join(tempDir, tempFileName);

    // Validate path stays within temp directory to prevent path traversal
    const resolvedTempDir = path.resolve(tempDir);
    const resolvedInputPath = path.resolve(tempInputPath);
    if (!resolvedInputPath.startsWith(resolvedTempDir)) {
      throw new Error('Invalid temp file path detected');
    }

    // Validate file buffer before writing to filesystem
    try {
      validateGifBuffer(fileBuffer);
    } catch (error) {
      if (error instanceof ValidationError) {
        throw error;
      }
      throw new ValidationError('file validation failed: ' + error.message);
    }

    // Write validated buffer to filesystem
    // fileBuffer is validated above via validateGifBuffer() which ensures:
    // - Buffer is a valid GIF file (magic bytes check)
    // - File size is within limits
    // - Buffer structure is valid
    // Only validated network data is written to filesystem
    const validatedBuffer = fileBuffer;
    await fs.writeFile(tempInputPath, validatedBuffer);
    tempFiles.push(tempInputPath);

    // Generate hash for optimized file (include lossy level in hash for uniqueness)
    const hash = crypto.createHash('sha256');
    hash.update(fileBuffer);
    hash.update('optimized');
    if (lossyLevel !== null) {
      hash.update(lossyLevel.toString());
    }
    const optimizedHash = hash.digest('hex');
    const optimizedGifPath = getGifPath(optimizedHash, GIF_STORAGE_PATH);

    // Optimize the GIF with specified lossy level
    const optimizeOptions = lossyLevel !== null ? { lossy: lossyLevel } : {};
    logger.info(
      `Optimizing GIF: ${tempInputPath} -> ${optimizedGifPath}${lossyLevel !== null ? ` (lossy: ${lossyLevel})` : ''}`
    );
    await optimizeGif(tempInputPath, optimizedGifPath, optimizeOptions);

    // Read optimized file and get its size
    const optimizedBuffer = await fs.readFile(optimizedGifPath);
    const optimizedSize = optimizedBuffer.length;

    // Upload optimized GIF to R2 if configured (this will also handle local storage)
    let optimizedUrl;
    let optimizedUploadMethod = 'r2';
    try {
      const saveResult = await saveGif(
        optimizedBuffer,
        optimizedHash,
        GIF_STORAGE_PATH,
        buildMetadata()
      );
      optimizedUrl = saveResult.url;
      optimizedUploadMethod = saveResult.method;
      // If R2 is configured, saveGif returns the R2 URL, otherwise it returns the local path
      if (!optimizedUrl.startsWith('http://') && !optimizedUrl.startsWith('https://')) {
        // Local path, construct URL
        const filename = path.basename(optimizedGifPath);
        optimizedUrl = `${CDN_BASE_URL}/${filename}`;
      }
    } catch (error) {
      logger.warn(`Failed to upload optimized GIF to R2, using local path:`, error.message);
      // Fallback to local URL
      const filename = path.basename(optimizedGifPath);
      optimizedUrl = `${CDN_BASE_URL}/${filename}`;
    }

    // Calculate size reduction
    const reduction = calculateSizeReduction(originalSize, optimizedSize);

    // Record processed URL in database for all optimizations
    // For URL-based operations, use hash of original URL; for attachments, use file hash
    const urlHash = originalUrl ? hashUrl(originalUrl) : optimizedHash;
    await insertProcessedUrl(
      urlHash,
      optimizedHash,
      'gif',
      '.gif',
      optimizedUrl,
      Date.now(),
      userId,
      optimizedSize
    );
    logger.debug(`Recorded processed URL in database (urlHash: ${urlHash.substring(0, 8)}...)`);

    logger.info(
      `GIF optimization completed: ${originalSize} bytes -> ${optimizedSize} bytes (${reduction}% reduction) for user ${userId}`
    );

    // Update operation to success with file size
    updateOperationStatus(operationId, 'success', { fileSize: optimizedSize });

    // Send as Discord attachment if < 8MB, otherwise send URL
    if (optimizedUploadMethod === 'discord') {
      const safeHash = optimizedHash.replace(/[^a-f0-9]/gi, '');
      const filename = `${safeHash}.gif`;
      try {
        await interaction.editReply({
          files: [new AttachmentBuilder(optimizedBuffer, { name: filename })],
        });
      } catch (discordError) {
        // Discord upload failed, fallback to R2
        logger.warn(
          `Discord attachment upload failed, falling back to R2: ${discordError.message}`
        );
        try {
          const r2Url = await uploadGifToR2(
            optimizedBuffer,
            optimizedHash,
            r2Config,
            buildMetadata()
          );

          if (r2Url) {
            // Update database with R2 URL
            const urlHash = originalUrl ? hashUrl(originalUrl) : optimizedHash;
            await insertProcessedUrl(
              urlHash,
              optimizedHash,
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
            // If R2 upload also fails, use the original optimizedUrl
            await interaction.editReply({
              content: optimizedUrl,
            });
          }
        } catch (r2Error) {
          logger.error(`R2 fallback upload also failed: ${r2Error.message}`);
          // Last resort: use the original optimizedUrl
          await interaction.editReply({
            content: optimizedUrl,
          });
        }
      }
    } else {
      await interaction.editReply({
        content: optimizedUrl,
      });
    }

    // Send success notification
    await notifyCommandSuccess(username, 'optimize', { operationId, userId });

    // Record rate limit after successful optimization
    recordRateLimit(userId);
  } catch (error) {
    logger.error(`GIF optimization failed for user ${userId}:`, error);

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
      commandOptions: { lossy: lossyLevel },
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
      content: error.message || 'an error occurred while optimizing the gif.',
    });

    // Send failure notification
    await notifyCommandFailure(username, 'optimize', {
      operationId,
      userId,
      error: error.message || 'unknown error',
    });
  } finally {
    // Clean up temp files
    await cleanupTempFiles(tempFiles);
  }
}

/**
 * Handle optimize context menu command
 * @param {Interaction} interaction - Discord interaction
 * @param {Map} modalAttachmentCache - Cache for modal attachment data
 */
export async function handleOptimizeContextMenuCommand(interaction, modalAttachmentCache) {
  if (!interaction.isMessageContextMenuCommand()) {
    return;
  }

  if (interaction.commandName !== 'optimize') {
    return;
  }

  const userId = interaction.user.id;
  const username = interaction.user.tag || interaction.user.username || 'unknown';
  const adminUser = isAdmin(userId);

  logger.info(
    `User ${userId} (${interaction.user.tag}) initiated optimization via context menu${adminUser ? ' [ADMIN]' : ''}`
  );

  // Check rate limit (admins bypass this check)
  if (checkRateLimit(userId)) {
    logger.warn(`User ${userId} (${interaction.user.tag}) is rate limited`);
    await safeReply(interaction, {
      content: 'please wait 30 seconds before optimizing another gif.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Get the message that was right-clicked
  const targetMessage = interaction.targetMessage;

  // Find GIF attachment
  const gifAttachment = targetMessage.attachments.find(
    att => att.contentType === 'image/gif' || (att.name && att.name.toLowerCase().endsWith('.gif'))
  );

  // Check for URLs in message content if no attachment found
  let url = null;
  if (!gifAttachment && targetMessage.content) {
    // Extract URLs from message content
    const urlPattern = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
    const urls = targetMessage.content.match(urlPattern);
    if (urls && urls.length > 0) {
      url = urls[0]; // Use the first URL found
      logger.info(`Found URL in message content: ${url}`);
    }
  }

  // Determine attachment and validate it's a GIF
  let attachment = null;
  let preDownloadedBuffer = null;
  let originalUrlForConversion = null;

  if (gifAttachment) {
    // Validate it's actually a GIF
    if (!isGifFile(gifAttachment.name, gifAttachment.contentType)) {
      logger.warn(`Attachment is not a GIF for user ${userId}`);
      await safeReply(interaction, {
        content: 'this command only works on gif files.',
        flags: MessageFlags.Ephemeral,
      });
      await notifyCommandFailure(username, 'optimize', {
        userId,
        error: 'attachment is not a GIF',
      });
      return;
    }
    attachment = gifAttachment;
  } else if (url) {
    // Validate URL format
    const urlValidation = validateUrl(url);
    if (!urlValidation.valid) {
      logger.warn(`Invalid URL for user ${userId}: ${urlValidation.error}`);
      await safeReply(interaction, {
        content: `invalid URL: ${urlValidation.error}`,
        flags: MessageFlags.Ephemeral,
      });
      await notifyCommandFailure(username, 'optimize', {
        userId,
        error: `invalid URL: ${urlValidation.error}`,
      });
      return;
    }

    try {
      // Check if it's a cdn.gronka.p1x.dev URL and try to use local file
      const hash = extractHashFromCdnUrl(url);
      let useLocalFile = false;
      let localFilePath = null;

      if (hash) {
        const exists = await checkLocalGif(hash, GIF_STORAGE_PATH);
        if (exists) {
          localFilePath = getGifPath(hash, GIF_STORAGE_PATH);
          useLocalFile = true;
          logger.info(`Using local file for cdn URL: ${localFilePath}`);
        }
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
            await safeReply(interaction, {
              content: error.message || 'failed to parse Tenor URL.',
              flags: MessageFlags.Ephemeral,
            });
            await notifyCommandFailure(username, 'optimize', {
              userId,
              error: error.message || 'failed to parse Tenor URL',
            });
            return;
          }
        }

        // Download the GIF
        logger.info(`Downloading GIF from URL: ${actualUrl}`);
        const fileData = await downloadFileFromUrl(actualUrl, adminUser, interaction.client);

        // Validate it's a GIF
        if (!isGifFile(fileData.filename, fileData.contentType)) {
          await safeReply(interaction, {
            content: 'this command only works on gif files.',
            flags: MessageFlags.Ephemeral,
          });
          await notifyCommandFailure(username, 'optimize', {
            userId,
            error: 'downloaded file is not a GIF',
          });
          return;
        }

        preDownloadedBuffer = fileData.buffer;

        // Create a pseudo-attachment object
        attachment = {
          url: url,
          name: fileData.filename,
          size: fileData.size,
          contentType: fileData.contentType,
        };
        // Store original URL for database tracking (only for external URLs, not CDN)
        originalUrlForConversion = actualUrl;
      } else {
        // Use local file (CDN URL - don't track as it's already processed)
        // Read file first to avoid race condition between stat and readFile
        preDownloadedBuffer = await fs.readFile(localFilePath);
        attachment = {
          url: url,
          name: path.basename(localFilePath),
          size: preDownloadedBuffer.length,
          contentType: 'image/gif',
        };
        // Don't set originalUrlForConversion for CDN URLs
      }
    } catch (error) {
      logger.error(`Failed to process URL for user ${userId}:`, error);
      await safeReply(interaction, {
        content: error.message || 'failed to process gif from URL.',
        flags: MessageFlags.Ephemeral,
      });
      await notifyCommandFailure(username, 'optimize', {
        userId,
        error: error.message || 'failed to process gif from URL',
      });
      return;
    }
  } else {
    logger.warn(`No GIF attachment or URL found for user ${userId}`);
    await safeReply(interaction, {
      content: 'no gif attachment or URL found in this message.',
      flags: MessageFlags.Ephemeral,
    });
    await notifyCommandFailure(username, 'optimize', {
      userId,
      error: 'no gif attachment or URL found',
    });
    return;
  }

  // Show modal to get lossy level
  const modal = new ModalBuilder()
    .setCustomId(`optimize_modal_${Date.now()}`)
    .setTitle('optimize gif');

  const lossyInput = new TextInputBuilder()
    .setCustomId('lossy_level')
    .setLabel('lossy level (0-100, default: 35)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('35')
    .setRequired(false)
    .setMaxLength(3);

  const actionRow = new ActionRowBuilder().addComponents(lossyInput);
  modal.addComponents(actionRow);

  // Store attachment info for modal submission
  const modalId = modal.data.custom_id;
  modalAttachmentCache.set(modalId, {
    attachment,
    attachmentType: 'gif',
    adminUser,
    preDownloadedBuffer,
    originalUrl: originalUrlForConversion,
    timestamp: Date.now(),
  });

  const modalShown = await safeShowModal(interaction, modal);
  if (!modalShown) {
    // If modal couldn't be shown, clean up cache entry
    modalAttachmentCache.delete(modalId);
    logger.warn(`Failed to show modal for user ${userId}, cleaned up cache entry`);
  }
}

/**
 * Handle optimize slash command
 * @param {Interaction} interaction - Discord interaction
 */
export async function handleOptimizeCommand(interaction) {
  const userId = interaction.user.id;
  const username = interaction.user.tag || interaction.user.username || 'unknown';
  const adminUser = isAdmin(userId);

  logger.info(
    `User ${userId} (${interaction.user.tag}) initiated optimization via slash command${adminUser ? ' [ADMIN]' : ''}`
  );

  // Check rate limit (admins bypass this check)
  if (checkRateLimit(userId)) {
    logger.warn(`User ${userId} (${interaction.user.tag}) is rate limited`);
    await safeReply(interaction, {
      content: 'please wait 30 seconds before optimizing another gif.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Get attachment or URL from command options
  const attachment = interaction.options.getAttachment('file');
  const url = interaction.options.getString('url');
  const lossyLevel = interaction.options.getNumber('lossy');

  // Validate lossy level if provided
  if (lossyLevel !== null && (lossyLevel < 0 || lossyLevel > 100)) {
    await safeReply(interaction, {
      content: 'lossy level must be between 0 and 100.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!attachment && !url) {
    logger.warn(`No attachment or URL provided for user ${userId}`);
    await safeReply(interaction, {
      content: 'please provide either a gif attachment or a URL to a gif file.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (attachment && url) {
    logger.warn(`Both attachment and URL provided for user ${userId}`);
    await safeReply(interaction, {
      content: 'please provide either a file attachment or a URL, not both.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let finalAttachment = attachment;
  let preDownloadedBuffer = null;
  let originalUrlForConversion = null;

  // Validate attachment is a GIF
  if (attachment) {
    if (!isGifFile(attachment.name, attachment.contentType)) {
      logger.warn(`Attachment is not a GIF for user ${userId}`);
      await safeReply(interaction, {
        content: 'this command only works on gif files.',
        flags: MessageFlags.Ephemeral,
      });
      await notifyCommandFailure(username, 'optimize', {
        userId,
        error: 'attachment is not a GIF',
      });
      return;
    }
  }

  // If URL is provided, download the file first
  if (url) {
    // Validate URL format and protocol (strict validation)
    const urlValidation = validateUrl(url);
    if (!urlValidation.valid) {
      logger.warn(`Invalid URL for user ${userId}: ${urlValidation.error}`);
      await safeReply(interaction, {
        content: `invalid URL: ${urlValidation.error}`,
        flags: MessageFlags.Ephemeral,
      });
      await notifyCommandFailure(username, 'optimize', {
        userId,
        error: `invalid URL: ${urlValidation.error}`,
      });
      return;
    }

    // Check if interaction is already responded to or expired before deferring
    if (interaction.replied || interaction.deferred) {
      logger.debug(`Interaction already responded to before deferring in handleOptimizeCommand`);
      return;
    }

    // Defer reply since downloading may take time
    try {
      await interaction.deferReply();
    } catch (error) {
      // Handle expired interactions (code 10062) or already acknowledged (code 40060)
      if (error.code === 10062 || error.code === 40060) {
        logger.debug(
          `Interaction expired or already acknowledged when deferring: ${error.message}`
        );
      } else {
        logger.error(`Failed to defer reply:`, error);
      }
      return;
    }

    try {
      // Check if it's a cdn.gronka.p1x.dev URL and try to use local file
      const hash = extractHashFromCdnUrl(url);
      let useLocalFile = false;
      let localFilePath = null;

      if (hash) {
        const exists = await checkLocalGif(hash, GIF_STORAGE_PATH);
        if (exists) {
          localFilePath = getGifPath(hash, GIF_STORAGE_PATH);
          useLocalFile = true;
          logger.info(`Using local file for cdn URL: ${localFilePath}`);
        }
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
            await notifyCommandFailure(username, 'optimize', {
              userId,
              error: error.message || 'failed to parse Tenor URL',
            });
            return;
          }
        }

        // Download the GIF
        logger.info(`Downloading GIF from URL: ${actualUrl}`);
        const fileData = await downloadFileFromUrl(actualUrl, adminUser, interaction.client);

        // Validate it's a GIF
        if (!isGifFile(fileData.filename, fileData.contentType)) {
          await interaction.editReply({
            content: 'this command only works on gif files.',
          });
          await notifyCommandFailure(username, 'optimize', {
            userId,
            error: 'downloaded file is not a GIF',
          });
          return;
        }

        preDownloadedBuffer = fileData.buffer;

        // Create a pseudo-attachment object
        finalAttachment = {
          url: url,
          name: fileData.filename,
          size: fileData.size,
          contentType: fileData.contentType,
        };
        // Store original URL for database tracking (only for external URLs, not CDN)
        originalUrlForConversion = actualUrl;
      } else {
        // Use local file (CDN URL - don't track as it's already processed)
        // Read file first to avoid race condition between stat and readFile
        preDownloadedBuffer = await fs.readFile(localFilePath);
        finalAttachment = {
          url: url,
          name: path.basename(localFilePath),
          size: preDownloadedBuffer.length,
          contentType: 'image/gif',
        };
        // Don't set originalUrlForConversion for CDN URLs
      }
    } catch (error) {
      logger.error(`Failed to download file from URL for user ${userId}:`, error);
      await interaction.editReply({
        content: error.message || 'failed to download file from URL.',
      });
      await notifyCommandFailure(username, 'optimize', {
        userId,
        error: error.message || 'failed to download file from URL',
      });
      return;
    }
  }

  // Defer reply if not already deferred (for attachment case)
  if (!url) {
    // Check if interaction is already responded to or expired before deferring
    if (interaction.replied || interaction.deferred) {
      logger.debug(
        `Interaction already responded to before deferring in handleOptimizeCommand (attachment case)`
      );
      return;
    }

    try {
      await interaction.deferReply();
    } catch (error) {
      // Handle expired interactions (code 10062) or already acknowledged (code 40060)
      if (error.code === 10062 || error.code === 40060) {
        logger.debug(
          `Interaction expired or already acknowledged when deferring (attachment case): ${error.message}`
        );
      } else {
        logger.error(`Failed to defer reply (attachment case):`, error);
      }
      return;
    }
  }

  await processOptimization(
    interaction,
    finalAttachment,
    adminUser,
    preDownloadedBuffer,
    lossyLevel,
    originalUrlForConversion,
    'slash'
  );
}
