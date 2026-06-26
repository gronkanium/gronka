import { MessageFlags } from 'discord.js';
import { createLogger } from '../../utils/logger.js';
import { botConfig } from '../../utils/config.js';
import { checkRateLimit } from '../../utils/rate-limit.js';
import { createFailedOperation } from '../../utils/operations-tracker.js';
import { safeInteractionReply } from '../../utils/interaction-helpers.js';

const logger = createLogger('command-guards');

/**
 * Shared rate-limit guard for the command entry handlers. If the user is rate limited, it records a
 * failed operation, replies ephemerally, and returns true so the caller can return early.
 *
 * Previously this ~7-line block was duplicated across all six handle* functions (slash +
 * context-menu for download/convert/optimize). Two of those variants did not record a failed
 * operation; this unifies them so every rate-limited entry point is tracked consistently.
 *
 * @param {import('discord.js').Interaction} interaction
 * @param {Object} params
 * @param {'download'|'convert'|'optimize'} params.type - Operation type (for tracking)
 * @param {string} params.action - Verb phrase for the message, e.g. 'downloading another video'
 * @param {'slash'|'context-menu'} params.commandSource
 * @returns {Promise<boolean>} true if rate limited (caller should return early), false otherwise
 */
export async function replyIfRateLimited(interaction, { type, action, commandSource }) {
  const userId = interaction.user.id;
  if (!checkRateLimit(userId)) {
    return false;
  }

  const username = interaction.user.tag || interaction.user.username || 'unknown';
  logger.warn(`User ${userId} (${interaction.user.tag}) is rate limited`);

  const rateLimitSeconds = botConfig.rateLimitCooldown / 1000;
  const message = `please wait ${rateLimitSeconds} seconds before ${action}.`;

  createFailedOperation(type, userId, username, message, 'rate_limit', { commandSource });
  await safeInteractionReply(interaction, {
    content: message,
    flags: MessageFlags.Ephemeral,
  });

  return true;
}
