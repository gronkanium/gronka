import { createLogger } from './logger.js';
import { deleteFromR2, fileExistsInR2 } from './r2-storage.js';
import {
  getExpiredR2Keys,
  getTemporaryUploadsByR2Key,
  markTemporaryUploadDeleted,
  markTemporaryUploadDeletionFailed,
  deleteTemporaryUploadsByR2Key,
} from './database.js';
import { insertAlert } from './database.js';

const logger = createLogger('r2-cleanup');

/**
 * Delete expired R2 files with reference counting and error handling
 * @param {Object} config - R2 configuration
 * @param {string} logLevel - Logging level: 'minimal', 'detailed', or 'debug'
 * @returns {Promise<{deleted: number, failed: number, skipped: number, errors: Array}>} Cleanup statistics
 */
export async function deleteExpiredR2Files(config, logLevel = 'detailed') {
  const now = Date.now();
  const stats = {
    deleted: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  if (logLevel === 'debug') {
    logger.debug(`Starting cleanup job at ${new Date(now).toISOString()}`);
  }

  try {
    // Get all R2 keys where all uploads have expired
    const expiredR2Keys = await getExpiredR2Keys(now);

    if (expiredR2Keys.length === 0) {
      if (logLevel !== 'minimal') {
        logger.info('No expired R2 files to delete');
      }
      return stats;
    }

    if (logLevel !== 'minimal') {
      logger.info(`Found ${expiredR2Keys.length} R2 keys with all uploads expired`);
    }

    if (logLevel === 'debug') {
      logger.debug(`Expired R2 keys: ${expiredR2Keys.join(', ')}`);
    }

    // Process each expired R2 key
    for (const r2Key of expiredR2Keys) {
      try {
        // Get all temporary_uploads records for this R2 key
        const uploads = await getTemporaryUploadsByR2Key(r2Key);

        // Filter to only expired, not-deleted records
        const expiredUploads = uploads.filter(u => u.expires_at < now && u.deleted_at === null);

        if (expiredUploads.length === 0) {
          // All uploads already marked as deleted, skip
          stats.skipped++;
          if (logLevel === 'debug') {
            logger.debug(`Skipping ${r2Key}: all uploads already marked as deleted`);
          }
          continue;
        }

        // Check if file still exists in R2 (idempotent deletion)
        const exists = await fileExistsInR2(r2Key, config);
        if (!exists) {
          // File already deleted from R2, mark all uploads as deleted
          if (logLevel === 'detailed' || logLevel === 'debug') {
            logger.info(`R2 file already deleted: ${r2Key}, marking records as deleted`);
          }
          for (const upload of expiredUploads) {
            await markTemporaryUploadDeleted(upload.id, now);
          }
          // Delete the records
          await deleteTemporaryUploadsByR2Key(r2Key);
          stats.deleted++;
          continue;
        }

        // Delete from R2 first
        if (logLevel === 'detailed' || logLevel === 'debug') {
          logger.info(`Deleting expired R2 file: ${r2Key}`);
        }

        try {
          const deleted = await deleteFromR2(r2Key, config);
          if (!deleted) {
            // File not found (already deleted)
            if (logLevel === 'detailed' || logLevel === 'debug') {
              logger.info(`R2 file not found (already deleted): ${r2Key}`);
            }
            for (const upload of expiredUploads) {
              await markTemporaryUploadDeleted(upload.id, now);
            }
            await deleteTemporaryUploadsByR2Key(r2Key);
            stats.deleted++;
            continue;
          }

          // R2 deletion succeeded, mark all uploads as deleted and delete records
          for (const upload of expiredUploads) {
            await markTemporaryUploadDeleted(upload.id, now);
          }
          await deleteTemporaryUploadsByR2Key(r2Key);

          stats.deleted++;
          if (logLevel === 'detailed' || logLevel === 'debug') {
            logger.info(`Successfully deleted R2 file: ${r2Key}`);
          }
        } catch (deleteError) {
          // R2 deletion failed, mark as failed for retry
          stats.failed++;
          const errorMessage = deleteError.message || String(deleteError);
          stats.errors.push({ r2Key, error: errorMessage });

          if (logLevel === 'detailed' || logLevel === 'debug') {
            logger.error(`Failed to delete R2 file ${r2Key}: ${errorMessage}`);
          }

          // Mark each upload as failed
          for (const upload of expiredUploads) {
            const retryCount = (upload.deletion_failed || 0) + 1;
            await markTemporaryUploadDeletionFailed(upload.id, errorMessage, retryCount);

            // Alert admin if retry count exceeds threshold (5)
            if (retryCount >= 5) {
              try {
                await insertAlert({
                  timestamp: now,
                  severity: 'warning',
                  component: 'r2-cleanup',
                  title: 'R2 Cleanup: Repeated Deletion Failures',
                  message: `R2 file ${r2Key} has failed deletion ${retryCount} times: ${errorMessage}`,
                  metadata: JSON.stringify({ r2Key, retryCount, error: errorMessage }),
                });
              } catch (alertError) {
                logger.error(`Failed to insert alert: ${alertError.message}`);
              }
            }
          }
        }
      } catch (keyError) {
        // Error processing this R2 key
        stats.failed++;
        const errorMessage = keyError.message || String(keyError);
        stats.errors.push({ r2Key, error: errorMessage });
        logger.error(`Error processing R2 key ${r2Key}: ${errorMessage}`);
      }
    }

    // Log summary
    if (logLevel === 'minimal') {
      if (stats.deleted > 0 || stats.failed > 0) {
        logger.info(
          `R2 cleanup completed: ${stats.deleted} deleted, ${stats.failed} failed, ${stats.skipped} skipped`
        );
      }
    } else {
      logger.info(
        `R2 cleanup completed: ${stats.deleted} deleted, ${stats.failed} failed, ${stats.skipped} skipped`
      );
    }

    if (logLevel === 'debug') {
      logger.debug(`Cleanup statistics:`, stats);
    }

    return stats;
  } catch (error) {
    const errorMessage = error.message || String(error);
    logger.error(`R2 cleanup job failed: ${errorMessage}`, error);
    stats.errors.push({ error: errorMessage });
    throw error;
  }
}

/**
 * Start the R2 cleanup job with interval
 * @param {Object} config - R2 configuration
 * @param {number} intervalMs - Cleanup interval in milliseconds
 * @param {string} logLevel - Logging level: 'minimal', 'detailed', or 'debug'
 * @returns {NodeJS.Timeout} Interval ID for stopping the job
 */
export function startCleanupJob(config, intervalMs, logLevel = 'detailed') {
  logger.info(`Starting R2 cleanup job (interval: ${intervalMs}ms, log level: ${logLevel})`);

  // Run immediately on start
  deleteExpiredR2Files(config, logLevel).catch(error => {
    logger.error(`Error in initial R2 cleanup run: ${error.message}`, error);
  });

  // Then run on interval
  const intervalId = setInterval(async () => {
    try {
      await deleteExpiredR2Files(config, logLevel);
    } catch (error) {
      logger.error(`Error in R2 cleanup job: ${error.message}`, error);
      // Continue running even on error
    }
  }, intervalMs);

  return intervalId;
}

/**
 * Stop the R2 cleanup job
 * @param {NodeJS.Timeout} intervalId - Interval ID from startCleanupJob
 */
export function stopCleanupJob(intervalId) {
  if (intervalId) {
    clearInterval(intervalId);
    logger.info('Stopped R2 cleanup job');
  }
}
