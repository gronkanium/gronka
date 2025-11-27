import { createLogger } from './logger.js';
import { initDatabase } from './database.js';
import { updateOperationStatus, logOperationError } from './operations-tracker.js';
import { notifyCommandFailure } from './ntfy-notifier.js';
import { safeInteractionEditReply } from './interaction-helpers.js';

const logger = createLogger('database-init');

/**
 * Initialize database with proper error handling for command operations
 * @param {Object} params - Parameters object
 * @param {string} params.operationId - Operation ID for tracking
 * @param {string} params.userId - User ID
 * @param {string} params.username - Username
 * @param {string} params.commandName - Command name ('download', 'convert', etc.)
 * @param {Interaction} params.interaction - Discord interaction
 * @param {Object} [params.context] - Additional context for error logging (e.g., { url, originalUrl })
 * @returns {Promise<boolean>} True if initialization succeeded, false if it failed
 */
export async function initializeDatabaseWithErrorHandling({
  operationId,
  userId,
  username,
  commandName,
  interaction,
  context = {},
}) {
  try {
    await initDatabase();
    return true;
  } catch (dbInitError) {
    // Database initialization failed - update operation status immediately
    logger.error(`Database initialization failed for ${commandName}: ${dbInitError.message}`);

    logOperationError(operationId, dbInitError, {
      metadata: {
        ...context,
        errorType: 'database_initialization_failure',
        errorCode: dbInitError.code || null,
      },
    });

    updateOperationStatus(operationId, 'error', {
      error: `Database initialization failed: ${dbInitError.message}`,
      stackTrace: dbInitError.stack || null,
    });

    await safeInteractionEditReply(interaction, {
      content: 'an error occurred while initializing the database. please try again later.',
    });

    await notifyCommandFailure(username, commandName, {
      operationId,
      userId,
      error: `Database initialization failed: ${dbInitError.message}`,
    });

    return false;
  }
}
