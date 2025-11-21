import { MessageFlags } from 'discord.js';
import { createLogger } from '../utils/logger.js';
import { processOptimization } from '../commands/optimize.js';

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
      await interaction.reply({
        content: 'modal session expired. please try again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Clean up cache entry
    modalAttachmentCache.delete(customId);

    const { attachment, adminUser, preDownloadedBuffer } = cachedData;

    // Parse lossy level
    const lossyValue = interaction.fields.getTextInputValue('lossy_level') || null;
    let lossyLevel = null;

    if (lossyValue && lossyValue.trim() !== '') {
      const parsed = parseInt(lossyValue.trim(), 10);
      if (isNaN(parsed) || parsed < 0 || parsed > 100) {
        await interaction.reply({
          content: 'invalid lossy level. must be a number between 0 and 100.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      lossyLevel = parsed;
    }

    // Defer reply since optimization may take time
    await interaction.deferReply();

    // Process optimization
    await processOptimization(interaction, attachment, adminUser, preDownloadedBuffer, lossyLevel);
    return;
  }
}
