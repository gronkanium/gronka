import { EmbedBuilder, MessageFlags } from 'discord.js';
import { getBan, getBooleanSetting } from './database.js';
import { safeInteractionReply } from './interaction-helpers.js';
import { isAdmin } from './rate-limit.js';
import { createLogger } from './logger.js';
import { supportConfig } from './config.js';

const logger = createLogger('ban-check');

const BAN_EMBED_COLOR = 0xed4245; // Discord red - distinct from the 0x5865f2 blurple used by /info and /stats

/**
 * If the moderation system is enabled and the interacting user is banned, reply with the ban
 * embed and return true so the caller can skip dispatching the interaction. This is the single
 * choke point for ban enforcement - it must run before ANY command/context-menu/modal handler.
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<boolean>} true if the user is banned (caller should return early)
 */
export async function replyIfBanned(interaction) {
  const moderationEnabled = await getBooleanSetting('moderation_enabled', false);
  if (!moderationEnabled) {
    return false;
  }

  const userId = interaction.user.id;
  let ban;
  try {
    ban = await getBan(userId);
  } catch (error) {
    logger.error(`Failed to check ban status for user ${userId}:`, error);
    return false; // fail open - a DB hiccup shouldn't lock out every user
  }

  if (!ban) {
    return false;
  }

  logger.info(`Blocked banned user ${userId} from interacting`);

  // Without a configured support server there is nowhere to point an appeal, so the embed says
  // appeals are open without naming a venue rather than linking someone else's server.
  let description = ban.reason;
  if (ban.appeal_allowed) {
    description += supportConfig.inviteUrl
      ? `\n\nyou can appeal at: ${supportConfig.inviteUrl}`
      : '\n\nyou can appeal this ban with the bot operator';
  }

  const embed = new EmbedBuilder()
    .setTitle('you have been banned from gronka')
    .setDescription(description)
    .setColor(BAN_EMBED_COLOR);

  await safeInteractionReply(interaction, {
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
  });

  return true;
}

/**
 * If maintenance mode (webui setting) is on and the user is not an admin, reply with a
 * maintenance notice and return true so the caller can skip dispatching the interaction.
 * Runs at the same choke point as replyIfBanned, before any command handler.
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<boolean>} true if the interaction was blocked (caller should return early)
 */
export async function replyIfMaintenance(interaction) {
  let maintenanceMode;
  try {
    maintenanceMode = await getBooleanSetting('maintenance_mode', false);
  } catch (error) {
    logger.error(`Failed to check maintenance mode: ${error.message}`);
    return false; // fail open - a DB hiccup shouldn't lock out every user
  }

  if (!maintenanceMode || isAdmin(interaction.user.id)) {
    return false;
  }

  logger.info(`Blocked user ${interaction.user.id} during maintenance mode`);

  await safeInteractionReply(interaction, {
    content: 'gronka is temporarily down for maintenance, please try again later',
    flags: MessageFlags.Ephemeral,
  });

  return true;
}
