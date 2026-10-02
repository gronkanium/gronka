import { createLogger } from '../../utils/logger.js';
import {
  createOperation,
  updateOperationStatus,
  logOperationStep,
  getOperation,
} from '../../utils/operations-tracker.js';
import { replyWithCuratedError } from './command-errors.js';
import { recordFailure } from '../../utils/failures.js';
import { withJobDir } from '../../utils/media-file.js';
import { jobContext } from '../../jobs/context.js';

const logger = createLogger('run-media-command');

// The operation lifecycle and error reply shared by download/convert/optimize; delivery stays in each command on purpose.
export function runMediaCommand(type, interaction, callback, options = {}) {
  return withJobDir(() => runInJob(type, interaction, callback, options));
}

async function runInJob(type, interaction, callback, options) {
  const operationContext = { ...(options.context || {}) };
  if (options.commandSource) {
    operationContext.commandSource = options.commandSource;
  }

  const job = jobContext.getStore();
  const operationId = createOperation(type, operationContext, job?.operationId);
  job?.onOperation?.(operationId);

  const ctx = {
    operationId,
    operationContext,
    logStep: (step, status, data) => logOperationStep(operationId, step, status, data),
  };

  return runOperation(type, interaction, callback, options, ctx);
}

async function runOperation(type, interaction, callback, options, ctx) {
  const { operationId, operationContext } = ctx;
  try {
    updateOperationStatus(operationId, 'running');
    await callback(ctx);
    // A callback that replied and returned without marking the operation would stay 'running'.
    if (getOperation(operationId)?.status === 'running') {
      updateOperationStatus(operationId, 'error', { error: 'command ended without a result' });
    }
  } catch (error) {
    logger.error(`${type} failed:`, error);
    const errorMessage =
      error && typeof error.message === 'string' && error.message ? error.message : 'unknown error';
    updateOperationStatus(operationId, 'error', { error: errorMessage });
    await replyWithCuratedError(
      interaction,
      error,
      options.errorFallback || `an error occurred while processing your ${type} request.`
    );
    await recordFailure(type, {
      error: errorMessage,
      errorClass: error?.name || 'Error',
      url: operationContext.originalUrl || operationContext.url || null,
    });
  }
}
