import { createLogger } from './logger.js';

const logger = createLogger('interaction-helpers');

/**
 * Sanitize Discord.js errors before logging to prevent huge requestBody data in database
 * Discord errors can contain full file buffers in requestBody which can be megabytes
 * @param {Error} error - Discord.js error object
 * @returns {Object} Sanitized error object safe for logging
 */
function sanitizeDiscordError(error) {
  if (!error || typeof error !== 'object') {
    return error;
  }

  // Extract only the useful fields, excluding requestBody which contains file data
  const sanitized = {
    message: error.message,
    code: error.code,
    status: error.status,
    method: error.method,
    url: error.url,
  };

  // Include rawError message if present, but not the full rawError object
  if (error.rawError?.message) {
    sanitized.rawErrorMessage = error.rawError.message;
    sanitized.rawErrorCode = error.rawError.code;
  }

  // Remove undefined fields
  Object.keys(sanitized).forEach(key => {
    if (sanitized[key] === undefined) {
      delete sanitized[key];
    }
  });

  return sanitized;
}

/**
 * Safely reply to a Discord interaction, handling expired/already-acknowledged interactions
 * @param {Interaction} interaction - Discord interaction
 * @param {Object} options - Reply options (content, embeds, etc.)
 * @returns {Promise<boolean>} True if reply was successful, false otherwise
 */
export async function safeInteractionReply(interaction, options) {
  if (interaction.replied || interaction.deferred) {
    logger.debug(`Interaction already responded to, cannot reply`);
    return false;
  }

  try {
    await interaction.reply(options);
    return true;
  } catch (error) {
    // Handle expired interactions (code 10062) or already acknowledged (code 40060)
    if (error.code === 10062 || error.code === 40060) {
      logger.debug(`Interaction expired or already acknowledged when replying: ${error.message}`);
    } else {
      logger.error(`Failed to reply to interaction:`, sanitizeDiscordError(error));
    }
    return false;
  }
}

/**
 * Safely edit a Discord interaction reply, handling expired/already-acknowledged interactions
 * @param {Interaction} interaction - Discord interaction
 * @param {Object} options - Edit options (content, embeds, etc.)
 * @returns {Promise<Message|false>} Message object if edit was successful, false otherwise
 */
export async function safeInteractionEditReply(interaction, options) {
  if (!interaction.replied && !interaction.deferred) {
    logger.debug(`Interaction not yet responded to, cannot edit reply`);
    return false;
  }

  try {
    const message = await interaction.editReply(options);
    return message;
  } catch (error) {
    // Handle expired interactions (code 10062) or already acknowledged (code 40060)
    if (error.code === 10062 || error.code === 40060) {
      logger.debug(
        `Interaction expired or already acknowledged when editing reply: ${error.message}`
      );
    } else {
      logger.error(`Failed to edit interaction reply:`, sanitizeDiscordError(error));
    }
    return false;
  }
}

/**
 * Safely follow up on a Discord interaction, handling expired/already-acknowledged interactions
 * @param {Interaction} interaction - Discord interaction
 * @param {Object} options - Follow-up options (content, embeds, etc.)
 * @returns {Promise<Message|boolean>} Message if successful, false otherwise
 */
export async function safeInteractionFollowUp(interaction, options) {
  if (!interaction.replied && !interaction.deferred) {
    logger.debug(`Interaction not yet responded to, cannot follow up`);
    return false;
  }

  try {
    const message = await interaction.followUp(options);
    return message;
  } catch (error) {
    // Handle expired interactions (code 10062) or already acknowledged (code 40060)
    if (error.code === 10062 || error.code === 40060) {
      logger.debug(
        `Interaction expired or already acknowledged when following up: ${error.message}`
      );
    } else {
      logger.error(`Failed to follow up on interaction:`, sanitizeDiscordError(error));
    }
    return false;
  }
}

/**
 * Safely defer a Discord interaction reply, handling expired/already-acknowledged interactions
 * @param {Interaction} interaction - Discord interaction
 * @param {Object} [options] - Defer options (ephemeral, etc.)
 * @returns {Promise<boolean>} True if defer was successful, false otherwise
 */
export async function safeInteractionDeferReply(interaction, options = {}) {
  if (interaction.replied || interaction.deferred) {
    logger.debug(`Interaction already responded to, cannot defer reply`);
    return false;
  }

  try {
    await interaction.deferReply(options);
    return true;
  } catch (error) {
    // Handle expired interactions (code 10062) or already acknowledged (code 40060)
    if (error.code === 10062 || error.code === 40060) {
      logger.debug(
        `Interaction expired or already acknowledged when deferring reply: ${error.message}`
      );
    } else {
      logger.error(`Failed to defer interaction reply:`, sanitizeDiscordError(error));
    }
    return false;
  }
}
