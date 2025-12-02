import { createLogger } from '../../utils/logger.js';
import { getUser } from '../../utils/database.js';

const logger = createLogger('webui');

/**
 * Reconstruct operation object from database trace
 * @param {Object} trace - Operation trace from database
 * @returns {Promise<Object|null>} Reconstructed operation object or null
 */
export async function reconstructOperationFromTrace(trace) {
  if (!trace || !trace.logs || trace.logs.length === 0) {
    return null;
  }

  const createdLog = trace.logs.find(log => log.step === 'created');
  if (!createdLog) {
    return null;
  }

  const context = trace.context || {};
  const parsedLogs = trace.logs;

  // Find the latest status update
  const statusUpdateLogs = parsedLogs.filter(log => log.step === 'status_update');
  const latestStatusLog =
    statusUpdateLogs.length > 0 ? statusUpdateLogs[statusUpdateLogs.length - 1] : createdLog;

  // Extract fileSize, error, stackTrace from status update logs and error logs
  let fileSize = null;
  let error = null;
  let stackTrace = null;

  // Check error logs first (they have the most complete error info)
  const errorLogs = parsedLogs.filter(log => log.step === 'error');
  if (errorLogs.length > 0) {
    const latestErrorLog = errorLogs[errorLogs.length - 1];
    if (latestErrorLog.message && error === null) {
      error = latestErrorLog.message;
    }
    if (latestErrorLog.stack_trace && stackTrace === null) {
      stackTrace = latestErrorLog.stack_trace;
    }
  }

  // Look through status updates for these fields (newest first)
  for (const log of statusUpdateLogs.reverse()) {
    if (log.metadata) {
      if (log.metadata.fileSize !== undefined && fileSize === null) {
        fileSize = log.metadata.fileSize;
      }
      if (log.metadata.error !== undefined && error === null) {
        error = log.metadata.error;
      }
      if (log.metadata.stackTrace !== undefined && stackTrace === null) {
        stackTrace = log.metadata.stackTrace;
      }
    }
    // Also check direct fields
    if (log.stack_trace && stackTrace === null) {
      stackTrace = log.stack_trace;
    }
  }

  // Build filePaths array from all logs that have file_path
  const filePaths = [];
  parsedLogs.forEach(log => {
    if (log.file_path && !filePaths.includes(log.file_path)) {
      filePaths.push(log.file_path);
    }
  });

  // Build performance metrics steps
  const steps = parsedLogs
    .filter(log => log.step !== 'created' && log.step !== 'status_update' && log.step !== 'error')
    .map(log => {
      let stepStatus = log.status;

      // If operation is complete and step is still 'running', infer completion status
      const finalStatus = latestStatusLog.status;
      if ((finalStatus === 'success' || finalStatus === 'error') && stepStatus === 'running') {
        // If operation succeeded, running steps should be marked as success
        // If operation failed, running steps should be marked as error
        stepStatus = finalStatus === 'success' ? 'success' : 'error';
      }

      return {
        step: log.step,
        status: stepStatus,
        timestamp: log.timestamp,
        duration: log.timestamp - createdLog.timestamp,
        ...(log.metadata || {}),
      };
    });

  // Calculate duration if operation is complete
  let duration = null;
  const finalStatus = latestStatusLog.status;
  if ((finalStatus === 'success' || finalStatus === 'error') && createdLog.timestamp) {
    const endTimestamp = latestStatusLog.timestamp;
    duration = endTimestamp - createdLog.timestamp;
  }

  // Get most recent timestamp
  const latestTimestamp = Math.max(...parsedLogs.map(log => log.timestamp));

  // Determine operation type with fallback logic
  let operationType = context.operationType;
  if (!operationType || operationType === 'unknown') {
    // Infer operation type from step names
    const stepNames = parsedLogs
      .map(log => log.step)
      .join(' ')
      .toLowerCase();
    if (
      stepNames.includes('conversion') ||
      stepNames.includes('gif') ||
      stepNames.includes('convert')
    ) {
      operationType = 'convert';
    } else if (stepNames.includes('optimization') || stepNames.includes('optimize')) {
      operationType = 'optimize';
    } else if (stepNames.includes('download') && !stepNames.includes('conversion')) {
      operationType = 'download';
    } else {
      operationType = 'unknown';
      // Log when we can't determine operation type
      logger.debug(
        `Could not determine operation type for ${trace.operationId}, step names: ${stepNames}`
      );
    }
  }

  // Determine username with fallback logic
  let username = context.username;
  // Always try to enrich username from users table if we have a userId
  // This handles cases where metadata was null or username wasn't stored
  if (context.userId) {
    // If username is missing or unknown, try to get it from users table
    if (!username || username === 'unknown') {
      try {
        const user = await getUser(context.userId);
        if (user && user.username) {
          username = user.username;
        } else {
          logger.debug(
            `User not found for userId ${context.userId} in operation ${trace.operationId}`
          );
        }
      } catch (error) {
        logger.debug(
          `Failed to lookup user ${context.userId} for operation ${trace.operationId}: ${error.message}`
        );
      }
    }
  } else {
    logger.debug(`No userId found for operation ${trace.operationId} (metadata may be null)`);
  }
  // If still no username after all attempts, use null (will display as 'unknown' in UI)
  if (!username || username === 'unknown') {
    username = null;
  }

  // Reconstruct operation object
  return {
    id: trace.operationId,
    type: operationType,
    status: latestStatusLog.status || 'pending',
    userId: context.userId || null,
    username: username,
    fileSize: fileSize,
    timestamp: latestTimestamp,
    startTime: createdLog.timestamp,
    error: error,
    stackTrace: stackTrace,
    filePaths: filePaths,
    performanceMetrics: {
      duration: duration,
      steps: steps,
    },
    originalUrl: context.originalUrl || null, // Extract original URL from context
  };
}
