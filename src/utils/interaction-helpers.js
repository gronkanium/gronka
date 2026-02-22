import { createLogger } from './logger.js';

const logger = createLogger('interaction-helpers');

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
      logger.error(`Failed to reply to interaction:`, error);
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

  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const message = await interaction.editReply(options);
      return message;
    } catch (error) {
      // Handle expired interactions (code 10062) or already acknowledged (code 40060) - no retry
      if (error.code === 10062 || error.code === 40060) {
        logger.debug(
          `Interaction expired or already acknowledged when editing reply: ${error.message}`
        );
        return false;
      }

      // Retry on socket/network errors (e.g. UND_ERR_SOCKET "other side closed")
      // Discord closes idle HTTP connections after ~15-30s; a retry opens a fresh connection
      if (
        (error.code === 'UND_ERR_SOCKET' || error.code === 'UND_ERR_CONNECT_TIMEOUT') &&
        attempt < MAX_RETRIES
      ) {
        logger.warn(
          `Socket error on attempt ${attempt}/${MAX_RETRIES} when editing reply, retrying in ${attempt}s...`
        );
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
        continue;
      }

      logger.error(`Failed to edit interaction reply:`, error);
      return false;
    }
  }

  return false;
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
      logger.error(`Failed to follow up on interaction:`, error);
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
      logger.error(`Failed to defer interaction reply:`, error);
    }
    return false;
  }
}
