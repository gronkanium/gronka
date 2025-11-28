import { getDb } from './connection.js';
import { getUser } from './users.js';

/**
 * Insert an operation log entry
 * @param {string} operationId - Operation ID
 * @param {string} step - Step name (e.g., 'download_start', 'processing', 'complete')
 * @param {string} status - Status ('pending', 'running', 'success', 'error')
 * @param {Object} [data] - Optional data (message, filePath, stackTrace, metadata)
 * @returns {void}
 */
export function insertOperationLog(operationId, step, status, data = {}) {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return;
  }

  const timestamp = Date.now();
  const { message = null, filePath = null, stackTrace = null, metadata = null } = data;
  const metadataStr = metadata ? JSON.stringify(metadata) : null;

  const stmt = db.prepare(
    'INSERT INTO operation_logs (operation_id, timestamp, step, status, message, file_path, stack_trace, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  stmt.run(operationId, timestamp, step, status, message, filePath, stackTrace, metadataStr);
}

/**
 * Get operation logs for a specific operation
 * @param {string} operationId - Operation ID
 * @returns {Array} Array of operation log entries
 */
export function getOperationLogs(operationId) {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return [];
  }

  const stmt = db.prepare(
    'SELECT * FROM operation_logs WHERE operation_id = ? ORDER BY timestamp ASC'
  );
  return stmt.all(operationId);
}

/**
 * Get full operation trace with parsed metadata
 * @param {string} operationId - Operation ID
 * @returns {Object|null} Operation trace with parsed metadata or null if not found
 */
export function getOperationTrace(operationId) {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return null;
  }

  const logs = getOperationLogs(operationId);
  if (logs.length === 0) {
    return null;
  }

  // Parse metadata from all logs
  const parsedLogs = logs.map(log => {
    let metadata = null;
    if (log.metadata) {
      try {
        metadata = JSON.parse(log.metadata);
      } catch (error) {
        console.error('Failed to parse metadata for operation log:', error);
      }
    }
    return {
      ...log,
      metadata,
    };
  });

  // Extract context from first log (created step)
  const createdLog = parsedLogs.find(log => log.step === 'created');
  const context = createdLog?.metadata || {};

  // Find the latest status update to determine final operation status
  const statusUpdateLogs = parsedLogs.filter(log => log.step === 'status_update');
  const latestStatusLog =
    statusUpdateLogs.length > 0 ? statusUpdateLogs[statusUpdateLogs.length - 1] : createdLog;

  // Apply status inference to logs: if operation is complete and step is still 'running',
  // update it to match the final status
  const finalStatus = latestStatusLog?.status;
  if (finalStatus === 'success' || finalStatus === 'error') {
    parsedLogs.forEach(log => {
      // Only update execution step logs (not 'created', 'status_update', or 'error' logs)
      if (
        log.step !== 'created' &&
        log.step !== 'status_update' &&
        log.step !== 'error' &&
        log.status === 'running'
      ) {
        // If operation succeeded, running steps should be marked as success
        // If operation failed, running steps should be marked as error
        log.status = finalStatus === 'success' ? 'success' : 'error';
      }
    });
  }

  // Update 'created' step status to 'success' once operation has execution steps
  // (i.e., when there are logs other than 'created', 'status_update', and 'error')
  if (createdLog) {
    const hasExecutionSteps = parsedLogs.some(
      log => log.step !== 'created' && log.step !== 'status_update' && log.step !== 'error'
    );
    if (hasExecutionSteps && createdLog.status === 'pending') {
      createdLog.status = 'success';
    }
  }

  // Try to enrich username from users table if we have userId but no username
  let username = context.username;
  if ((!username || username === 'unknown') && context.userId) {
    try {
      const user = getUser(context.userId);
      if (user && user.username) {
        username = user.username;
      }
    } catch (_error) {
      // Silently fail - username will remain null
    }
  }

  // Determine input type from context
  let inputType = null;
  if (context.originalUrl) {
    inputType = 'url';
  } else if (context.attachment) {
    inputType = 'file';
  }

  return {
    operationId,
    context: {
      originalUrl: context.originalUrl || null,
      attachment: context.attachment || null,
      commandOptions: context.commandOptions || null,
      operationType: context.operationType || null,
      userId: context.userId || null,
      username: username || null,
      commandSource: context.commandSource || null,
      inputType: context.inputType || inputType || null,
    },
    logs: parsedLogs,
    totalSteps: parsedLogs.length,
    errorSteps: parsedLogs.filter(log => log.status === 'error'),
  };
}

/**
 * Get failed operations by user with context
 * @param {string} userId - User ID
 * @param {number} [limit] - Maximum number of results
 * @returns {Array} Array of failed operation traces
 */
export function getFailedOperationsByUser(userId, limit = 50) {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return [];
  }

  // Get all operation IDs that have error status
  const errorLogsStmt = db.prepare(`
    SELECT DISTINCT operation_id 
    FROM operation_logs 
    WHERE status = 'error' 
    ORDER BY timestamp DESC
    LIMIT ?
  `);
  const errorOperationIds = errorLogsStmt.all(limit).map(row => row.operation_id);

  // Get traces for each operation and filter by user
  const traces = errorOperationIds
    .map(opId => getOperationTrace(opId))
    .filter(trace => trace && trace.context.userId === userId);

  return traces;
}

/**
 * Search operations by URL pattern
 * @param {string} urlPattern - URL pattern to search for (SQL LIKE pattern)
 * @param {number} [limit] - Maximum number of results
 * @returns {Array} Array of operation traces matching the URL pattern
 */
export function searchOperationsByUrl(urlPattern, limit = 50) {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return [];
  }

  // Get all operation logs that have metadata containing the URL pattern
  const stmt = db.prepare(`
    SELECT DISTINCT operation_id 
    FROM operation_logs 
    WHERE metadata LIKE ? 
    ORDER BY timestamp DESC
    LIMIT ?
  `);
  const matchingOperationIds = stmt.all(`%${urlPattern}%`, limit).map(row => row.operation_id);

  // Get traces and filter by actual URL match in context
  const traces = matchingOperationIds
    .map(opId => getOperationTrace(opId))
    .filter(trace => {
      if (!trace) return false;
      const url = trace.context.originalUrl;
      return url && url.includes(urlPattern);
    });

  return traces;
}

/**
 * Get recent operations reconstructed from database logs
 * @param {number} [limit=100] - Maximum number of operations to return
 * @returns {Array} Array of operation objects in webui format
 */
export function getRecentOperations(limit = 100) {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return [];
  }

  // Get distinct operation IDs ordered by most recent timestamp
  const stmt = db.prepare(`
    SELECT DISTINCT operation_id, MAX(timestamp) as latest_timestamp
    FROM operation_logs
    GROUP BY operation_id
    ORDER BY latest_timestamp DESC
    LIMIT ?
  `);
  const operationIds = stmt.all(limit).map(row => row.operation_id);

  // Reconstruct each operation from its logs
  const reconstructedOperations = operationIds
    .map(operationId => {
      const logs = getOperationLogs(operationId);
      if (logs.length === 0) {
        return null;
      }

      // Parse metadata from all logs
      const parsedLogs = logs.map(log => {
        let metadata = null;
        if (log.metadata) {
          try {
            metadata = JSON.parse(log.metadata);
          } catch (error) {
            console.error('Failed to parse metadata for operation log:', error);
          }
        }
        return {
          ...log,
          metadata,
        };
      });

      // Find the 'created' log to extract initial context
      const createdLog = parsedLogs.find(log => log.step === 'created');
      if (!createdLog) {
        return null; // Skip operations without a created log
      }

      const context = createdLog.metadata || {};

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
        .filter(
          log => log.step !== 'created' && log.step !== 'status_update' && log.step !== 'error'
        )
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
          if (process.env.NODE_ENV !== 'production') {
            console.warn(
              `[getRecentOperations] Could not determine operation type for ${operationId}, step names: ${stepNames}`
            );
          }
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
            const user = getUser(context.userId);
            if (user && user.username) {
              username = user.username;
            } else {
              // Log when user not found (only in non-production)
              if (process.env.NODE_ENV !== 'production') {
                console.warn(
                  `[getRecentOperations] User not found for userId ${context.userId} in operation ${operationId}`
                );
              }
            }
          } catch (error) {
            // Log error when lookup fails
            if (process.env.NODE_ENV !== 'production') {
              console.warn(
                `[getRecentOperations] Failed to lookup user ${context.userId} for operation ${operationId}:`,
                error.message
              );
            }
          }
        }
      } else {
        // Log when userId is missing (only in non-production)
        if (process.env.NODE_ENV !== 'production' && !createdLog.metadata) {
          console.warn(
            `[getRecentOperations] No userId found for operation ${operationId} (metadata was null)`
          );
        }
      }
      // If still no username after all attempts, use null (will display as 'unknown' in UI)
      if (!username || username === 'unknown') {
        username = null;
      }

      // Reconstruct operation object
      return {
        id: operationId,
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
      };
    })
    .filter(op => op !== null); // Remove any null operations

  return reconstructedOperations;
}

/**
 * Get operations that are stuck in running status
 * @param {number} maxAgeMinutes - Maximum age in minutes before an operation is considered stuck
 * @returns {Array} Array of operation IDs that are stuck
 */
export function getStuckOperations(maxAgeMinutes = 10) {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return [];
  }

  const now = Date.now();
  const maxAge = maxAgeMinutes * 60 * 1000; // Convert minutes to milliseconds
  const cutoffTime = now - maxAge;

  // Find operations where the latest status_update has status='running' and is older than cutoff
  // We need to:
  // 1. Get all status_update logs with status='running'
  // 2. For each operation_id, get the latest timestamp
  // 3. Filter where latest timestamp < cutoffTime
  const stmt = db.prepare(`
    SELECT operation_id, MAX(timestamp) as latest_timestamp
    FROM operation_logs
    WHERE step = 'status_update' AND status = 'running'
    GROUP BY operation_id
    HAVING latest_timestamp < ?
  `);
  const results = stmt.all(cutoffTime);

  // Also check if there are any operations that have a 'running' status_update
  // but no subsequent 'success' or 'error' status_update
  const stuckOperationIds = results.map(row => row.operation_id);

  // Verify these operations don't have a more recent success/error status
  const verifiedStuck = [];
  for (const operationId of stuckOperationIds) {
    // Get the latest status_update for this operation
    const latestStatusStmt = db.prepare(`
      SELECT status, timestamp
      FROM operation_logs
      WHERE operation_id = ? AND step = 'status_update'
      ORDER BY timestamp DESC
      LIMIT 1
    `);
    const latestStatus = latestStatusStmt.get(operationId);

    // Only include if latest status is still 'running' and is old enough
    if (latestStatus && latestStatus.status === 'running' && latestStatus.timestamp < cutoffTime) {
      verifiedStuck.push(operationId);
    }
  }

  return verifiedStuck;
}

/**
 * Mark an operation as failed by inserting a status_update log
 * @param {string} operationId - Operation ID to mark as failed
 * @param {string} errorMessage - Error message to include
 * @returns {void}
 */
export function markOperationAsFailed(
  operationId,
  errorMessage = 'Operation timed out - marked as failed due to inactivity'
) {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return;
  }

  // Insert a status_update log marking the operation as error
  insertOperationLog(operationId, 'status_update', 'error', {
    message: errorMessage,
    metadata: {
      previousStatus: 'running',
      newStatus: 'error',
      reason: 'timeout',
      autoMarked: true,
    },
  });
}
