import { createLogger } from '../../utils/logger.js';
import { isAdmin } from '../../utils/rate-limit.js';
import {
  createOperation,
  updateOperationStatus,
  logOperationStep,
  logOperationError,
} from '../../utils/operations-tracker.js';
import { initializeDatabaseWithErrorHandling } from '../../utils/database-init.js';
import { replyWithCuratedError } from './command-errors.js';
import { notifyCommandFailure } from '../../utils/ntfy-notifier.js';
import { cleanupTempFiles } from '../../utils/storage.js';

const logger = createLogger('run-media-command');

/**
 * Lifecycle wrapper shared by the download / convert / optimize commands.
 *
 * It owns ONLY the parts that are identical and reply-agnostic across the three commands:
 *   - create the operation (+ context) and expose `buildMetadata` / `logStep`
 *   - initialize the database (bail if it fails — the initializer already replied/marked error)
 *   - flip the operation to `running`
 *   - on a thrown error: log it, mark the operation `error`, send a curated user reply, and
 *     fire `notifyCommandFailure`
 *   - in `finally`: clean up any temp files the callback registered
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
 *   operationId: string, userId: string, username: string, adminUser: boolean,
 *   operationContext: Object, tempFiles: string[], buildMetadata: () => Object,
 *   logStep: (step: string, status: string, data?: Object) => void,
 * }) => Promise<void>} callback
 * @param {Object} [options]
 * @param {string} [options.commandSource] - 'slash' | 'context-menu'
 * @param {string} [options.commandName] - command name for DB init (defaults to `type`)
 * @param {Object} [options.context] - extra operation context (e.g. { url } or { originalUrl })
 * @param {string} [options.errorFallback] - generic user-facing message for unexpected errors
 * @returns {Promise<void>}
 */
export async function runMediaCommand(type, interaction, callback, options = {}) {
  const userId = interaction.user.id;
  const username = interaction.user.tag || interaction.user.username || 'unknown';
  const adminUser = isAdmin(userId);

  const operationContext = { ...(options.context || {}) };
  if (options.commandSource) {
    operationContext.commandSource = options.commandSource;
  }

  const operationId = createOperation(type, userId, username, operationContext);

  const buildMetadata = () => ({
    'user-id': userId,
    'upload-timestamp': new Date().toISOString(),
    'operation-type': type,
    username,
  });

  const tempFiles = [];

  const ctx = {
    operationId,
    userId,
    username,
    adminUser,
    operationContext,
    tempFiles,
    buildMetadata,
    logStep: (step, status, data) => logOperationStep(operationId, step, status, data),
  };

  try {
    // optimize relies on startup DB init and intentionally skips per-command init.
    if (options.skipDbInit !== true) {
      const dbInitSuccess = await initializeDatabaseWithErrorHandling({
        operationId,
        userId,
        username,
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

    await notifyCommandFailure(username, type, { operationId, userId, error: errorMessage });
  } finally {
    if (tempFiles.length > 0) {
      await cleanupTempFiles(tempFiles);
    }
  }
}
