import { createLogger } from '../../utils/logger.js';
import { trackRequest, requestOutcome } from '../../utils/operations-tracker.js';
import { replyWithCuratedError } from './command-errors.js';
import { recordFailure } from '../../utils/failures.js';
import { withJobDir, jobSignal } from '../../utils/media-file.js';
import { ValidationError } from '../../utils/errors.js';

const logger = createLogger('run-media-command');

// The outcome and error reply shared by download/convert/optimize; delivery stays in each command on purpose.
export function runMediaCommand(type, interaction, callback, options = {}) {
  const context = { ...(options.context || {}) };
  return withJobDir(() =>
    trackRequest(type, () => runOperation(type, interaction, callback, options, context))
  );
}

async function runOperation(type, interaction, callback, options, context) {
  const url = context.originalUrl || context.url || null;
  try {
    await callback({ operationContext: context });
    if (!requestOutcome()) {
      logger.warn(`${type} ended without a result`);
      await recordFailure(type, {
        error: 'ended without a result',
        errorClass: 'no_result',
        url,
        options: context.commandOptions,
      });
    }
  } catch (caught) {
    const error = jobSignal()?.aborted ? jobSignal().reason : caught;
    if (error instanceof ValidationError) logger.warn(`${type} failed: ${error.message}`);
    else logger.error(`${type} failed:`, error);
    await replyWithCuratedError(
      interaction,
      error,
      options.errorFallback || `an error occurred while processing your ${type} request.`
    );
    await recordFailure(type, {
      error: error?.message || 'unknown error',
      errorClass: error?.name || 'Error',
      url,
      cause: error,
      options: context.commandOptions,
    });
  }
}
