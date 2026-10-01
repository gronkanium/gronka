import { MessageFlags } from 'discord.js';
import { createLogger, withLogContext, sourceOf } from '../../utils/logger.js';
import { botConfig } from '../../utils/config.js';
import { checkRateLimit } from '../../utils/rate-limit.js';
import { createFailedOperation } from '../../utils/operations-tracker.js';
import { safeInteractionReply, safeInteractionEditReply } from '../../utils/interaction-helpers.js';
import { notifyCommandFailure } from '../../utils/ntfy-notifier.js';
import { jobContext } from '../../jobs/context.js';
import { parseTimestamp } from '../../utils/validation.js';

const logger = createLogger('command-guards');

// Slash and prefix commands share their handlers; the message adapter marks the prefix ones.
export const commandSourceOf = interaction => (interaction.isPrefixCommand ? 'prefix' : 'slash');

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
 * @param {'slash'|'prefix'|'context-menu'} params.commandSource
 * @returns {Promise<boolean>} true if rate limited (caller should return early), false otherwise
 */
export async function replyIfRateLimited(interaction, { type, action, commandSource }) {
  const userId = interaction.user.id;
  if (!checkRateLimit(userId)) {
    return false;
  }

  logger.warn(`User ${userId} is rate limited`);

  const rateLimitSeconds = botConfig.rateLimitCooldown / 1000;
  const message = `please wait ${rateLimitSeconds} seconds before ${action}.`;

  createFailedOperation(type, userId, message, 'rate_limit', { commandSource });
  await safeInteractionReply(interaction, {
    content: message,
    flags: MessageFlags.Ephemeral,
  });

  return true;
}

/**
 * Read and parse the start/end string options from a slash command interaction.
 * Values may be plain seconds ("90", "12.5") or timestamps ("3:10", "1:02:30"). On an invalid
 * value or an invalid range (end <= start), it records a failed operation, replies
 * ephemerally, and returns null so the caller can return early.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {Object} params
 * @param {'download'|'convert'} params.type - Operation type (for tracking)
 * @returns {Promise<{startTime: number|null, endTime: number|null, duration: number|null}|null>}
 *   Parsed times in seconds (null for options not given), or null when a reply was already sent
 */
export async function resolveTimeOptions(interaction, { type }) {
  const userId = interaction.user.id;

  const failWith = async (errorMessage, reason, commandOptions) => {
    createFailedOperation(type, userId, errorMessage, reason, {
      commandSource: commandSourceOf(interaction),
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
    ['start', 'startTime'],
    ['end', 'endTime'],
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
      `Invalid time range for user ${userId}: end (${endTime}) must be after start (${startTime})`
    );
    return failWith('the end time has to be after the start time.', 'invalid_time_range', {
      startTime,
      endTime,
    });
  }

  times.duration = endTime === null ? null : endTime - (startTime ?? 0);
  return times;
}

// Ephemeral before the reply is deferred, an edit of the deferred reply after.
export function replyError(interaction, content) {
  return interaction.deferred
    ? safeInteractionEditReply(interaction, { content })
    : safeInteractionReply(interaction, { content, flags: MessageFlags.Ephemeral });
}

// Turns a request away before any work: optional failed-operation row, a tagged log line, the
// reply, optional ntfy. `detail`/`cause` are what we record; `message` is what the user sees.
export async function refuse(
  interaction,
  type,
  { message, detail, cause, reason, context = {}, notify = false }
) {
  const userId = interaction.user.id;
  const error = detail || cause?.message || message;
  const operationId = reason ? createFailedOperation(type, userId, error, reason, context) : null;
  if (operationId) jobContext.getStore()?.onOperation?.(operationId);
  const fields = { command: type, user: userId };
  if (operationId) fields.op = operationId;
  const source = sourceOf(context.originalUrl || context.url);
  if (source) fields.source = source;
  await withLogContext(fields, () =>
    cause
      ? logger.warn(`${type} refused: ${error}`, cause)
      : logger.info(`${type} refused: ${error}`)
  );
  await replyError(interaction, message);
  if (notify) await notifyCommandFailure(type, { userId, operationId, error });
}
