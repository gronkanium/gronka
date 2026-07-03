import { EmbedBuilder, MessageFlags } from 'discord.js';
import { getBan, getBooleanSetting } from './database.js';
import { safeInteractionReply } from './interaction-helpers.js';
import { createLogger } from './logger.js';

const logger = createLogger('ban-check');

const BAN_EMBED_COLOR = 0xed4245; // Discord red - distinct from the 0x5865f2 blurple used by /info and /stats
const APPEAL_INVITE_URL = 'https://discord.gg/MHM2m4keTX';

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

  const description = ban.appeal_allowed
    ? `${ban.reason}\n\nyou can appeal at: ${APPEAL_INVITE_URL}`
    : ban.reason;

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
