import { MessageFlags } from 'discord.js';
import { createLogger } from '../../utils/logger.js';
import { countOutcome, failed } from '../../utils/operations-tracker.js';
import { safeInteractionReply, safeInteractionEditReply } from '../../utils/interaction-helpers.js';
import { recordFailure } from '../../utils/failures.js';
import { parseTimestamp } from '../../utils/validation.js';

const logger = createLogger('command-guards');

// Slash and prefix commands share their handlers; the message adapter marks the prefix ones.
export const commandSourceOf = interaction => (interaction.isPrefixCommand ? 'prefix' : 'slash');

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
  const failWith = async errorMessage => {
    await refuse(interaction, type, { message: errorMessage, reason: 'invalid_time' });
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
      return failWith(`${optionName}: ${parsed.error}`);
    }
    times[key] = parsed.seconds;
  }

  const { startTime, endTime } = times;
  if (startTime !== null && endTime !== null && endTime <= startTime) {
    return failWith('the end time has to be after the start time.');
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

// Turns a request away: the reply, and with a `reason` one failed count, a log line and a failure
// record. `detail`/`cause` are what we record; `message` is what the user sees.
export async function refuse(interaction, type, { message, detail, cause, reason, context = {} }) {
  await replyError(interaction, message);
  if (!reason) return;
  const error = detail || cause?.message || message;
  if (!failed()) countOutcome(type, 'error');
  logger.warn(`${type} refused: ${error}`, ...[cause].filter(Boolean));
  await recordFailure(type, {
    error,
    errorClass: reason,
    url: context.originalUrl || context.url || null,
    cause,
  });
}
