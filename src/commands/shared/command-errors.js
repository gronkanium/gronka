import { AppError } from '../../utils/errors.js';
import { safeInteractionEditReply } from '../../utils/interaction-helpers.js';

// Resolve a safe, user-facing message for an error
export function curatedErrorMessage(error, fallback) {
  return error instanceof AppError && error.message ? error.message : fallback;
}

export function replyWithCuratedError(interaction, error, fallback) {
  return safeInteractionEditReply(interaction, {
    content: curatedErrorMessage(error, fallback),
  });
}
