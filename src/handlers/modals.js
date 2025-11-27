import { MessageFlags } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { processOptimization } from '../commands/optimize.js';
import { safeInteractionReply, safeInteractionDeferReply } from '../utils/interaction-helpers.js';

const logger = createLogger('modals');

/**
 * Handle modal submission for optimization
 * @param {Interaction} interaction - Discord modal submit interaction
 * @param {Map} modalAttachmentCache - Cache for modal attachment data
 */
export async function handleModalSubmit(interaction, modalAttachmentCache) {
  if (!interaction.isModalSubmit()) {
    return;
  }

  const customId = interaction.customId;

  // Handle optimize modal
  if (customId.startsWith('optimize_modal_')) {
    const userId = interaction.user.id;

    // Retrieve cached attachment info
    const cachedData = modalAttachmentCache.get(customId);
    if (!cachedData) {
      logger.warn(`No cached data found for optimize modal ${customId} from user ${userId}`);

      // Check if interaction is already responded to or expired
      if (interaction.replied || interaction.deferred) {
        logger.debug(`Interaction already responded to for modal ${customId}`);
        return;
      }

      try {
        await safeInteractionReply(interaction, {
          content: 'modal session expired. please try again.',
          flags: MessageFlags.Ephemeral,
        });
      } catch (error) {
        // Handle expired interactions (code 10062) or already acknowledged (code 40060)
        if (error.code === 10062 || error.code === 40060) {
          logger.debug(
            `Interaction expired or already acknowledged for modal ${customId}: ${error.message}`
          );
        } else {
          logger.error(`Failed to reply to modal interaction ${customId}:`, error);
        }
      }
      return;
    }

    // Clean up cache entry
    modalAttachmentCache.delete(customId);

    const { attachment, adminUser, preDownloadedBuffer, originalUrl } = cachedData;

    // Parse lossy level
    const lossyValue = interaction.fields.getTextInputValue('lossy_level') || null;
    let lossyLevel = null;

    if (lossyValue && lossyValue.trim() !== '') {
      const parsed = parseInt(lossyValue.trim(), 10);
      if (isNaN(parsed) || parsed < 0 || parsed > 100) {
        // Check if interaction is already responded to or expired
        if (interaction.replied || interaction.deferred) {
          logger.debug(
            `Interaction already responded to for invalid lossy level in modal ${customId}`
          );
          return;
        }

        try {
          await safeInteractionReply(interaction, {
            content: 'invalid lossy level. must be a number between 0 and 100.',
            flags: MessageFlags.Ephemeral,
          });
        } catch (error) {
          // Handle expired interactions (code 10062) or already acknowledged (code 40060)
          if (error.code === 10062 || error.code === 40060) {
            logger.debug(
              `Interaction expired or already acknowledged for invalid lossy level in modal ${customId}: ${error.message}`
            );
          } else {
            logger.error(`Failed to reply to modal interaction ${customId}:`, error);
          }
        }
        return;
      }
      lossyLevel = parsed;
    }

    // Check if interaction is already responded to or expired before deferring
    if (interaction.replied || interaction.deferred) {
      logger.debug(`Interaction already responded to before deferring in modal ${customId}`);
      return;
    }

    // Defer reply since optimization may take time
    try {
      await safeInteractionDeferReply(interaction);
    } catch (error) {
      // Handle expired interactions (code 10062) or already acknowledged (code 40060)
      if (error.code === 10062 || error.code === 40060) {
        logger.debug(
          `Interaction expired or already acknowledged when deferring modal ${customId}: ${error.message}`
        );
      } else {
        logger.error(`Failed to defer reply for modal interaction ${customId}:`, error);
      }
      return;
    }

    // Process optimization
    await processOptimization(
      interaction,
      attachment,
      adminUser,
      preDownloadedBuffer,
      lossyLevel,
      originalUrl || null,
      'context-menu'
    );
    return;
  }
}
