import { MessageFlags } from 'discord.js';
import { createLogger } from '../../utils/logger.js';
import { botConfig } from '../../utils/config.js';
import { checkRateLimit } from '../../utils/rate-limit.js';
import { createFailedOperation } from '../../utils/operations-tracker.js';
import { safeInteractionReply } from '../../utils/interaction-helpers.js';
import { parseTimestamp } from '../../utils/validation.js';

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

/**
 * Read and parse the start_time/end_time string options from a slash command interaction.
 * Values may be plain seconds ("90", "12.5") or timestamps ("3:10", "1:02:30"). On an invalid
 * value or an invalid range (end_time <= start_time), it records a failed operation, replies
 * ephemerally, and returns null so the caller can return early.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {Object} params
 * @param {'download'|'convert'} params.type - Operation type (for tracking)
 * @returns {Promise<{startTime: number|null, endTime: number|null}|null>} Parsed times in
 *   seconds (null for options the user didn't provide), or null when a reply was already sent
 */
export async function resolveTimeOptions(interaction, { type }) {
  const userId = interaction.user.id;
  const username = interaction.user.tag || interaction.user.username || 'unknown';

  const failWith = async (errorMessage, reason, commandOptions) => {
    createFailedOperation(type, userId, username, errorMessage, reason, {
      commandSource: 'slash',
      commandOptions,
    });
    await safeInteractionReply(interaction, {
      content: errorMessage,
      flags: MessageFlags.Ephemeral,
    });
    return null;
  };

  const times = { startTime: null, endTime: null };

  for (const [optionName, key] of [
    ['start_time', 'startTime'],
    ['end_time', 'endTime'],
  ]) {
    const input = interaction.options.getString(optionName);
    if (input === null) continue;

    const parsed = parseTimestamp(input);
    if (!parsed.valid) {
      logger.warn(`Invalid ${optionName} "${input}" for user ${userId}: ${parsed.error}`);
      return failWith(`${optionName}: ${parsed.error}`, 'invalid_time_format', {
        [optionName]: input,
      });
    }
    times[key] = parsed.seconds;
  }

  const { startTime, endTime } = times;
  if (startTime !== null && endTime !== null && endTime <= startTime) {
    logger.warn(
      `Invalid time range for user ${userId}: end_time (${endTime}) must be greater than start_time (${startTime})`
    );
    return failWith('end_time must be greater than start_time.', 'invalid_time_range', {
      startTime,
      endTime,
    });
  }

  return times;
}
