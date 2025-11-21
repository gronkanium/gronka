import {
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from '../utils/logger.js';
import { botConfig } from '../utils/config.js';
import { validateUrl } from '../utils/validation.js';
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
import { createOperation, updateOperationStatus } from '../utils/operations-tracker.js';
import { notifyCommandSuccess, notifyCommandFailure } from '../utils/ntfy-notifier.js';

const logger = createLogger('optimize');

const { gifStoragePath: GIF_STORAGE_PATH, cdnBaseUrl: CDN_BASE_URL } = botConfig;

/**
 * Process GIF optimization
 * @param {Interaction} interaction - Discord interaction
 * @param {Attachment} attachment - Discord attachment (GIF file)
 * @param {boolean} adminUser - Whether the user is an admin
 * @param {Buffer} [preDownloadedBuffer] - Optional pre-downloaded buffer
 * @param {number} [lossyLevel] - Lossy compression level (0-100, default: 35)
 */
export async function processOptimization(
  interaction,
  attachment,
  adminUser,
  preDownloadedBuffer = null,
  lossyLevel = null
) {
  const userId = interaction.user.id;
  const username = interaction.user.tag || interaction.user.username || 'unknown';
  const tempFiles = [];

  // Create operation tracking
  const operationId = createOperation('optimize', userId, username);

  // Build metadata object for R2 uploads
  const buildMetadata = () => ({
    'user-id': userId,
    'upload-timestamp': new Date().toISOString(),
    'operation-type': 'optimize',
    username: username,
  });

  try {
    // Update operation to running
    updateOperationStatus(operationId, 'running');

    // Download file if not already downloaded
    let fileBuffer = preDownloadedBuffer;
    if (!fileBuffer) {
      logger.info(`Downloading GIF: ${attachment.name}`);
      fileBuffer = await downloadImage(attachment.url, adminUser);
    }

    // Generate hash for the original file
    const _originalHash = crypto.createHash('md5').update(fileBuffer).digest('hex');
    const originalSize = fileBuffer.length;

    // Save original to temp directory for optimization
    const tempDir = path.join(process.cwd(), 'temp');
    await fs.mkdir(tempDir, { recursive: true });

    const tempInputPath = path.join(tempDir, `gif_input_${Date.now()}.gif`);
    await fs.writeFile(tempInputPath, fileBuffer);
    tempFiles.push(tempInputPath);

    // Generate hash for optimized file (include lossy level in hash for uniqueness)
    const hash = crypto.createHash('md5');
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
    try {
      optimizedUrl = await saveGif(
        optimizedBuffer,
        optimizedHash,
        GIF_STORAGE_PATH,
        buildMetadata()
      );
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

    logger.info(
      `GIF optimization completed: ${originalSize} bytes -> ${optimizedSize} bytes (${reduction}% reduction) for user ${userId}`
    );

    // Update operation to success with file size
    updateOperationStatus(operationId, 'success', { fileSize: optimizedSize });

    await interaction.editReply({
      content: optimizedUrl,
    });

    // Send success notification
    await notifyCommandSuccess(username, 'optimize');

    // Record rate limit after successful optimization
    recordRateLimit(userId);
  } catch (error) {
    logger.error(`GIF optimization failed for user ${userId}:`, error);
    updateOperationStatus(operationId, 'error', { error: error.message || 'unknown error' });
    await interaction.editReply({
      content: error.message || 'an error occurred while optimizing the gif.',
    });

    // Send failure notification
    await notifyCommandFailure(username, 'optimize');
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
  const adminUser = isAdmin(userId);

  logger.info(
    `User ${userId} (${interaction.user.tag}) initiated optimization via context menu${adminUser ? ' [ADMIN]' : ''}`
  );

  // Check rate limit (admins bypass this check)
  if (checkRateLimit(userId)) {
    logger.warn(`User ${userId} (${interaction.user.tag}) is rate limited`);
    await interaction.reply({
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

  if (gifAttachment) {
    // Validate it's actually a GIF
    if (!isGifFile(gifAttachment.name, gifAttachment.contentType)) {
      logger.warn(`Attachment is not a GIF for user ${userId}`);
      await interaction.reply({
        content: 'this command only works on gif files.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    attachment = gifAttachment;
  } else if (url) {
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
            await interaction.reply({
              content: error.message || 'failed to parse Tenor URL.',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
        }

        // Download the GIF
        logger.info(`Downloading GIF from URL: ${actualUrl}`);
        const fileData = await downloadFileFromUrl(actualUrl, adminUser, interaction.client);

        // Validate it's a GIF
        if (!isGifFile(fileData.filename, fileData.contentType)) {
          await interaction.reply({
            content: 'this command only works on gif files.',
            flags: MessageFlags.Ephemeral,
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
      } else {
        // Use local file
        const stats = await fs.stat(localFilePath);
        attachment = {
          url: url,
          name: path.basename(localFilePath),
          size: stats.size,
          contentType: 'image/gif',
        };
        preDownloadedBuffer = await fs.readFile(localFilePath);
      }
    } catch (error) {
      logger.error(`Failed to process URL for user ${userId}:`, error);
      await interaction.reply({
        content: error.message || 'failed to process gif from URL.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  } else {
    logger.warn(`No GIF attachment or URL found for user ${userId}`);
    await interaction.reply({
      content: 'no gif attachment or URL found in this message.',
      flags: MessageFlags.Ephemeral,
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
    timestamp: Date.now(),
  });

  await interaction.showModal(modal);
}

/**
 * Handle optimize slash command
 * @param {Interaction} interaction - Discord interaction
 */
export async function handleOptimizeCommand(interaction) {
  const userId = interaction.user.id;
  const adminUser = isAdmin(userId);

  logger.info(
    `User ${userId} (${interaction.user.tag}) initiated optimization via slash command${adminUser ? ' [ADMIN]' : ''}`
  );

  // Check rate limit (admins bypass this check)
  if (checkRateLimit(userId)) {
    logger.warn(`User ${userId} (${interaction.user.tag}) is rate limited`);
    await interaction.reply({
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
    await interaction.reply({
      content: 'lossy level must be between 0 and 100.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!attachment && !url) {
    logger.warn(`No attachment or URL provided for user ${userId}`);
    await interaction.reply({
      content: 'please provide either a gif attachment or a URL to a gif file.',
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
  let preDownloadedBuffer = null;

  // Validate attachment is a GIF
  if (attachment) {
    if (!isGifFile(attachment.name, attachment.contentType)) {
      logger.warn(`Attachment is not a GIF for user ${userId}`);
      await interaction.reply({
        content: 'this command only works on gif files.',
        flags: MessageFlags.Ephemeral,
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
      await interaction.reply({
        content: `invalid URL: ${urlValidation.error}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Defer reply since downloading may take time
    await interaction.deferReply();

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
      } else {
        // Use local file
        const stats = await fs.stat(localFilePath);
        finalAttachment = {
          url: url,
          name: path.basename(localFilePath),
          size: stats.size,
          contentType: 'image/gif',
        };
        preDownloadedBuffer = await fs.readFile(localFilePath);
      }
    } catch (error) {
      logger.error(`Failed to download file from URL for user ${userId}:`, error);
      await interaction.editReply({
        content: error.message || 'failed to download file from URL.',
      });
      return;
    }
  }

  // Defer reply if not already deferred (for attachment case)
  if (!url) {
    await interaction.deferReply();
  }

  await processOptimization(
    interaction,
    finalAttachment,
    adminUser,
    preDownloadedBuffer,
    lossyLevel
  );
}
