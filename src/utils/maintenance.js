import { MessageFlags } from 'discord.js';
import { getBooleanSetting } from './database.js';
import { safeInteractionReply } from './interaction-helpers.js';
import { createLogger } from './logger.js';

const logger = createLogger('maintenance');

// If maintenance mode (webui setting) is on, reply with a maintenance notice and return true so the caller can skip dispatching the interaction
export async function replyIfMaintenance(interaction) {
  let maintenanceMode;
  try {
    maintenanceMode = await getBooleanSetting('maintenance_mode', false);
  } catch (error) {
    logger.error(`Failed to check maintenance mode: ${error.message}`);
    return false; // fail open - a DB hiccup shouldn't lock out every user
  }

  if (!maintenanceMode) {
    return false;
  }

  await safeInteractionReply(interaction, {
    content: 'gronka is temporarily down for maintenance, please try again later',
    flags: MessageFlags.Ephemeral,
  });

  return true;
}
