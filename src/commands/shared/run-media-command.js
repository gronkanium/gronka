import { createLogger } from '../../utils/logger.js';
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

/**
 * Lifecycle wrapper shared by the download / convert / optimize commands.
 *
 * It owns ONLY the parts that are identical and reply-agnostic across the three commands:
 *   - create the operation (+ context) and expose `buildMetadata` / `logStep`
 *   - initialize the database (bail if it fails, the initializer already replied/marked error)
 *   - flip the operation to `running`
 *   - on a thrown error: log it, mark the operation `error`, send a curated user reply, and
 *     fire `notifyCommandFailure`
 *   - run inside a job dir (media-file.js), so every file the callback makes is removed after
 *
 * The callback keeps FULL ownership of the download / transform / save / upload / Discord reply /
 * success bookkeeping (`updateOperationStatus('success', …)`, `recordRateLimit`,
 * `notifyCommandSuccess`). That is deliberate: the success/reply path is where the three commands
 * genuinely diverge (single vs picker arrays, attachment vs R2, Discord-URL capture + R2 fallback),
 * so it stays in each command rather than being forced into a one-size-fits-all wrapper.
 *
 * @param {'download'|'convert'|'optimize'} type
 * @param {import('discord.js').Interaction} interaction
 * @param {(ctx: {
 *   operationId: string, userId: string, adminUser: boolean,
 *   operationContext: Object, buildMetadata: () => Object,
 *   logStep: (step: string, status: string, data?: Object) => void,
 * }) => Promise<void>} callback
 * @param {Object} [options]
 * @param {string} [options.commandSource] - 'slash' | 'context-menu'
 * @param {string} [options.commandName] - command name for DB init (defaults to `type`)
 * @param {Object} [options.context] - extra operation context (e.g. { url } or { originalUrl })
 * @param {string} [options.errorFallback] - generic user-facing message for unexpected errors
 * @returns {Promise<void>}
 */
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
