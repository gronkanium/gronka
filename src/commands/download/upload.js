/**
 * Upload strategy and execution for download command
 */
import { AttachmentBuilder } from 'discord.js';
import path from 'path';
import { createLogger } from '../../utils/logger.js';
import { botConfig, r2Config } from '../../utils/config.js';
import {
  uploadGifToR2,
  uploadVideoToR2,
  uploadImageToR2,
  extractR2KeyFromUrl,
  formatR2UrlWithDisclaimer,
  formatMultipleR2UrlsWithDisclaimer,
} from '../../utils/r2-storage.js';
import { trackTemporaryUpload } from '../../utils/storage.js';
import { insertProcessedUrl } from '../../utils/database.js';
import { safeInteractionEditReply } from '../../utils/interaction-helpers.js';
import { buildMetadata } from './utils.js';

const logger = createLogger('download:upload');

const { discordSizeLimit: DISCORD_SIZE_LIMIT, cdnBaseUrl: CDN_BASE_URL } = botConfig;

/**
 * Calculate which files should go to Discord vs R2 using greedy packing
 * @param {Array} mediaResults - Array of media result objects with size property
 * @returns {boolean[]} Array of booleans, true if file should go to Discord
 */
export function calculateUploadDestinations(mediaResults) {
  const totalSize = mediaResults.reduce((sum, r) => sum + r.size, 0);
  const shouldUploadToDiscord = [];

  if (totalSize < DISCORD_SIZE_LIMIT) {
    // All files fit in Discord
    logger.info(
      `Total size: ${(totalSize / (1024 * 1024)).toFixed(2)}MB, sending all files as Discord attachments`
    );
    for (let i = 0; i < mediaResults.length; i++) {
      shouldUploadToDiscord[i] = true;
    }
  } else {
    // Greedily pack files up to 8MB for Discord, rest go to R2
    let accumulatedSize = 0;
    let discordCount = 0;
    for (let i = 0; i < mediaResults.length; i++) {
      if (accumulatedSize + mediaResults[i].size < DISCORD_SIZE_LIMIT) {
        shouldUploadToDiscord[i] = true;
        accumulatedSize += mediaResults[i].size;
        discordCount++;
      } else {
        shouldUploadToDiscord[i] = false;
      }
    }
    logger.info(
      `Total size: ${(totalSize / (1024 * 1024)).toFixed(2)}MB, packing ${discordCount} file(s) for Discord (${(accumulatedSize / (1024 * 1024)).toFixed(2)}MB), ${mediaResults.length - discordCount} file(s) for R2`
    );
  }

  return shouldUploadToDiscord;
}

/**
 * Re-upload a locally saved file to R2
 * @param {Object} result - Media result object
 * @param {number} index - Index for logging
 * @param {string} userId - User ID for metadata
 * @param {string} username - Username for metadata
 * @returns {Promise<string|null>} R2 URL or null on failure
 */
export async function reuploadToR2(result, index, userId, username) {
  logger.info(
    `Re-uploading media ${index + 1} to R2 (hash: ${result.hash}, type: ${result.fileType})`
  );

  const metadata = buildMetadata(userId, username);
  let r2Url = null;

  try {
    if (result.fileType === 'video') {
      r2Url = await uploadVideoToR2(result.buffer, result.hash, result.ext, r2Config, metadata);
    } else if (result.fileType === 'image') {
      r2Url = await uploadImageToR2(result.buffer, result.hash, result.ext, r2Config, metadata);
    } else if (result.fileType === 'gif') {
      r2Url = await uploadGifToR2(result.buffer, result.hash, r2Config, metadata);
    }

    if (r2Url) {
      logger.info(`Successfully re-uploaded media ${index + 1} to R2: ${r2Url}`);
    }
  } catch (error) {
    logger.error(`Failed to re-upload media ${index + 1} to R2: ${error.message}`);
  }

  return r2Url;
}

/**
 * Send multiple media files to Discord (some as attachments, some as R2 URLs)
 * @param {Object} interaction - Discord interaction
 * @param {Array} mediaResults - Array of media result objects
 * @param {boolean[]} shouldUploadToDiscord - Array indicating upload destinations
 * @param {string} urlHash - URL hash for database recording
 * @param {string} userId - User ID
 * @param {boolean} adminUser - Whether user is admin
 * @returns {Promise<void>}
 */
export async function sendMultipleMedia(
  interaction,
  mediaResults,
  shouldUploadToDiscord,
  urlHash,
  userId,
  adminUser
) {
  // Separate files by intended upload method
  const discordFiles = mediaResults.filter((_, i) => shouldUploadToDiscord[i]);
  const r2Files = mediaResults.filter((_, i) => !shouldUploadToDiscord[i]);

  // Prepare Discord attachments
  const attachments = discordFiles.map(result => {
    const safeHash = result.hash.replace(/[^a-f0-9]/gi, '');
    const filename = `${safeHash}${result.ext}`;
    return new AttachmentBuilder(result.buffer, { name: filename });
  });

  // Prepare R2 URLs with single disclaimer
  const r2Urls = r2Files.map(r => r.url);
  const content = formatMultipleR2UrlsWithDisclaimer(r2Urls, r2Config, adminUser);

  // Send single message with both attachments and URLs
  logger.info(
    `Sending message with ${attachments.length} Discord attachment(s) and ${r2Urls.length} R2 URL(s)`
  );
  const message = await safeInteractionEditReply(interaction, {
    files: attachments.length > 0 ? attachments : undefined,
    content: content || undefined,
  });

  // Capture Discord attachment URLs for database tracking
  if (message && message.attachments && message.attachments.size > 0) {
    const attachmentArray = Array.from(message.attachments.values());
    for (let i = 0; i < discordFiles.length && i < attachmentArray.length; i++) {
      const discordAttachment = attachmentArray[i];
      if (discordAttachment && discordAttachment.url) {
        await insertProcessedUrl(
          urlHash,
          discordFiles[i].hash,
          discordFiles[i].fileType,
          discordFiles[i].ext,
          discordAttachment.url,
          Date.now(),
          userId,
          discordFiles[i].size
        );
      }
    }
  }

  // Record R2 uploads in database
  for (const result of r2Files) {
    await insertProcessedUrl(
      urlHash,
      result.hash,
      result.fileType,
      result.ext,
      result.url,
      Date.now(),
      userId,
      result.size
    );

    // Track temporary upload
    const r2Key = extractR2KeyFromUrl(result.url, r2Config);
    if (r2Key) {
      await trackTemporaryUpload(urlHash, r2Key, null, adminUser);
    }
  }
}

/**
 * Send a single file to Discord with R2 fallback
 * @param {Object} params - Parameters object
 * @param {Object} params.interaction - Discord interaction
 * @param {Buffer} params.buffer - File buffer
 * @param {string} params.hash - File hash
 * @param {string} params.ext - File extension
 * @param {string} params.fileType - File type
 * @param {string} params.fileUrl - CDN/R2 URL for fallback
 * @param {string} params.urlHash - URL hash for database
 * @param {string} params.userId - User ID
 * @param {string} params.username - Username
 * @param {number} params.fileSize - File size in bytes
 * @param {boolean} params.adminUser - Whether user is admin
 * @returns {Promise<void>}
 */
export async function sendSingleFileToDiscord({
  interaction,
  buffer,
  hash,
  ext,
  fileType,
  fileUrl,
  urlHash,
  userId,
  username,
  fileSize,
  adminUser,
}) {
  const safeHash = hash.replace(/[^a-f0-9]/gi, '');
  const filename = `${safeHash}${ext}`;
  const metadata = buildMetadata(userId, username);

  try {
    const message = await safeInteractionEditReply(interaction, {
      files: [new AttachmentBuilder(buffer, { name: filename })],
    });

    // Capture Discord attachment URL
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
        if (fetchedMessage && fetchedMessage.attachments && fetchedMessage.attachments.size > 0) {
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
      await insertProcessedUrl(
        urlHash,
        hash,
        fileType,
        ext,
        discordUrl,
        Date.now(),
        userId,
        fileSize
      );
      logger.debug(
        `Updated processed URL in database with Discord URL (urlHash: ${urlHash.substring(0, 8)}...)`
      );
    }
  } catch (discordError) {
    // Discord upload failed, fallback to R2
    logger.warn(`Discord attachment upload failed, falling back to R2: ${discordError.message}`);
    await handleR2Fallback({
      interaction,
      buffer,
      hash,
      ext,
      fileType,
      fileUrl,
      urlHash,
      userId,
      fileSize,
      adminUser,
      metadata,
    });
  }
}

/**
 * Handle fallback to R2 when Discord upload fails
 * @param {Object} params - Parameters object
 * @returns {Promise<void>}
 */
async function handleR2Fallback({
  interaction,
  buffer,
  hash,
  ext,
  fileType,
  fileUrl,
  urlHash,
  userId,
  fileSize,
  adminUser,
  metadata,
}) {
  try {
    let r2Url = null;
    if (fileType === 'gif') {
      r2Url = await uploadGifToR2(buffer, hash, r2Config, metadata);
    } else if (fileType === 'video') {
      r2Url = await uploadVideoToR2(buffer, hash, ext, r2Config, metadata);
    } else if (fileType === 'image') {
      r2Url = await uploadImageToR2(buffer, hash, ext, r2Config, metadata);
    }

    if (r2Url) {
      await insertProcessedUrl(urlHash, hash, fileType, ext, r2Url, Date.now(), userId, fileSize);
      const r2Key = extractR2KeyFromUrl(r2Url, r2Config);
      if (r2Key) {
        await trackTemporaryUpload(urlHash, r2Key, null, adminUser);
      }
      await safeInteractionEditReply(interaction, {
        content: formatR2UrlWithDisclaimer(r2Url, r2Config, adminUser),
      });
    } else {
      // If R2 upload also fails, use the original fileUrl
      await safeInteractionEditReply(interaction, {
        content: formatR2UrlWithDisclaimer(fileUrl, r2Config, adminUser),
      });
    }
  } catch (r2Error) {
    logger.error(`R2 fallback upload also failed: ${r2Error.message}`);
    await safeInteractionEditReply(interaction, {
      content: formatR2UrlWithDisclaimer(fileUrl, r2Config, adminUser),
    });
  }
}

/**
 * Build file URL from path (R2 or local)
 * @param {string} filePath - File path (could be R2 URL or local path)
 * @param {string} cdnPath - CDN path prefix ('/gifs', '/videos', '/images')
 * @returns {string} Public URL
 */
export function buildFileUrl(filePath, cdnPath) {
  if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
    return filePath;
  }
  const filename = path.basename(filePath);
  return `${CDN_BASE_URL.replace('/gifs', cdnPath)}/${filename}`;
}
