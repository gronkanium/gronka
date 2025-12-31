/**
 * Discord command handlers for download command
 */
import { MessageFlags } from 'discord.js';
import { createLogger } from '../../utils/logger.js';
import { botConfig } from '../../utils/config.js';
import { validateUrl } from '../../utils/validation.js';
import { isSocialMediaUrl } from '../../utils/cobalt.js';
import { isYouTubeUrl } from '../../utils/ytdlp.js';
import { checkRateLimit, isAdmin } from '../../utils/rate-limit.js';
import { createFailedOperation } from '../../utils/operations-tracker.js';
import { notifyCommandFailure } from '../../utils/ntfy-notifier.js';
import {
  safeInteractionReply,
  safeInteractionDeferReply,
} from '../../utils/interaction-helpers.js';
import { processDownload } from './process-download.js';

const logger = createLogger('download:handlers');

const { rateLimitCooldown, cobaltEnabled: COBALT_ENABLED, ytdlpEnabled: YTDLP_ENABLED } = botConfig;

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

  // Check rate limit
  if (checkRateLimit(userId)) {
    logger.warn(`User ${userId} (${interaction.user.tag}) is rate limited`);
    const rateLimitSeconds = rateLimitCooldown / 1000;
    const errorMessage = `please wait ${rateLimitSeconds} seconds before downloading another video.`;
    createFailedOperation('download', userId, username, errorMessage, 'rate_limit', {
      commandSource: 'context-menu',
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Get the message that was right-clicked
  const targetMessage = interaction.targetMessage;

  // Extract URLs from message content
  let url = null;
  if (targetMessage.content) {
    const urlPattern = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
    const urls = targetMessage.content.match(urlPattern);
    if (urls && urls.length > 0) {
      url = urls[0];
      logger.info(`Found URL in message content: ${url}`);
    }
  }

  // Check if URL was found
  if (!url) {
    logger.warn(`No URL found in message for user ${userId}`);
    const errorMessage = 'no URL found in this message.';
    createFailedOperation('download', userId, username, errorMessage, 'missing_url', {
      commandSource: 'context-menu',
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    await notifyCommandFailure(username, 'download', { userId, error: errorMessage });
    return;
  }

  // Validate URL format
  const urlValidation = validateUrl(url);
  if (!urlValidation.valid) {
    logger.warn(`Invalid URL for user ${userId}: ${urlValidation.error}`);
    await safeInteractionReply(interaction, {
      content: `invalid URL: ${urlValidation.error}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Check download method availability
  const validationResult = validateDownloadMethod(url, userId, username);
  if (!validationResult.valid) {
    await safeInteractionReply(interaction, {
      content: validationResult.error,
      flags: MessageFlags.Ephemeral,
    });
    if (validationResult.notify) {
      await notifyCommandFailure(username, 'download', { userId, error: validationResult.error });
    }
    return;
  }

  // Defer reply and process
  await safeInteractionDeferReply(interaction);
  await processDownload(interaction, url, 'context-menu');
}

/**
 * Handle download slash command
 * @param {Interaction} interaction - Discord interaction
 */
export async function handleDownloadCommand(interaction) {
  const userId = interaction.user.id;
  const username = interaction.user.tag || interaction.user.username || 'unknown';
  const adminUser = isAdmin(userId);

  logger.info(
    `User ${userId} (${interaction.user.tag}) initiated download${adminUser ? ' [ADMIN]' : ''}`
  );

  // Check rate limit
  if (checkRateLimit(userId)) {
    logger.warn(`User ${userId} (${interaction.user.tag}) is rate limited`);
    const rateLimitSeconds = rateLimitCooldown / 1000;
    const errorMessage = `please wait ${rateLimitSeconds} seconds before downloading another video.`;
    createFailedOperation('download', userId, username, errorMessage, 'rate_limit', {
      commandSource: 'slash',
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Get command options
  const url = interaction.options.getString('url');
  const startTime = interaction.options.getNumber('start_time');
  const endTime = interaction.options.getNumber('end_time');

  // Validate time parameters
  if (startTime !== null && endTime !== null && endTime <= startTime) {
    logger.warn(
      `Invalid time range for user ${userId}: end_time (${endTime}) must be greater than start_time (${startTime})`
    );
    const errorMessage = 'end_time must be greater than start_time.';
    createFailedOperation('download', userId, username, errorMessage, 'invalid_time_range', {
      commandSource: 'slash',
      commandOptions: { startTime, endTime },
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Convert start_time/end_time to startTime/duration format
  let trimStartTime = null;
  let trimDuration = null;

  if (startTime !== null && endTime !== null) {
    trimStartTime = startTime;
    trimDuration = endTime - startTime;
  } else if (startTime !== null) {
    trimStartTime = startTime;
    trimDuration = null;
  } else if (endTime !== null) {
    trimStartTime = null;
    trimDuration = endTime;
  }

  if (trimStartTime !== null || trimDuration !== null) {
    logger.info(
      `Time parameters provided for download command: startTime=${trimStartTime}, duration=${trimDuration}`
    );
  }

  // Check URL
  if (!url) {
    logger.warn(`No URL provided for user ${userId}`);
    const errorMessage = 'please provide a URL to download from.';
    createFailedOperation('download', userId, username, errorMessage, 'missing_url', {
      commandSource: 'slash',
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    await notifyCommandFailure(username, 'download', { userId, error: errorMessage });
    return;
  }

  // Validate URL format
  const urlValidation = validateUrl(url);
  if (!urlValidation.valid) {
    logger.warn(`Invalid URL for user ${userId}: ${urlValidation.error}`);
    const errorMessage = `invalid URL: ${urlValidation.error}`;
    createFailedOperation('download', userId, username, errorMessage, 'invalid_url', {
      originalUrl: url,
      commandSource: 'slash',
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Check download method availability
  const validationResult = validateDownloadMethod(url, userId, username, 'slash');
  if (!validationResult.valid) {
    createFailedOperation(
      'download',
      userId,
      username,
      validationResult.error,
      validationResult.errorType,
      {
        originalUrl: url,
        commandSource: 'slash',
      }
    );
    await safeInteractionReply(interaction, {
      content: validationResult.error,
      flags: MessageFlags.Ephemeral,
    });
    if (validationResult.notify) {
      await notifyCommandFailure(username, 'download', { userId, error: validationResult.error });
    }
    return;
  }

  // Defer reply and process
  await safeInteractionDeferReply(interaction);
  await processDownload(interaction, url, 'slash', trimStartTime, trimDuration);
}

/**
 * Validate download method availability for URL
 * @param {string} url - URL to validate
 * @param {string} userId - User ID for logging
 * @param {string} username - Username
 * @param {string} commandSource - Command source
 * @returns {{valid: boolean, error?: string, errorType?: string, notify?: boolean}}
 */
function validateDownloadMethod(url, userId, username, commandSource = 'context-menu') {
  const isYouTube = isYouTubeUrl(url);

  if (isYouTube) {
    if (!YTDLP_ENABLED) {
      logger.warn(`User ${userId} attempted to download from YouTube (yt-dlp disabled)`);
      return {
        valid: false,
        error: 'youtube downloads are disabled.',
        errorType: 'ytdlp_disabled',
        notify: false,
      };
    }
    logger.info(`YouTube URL detected, will use yt-dlp for download`);
    return { valid: true };
  }

  // Non-YouTube URLs
  if (!COBALT_ENABLED) {
    const errorMessage =
      commandSource === 'slash'
        ? 'cobalt is not enabled. please enable it to use the download command.'
        : 'cobalt is not enabled.';
    return {
      valid: false,
      error: errorMessage,
      errorType: 'cobalt_disabled',
      notify: true,
    };
  }

  if (!isSocialMediaUrl(url)) {
    return {
      valid: false,
      error: 'url is not from a supported social media platform.',
      errorType: 'invalid_social_media_url',
      notify: true,
    };
  }

  return { valid: true };
}
