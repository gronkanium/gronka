import { createLogger, withLogContext, sourceOf } from '../../utils/logger.js';
import { isAdmin } from '../../utils/rate-limit.js';
import {
  createOperation,
  updateOperationStatus,
  logOperationStep,
  logOperationError,
  getOperation,
} from '../../utils/operations-tracker.js';
import { initializeDatabaseWithErrorHandling } from '../../utils/database-init.js';
import { replyWithCuratedError } from './command-errors.js';
import { notifyCommandFailure } from '../../utils/ntfy-notifier.js';
import { withJobDir } from '../../utils/media-file.js';
import { jobContext } from '../../jobs/context.js';

const logger = createLogger('run-media-command');

// The operation lifecycle and error reply shared by download/convert/optimize; delivery stays in each command on purpose.
export function runMediaCommand(type, interaction, callback, options = {}) {
  return withJobDir(() => runInJob(type, interaction, callback, options));
}

async function runInJob(type, interaction, callback, options) {
  const userId = interaction.user.id;
  const adminUser = isAdmin(userId);

  const operationContext = { ...(options.context || {}) };
  if (options.commandSource) {
    operationContext.commandSource = options.commandSource;
  }

  const job = jobContext.getStore();
  const operationId = createOperation(type, userId, operationContext, job?.operationId);
  job?.onOperation?.(operationId);

  // This becomes R2 object metadata, so it leaves the box: ids only, never a name.
  const buildMetadata = () => ({
    'user-id': userId,
    'upload-timestamp': new Date().toISOString(),
    'operation-type': type,
  });

  const ctx = {
    operationId,
    userId,
    adminUser,
    operationContext,
    buildMetadata,
    logStep: (step, status, data) => logOperationStep(operationId, step, status, data),
  };

  const url = operationContext.url || operationContext.originalUrl;
  const logFields = { op: operationId, command: type, user: userId };
  if (url) logFields.source = sourceOf(url);
  return withLogContext(logFields, () => runOperation(type, interaction, callback, options, ctx));
}

async function runOperation(type, interaction, callback, options, ctx) {
  const { operationId, userId, operationContext } = ctx;
  try {
    // optimize relies on startup DB init and intentionally skips per-command init.
    if (options.skipDbInit !== true) {
      const dbInitSuccess = await initializeDatabaseWithErrorHandling({
        operationId,
        userId,
        commandName: options.commandName || type,
        interaction,
        context: options.context,
      });
      if (!dbInitSuccess) {
        return; // operation already marked as error by the initializer
      }
    }

    updateOperationStatus(operationId, 'running');

    await callback(ctx);

    // A callback that replied and returned without marking the operation leaves it 'running'
    // until cleanupStuckOperations kills it ~19min later and DMs the user a bogus timeout.
    if (getOperation(operationId)?.status === 'running') {
      updateOperationStatus(operationId, 'error', { error: 'command ended without a result' });
    }
  } catch (error) {
    logger.error(`${type} failed for user ${userId}:`, error);

    const errorMessage =
      error && typeof error.message === 'string' && error.message ? error.message : 'unknown error';

    logOperationError(operationId, error, {
      metadata: {
        originalUrl: operationContext.originalUrl || operationContext.url || null,
        errorMessage,
        errorName: (error && error.name) || 'Error',
        errorCode: (error && error.code) || null,
      },
    });

    updateOperationStatus(operationId, 'error', {
      error: errorMessage,
      stackTrace: (error && error.stack) || null,
    });

    await replyWithCuratedError(
      interaction,
      error,
      options.errorFallback || `an error occurred while processing your ${type} request.`
    );

    await notifyCommandFailure(type, { operationId, userId, error: errorMessage });
  }
}
