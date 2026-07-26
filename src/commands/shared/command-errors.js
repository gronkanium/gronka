import { AppError } from '../../utils/errors.js';
import { safeInteractionEditReply } from '../../utils/interaction-helpers.js';

/**
 * Resolve a safe, user-facing message for an error. Our downloaders / processors throw AppError
 * subclasses (ValidationError, NetworkError, RateLimitError, ...) whose messages are authored to be
 * shown to users. Anything else (an unexpected runtime error) is replaced with a generic fallback so
 * raw internals (stack traces, library errors) never reach Discord.
 * @param {unknown} error - The caught error
 * @param {string} fallback - Generic message shown for non-AppError errors
 * @returns {string}
 */
export function curatedErrorMessage(error, fallback) {
  return error instanceof AppError && error.message ? error.message : fallback;
}

export function replyWithCuratedError(interaction, error, fallback) {
  return safeInteractionEditReply(interaction, {
    content: curatedErrorMessage(error, fallback),
  });
}
