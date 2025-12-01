import { getPostgresConnection } from './connection.js';
import { ensurePostgresInitialized } from './init.js';
import { getUser } from './users-pg.js';
import { convertTimestampsInArray, convertTimestampsToNumbers } from './helpers-pg.js';

// Query result cache for getRecentOperations
const recentOperationsCache = {
  data: null,
  timestamp: 0,
  ttl: 30 * 1000, // 30 seconds
};

/**
 * Get cached recent operations if available and not expired
 * @returns {Array|null} Cached operations or null
 */
function getCachedRecentOperations() {
  if (!recentOperationsCache.data) {
    return null;
  }
  const age = Date.now() - recentOperationsCache.timestamp;
  if (age >= recentOperationsCache.ttl) {
    recentOperationsCache.data = null;
    return null;
  }
  return recentOperationsCache.data;
}

/**
 * Cache recent operations
 * @param {Array} operations - Operations to cache
 */
function setCachedRecentOperations(operations) {
  recentOperationsCache.data = operations;
  recentOperationsCache.timestamp = Date.now();
}

/**
 * Invalidate recent operations cache
 */
export function invalidateRecentOperationsCache() {
  recentOperationsCache.data = null;
  recentOperationsCache.timestamp = 0;
}

/**
 * Insert an operation log entry
 * @param {string} operationId - Operation ID
 * @param {string} step - Step name (e.g., 'download_start', 'processing', 'complete')
 * @param {string} status - Status ('pending', 'running', 'success', 'error')
 * @param {Object} [data] - Optional data (message, filePath, stackTrace, metadata)
 * @returns {Promise<void>}
 */
export async function insertOperationLog(operationId, step, status, data = {}) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return;
  }

  const timestamp = Date.now();
  const { message = null, filePath = null, stackTrace = null, metadata = null } = data;
  const metadataStr = metadata ? JSON.stringify(metadata) : null;

  await sql`
    INSERT INTO operation_logs (operation_id, timestamp, step, status, message, file_path, stack_trace, metadata)
    VALUES (${operationId}, ${timestamp}, ${step}, ${status}, ${message}, ${filePath}, ${stackTrace}, ${metadataStr})
  `;
}

/**
 * Get operation logs for a specific operation
 * @param {string} operationId - Operation ID
 * @returns {Promise<Array>} Array of operation log entries
 */
export async function getOperationLogs(operationId) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return [];
  }

  const logs = await sql`
    SELECT * FROM operation_logs
    WHERE operation_id = ${operationId}
    ORDER BY timestamp ASC
  `;
  // Convert timestamp fields from strings to numbers
  return convertTimestampsInArray(logs, ['timestamp']);
}

/**
 * Get full operation trace with parsed metadata
 * @param {string} operationId - Operation ID
 * @returns {Promise<Object|null>} Operation trace with parsed metadata or null if not found
 */
export async function getOperationTrace(operationId) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return null;
  }

  const logs = await getOperationLogs(operationId);
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

  // Apply status inference to logs
  const finalStatus = latestStatusLog?.status;
  if (finalStatus === 'success' || finalStatus === 'error') {
    parsedLogs.forEach(log => {
      if (
        log.step !== 'created' &&
        log.step !== 'status_update' &&
        log.step !== 'error' &&
        log.status === 'running'
      ) {
        log.status = finalStatus === 'success' ? 'success' : 'error';
      }
    });
  }

  // Update 'created' step status
  if (createdLog) {
    const hasExecutionSteps = parsedLogs.some(
      log => log.step !== 'created' && log.step !== 'status_update' && log.step !== 'error'
    );
    if (hasExecutionSteps && createdLog.status === 'pending') {
      createdLog.status = 'success';
    }
  }

  // Try to enrich username from users table
  let username = context.username;
  if ((!username || username === 'unknown') && context.userId) {
    try {
      const user = await getUser(context.userId);
      if (user && user.username) {
        username = user.username;
      }
    } catch (_error) {
      // Silently fail
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
 * @returns {Promise<Array>} Array of failed operation traces
 */
export async function getFailedOperationsByUser(userId, limit = 50) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return [];
  }

  // Get all operation IDs that have error status
  const errorOperationIds = await sql`
    SELECT DISTINCT operation_id
    FROM operation_logs
    WHERE status = 'error'
    ORDER BY timestamp DESC
    LIMIT ${limit}
  `;

  // Get traces for each operation and filter by user
  const traces = [];
  for (const row of errorOperationIds) {
    const trace = await getOperationTrace(row.operation_id);
    if (trace && trace.context.userId === userId) {
      traces.push(trace);
    }
  }

  return traces;
}

/**
 * Search operations by URL pattern
 * @param {string} urlPattern - URL pattern to search for (SQL LIKE pattern)
 * @param {number} [limit] - Maximum number of results
 * @returns {Promise<Array>} Array of operation traces matching the URL pattern
 */
export async function searchOperationsByUrl(urlPattern, limit = 50) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return [];
  }

  // Get all operation logs that have metadata containing the URL pattern
  const matchingOperationIds = await sql`
    SELECT DISTINCT operation_id
    FROM operation_logs
    WHERE metadata LIKE ${`%${urlPattern}%`}
    ORDER BY timestamp DESC
    LIMIT ${limit}
  `;

  // Get traces and filter by actual URL match in context
  const traces = [];
  for (const row of matchingOperationIds) {
    const trace = await getOperationTrace(row.operation_id);
    if (trace) {
      const url = trace.context.originalUrl;
      if (url && url.includes(urlPattern)) {
        traces.push(trace);
      }
    }
  }

  return traces;
}

/**
 * Get recent operations reconstructed from database logs
 * @param {number} [limit=100] - Maximum number of operations to return
 * @returns {Promise<Array>} Array of operation objects in webui format
 */
export async function getRecentOperations(limit = 100) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return [];
  }

  // Check cache first (only for default limit of 100)
  if (limit === 100) {
    const cached = getCachedRecentOperations();
    if (cached) {
      return cached;
    }
  }

  // Get distinct operation IDs ordered by most recent timestamp
  const operationIdsResult = await sql`
    SELECT DISTINCT operation_id, MAX(timestamp) as latest_timestamp
    FROM operation_logs
    GROUP BY operation_id
    ORDER BY latest_timestamp DESC
    LIMIT ${limit}
  `;
  const operationIds = operationIdsResult.map(row => row.operation_id);

  // Reconstruct each operation from its logs
  const reconstructedOperations = [];
  for (const operationId of operationIds) {
    const logs = await getOperationLogs(operationId);
    if (logs.length === 0) {
      continue;
    }

    // Parse metadata from all logs and ensure timestamps are numbers
    const parsedLogs = logs.map(log => {
      let metadata = null;
      if (log.metadata) {
        try {
          metadata = JSON.parse(log.metadata);
        } catch (error) {
          console.error('Failed to parse metadata for operation log:', error);
        }
      }
      const logWithMetadata = {
        ...log,
        metadata,
      };
      // Ensure timestamp is a number (should already be converted by getOperationLogs, but double-check)
      return convertTimestampsToNumbers(logWithMetadata, ['timestamp']);
    });

    // Find the 'created' log to extract initial context
    const createdLog = parsedLogs.find(log => log.step === 'created');
    if (!createdLog) {
      continue; // Skip operations without a created log
    }

    const context = createdLog.metadata || {};

    // Find the latest status update
    const statusUpdateLogs = parsedLogs.filter(log => log.step === 'status_update');
    const latestStatusLog =
      statusUpdateLogs.length > 0 ? statusUpdateLogs[statusUpdateLogs.length - 1] : createdLog;

    // Extract fileSize, error, stackTrace
    let fileSize = null;
    let error = null;
    let stackTrace = null;

    // Check error logs first
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

    // Look through status updates
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
      if (log.stack_trace && stackTrace === null) {
        stackTrace = log.stack_trace;
      }
    }

    // Build filePaths array
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
        const finalStatus = latestStatusLog.status;
        if ((finalStatus === 'success' || finalStatus === 'error') && stepStatus === 'running') {
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

    // Calculate duration
    let duration = null;
    const finalStatus = latestStatusLog.status;
    if ((finalStatus === 'success' || finalStatus === 'error') && createdLog.timestamp) {
      const endTimestamp = latestStatusLog.timestamp;
      duration = endTimestamp - createdLog.timestamp;
    }

    // Get most recent timestamp
    const latestTimestamp = Math.max(...parsedLogs.map(log => log.timestamp));

    // Determine operation type
    let operationType = context.operationType;
    if (!operationType || operationType === 'unknown') {
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
      }
    }

    // Determine username
    let username = context.username;
    if (context.userId) {
      try {
        const user = await getUser(context.userId);
        if (user && user.username) {
          username = user.username;
        }
      } catch (_error) {
        // Silently fail
      }
    }

    reconstructedOperations.push({
      id: operationId,
      type: operationType,
      status: latestStatusLog.status,
      userId: context.userId || null,
      username: username || null,
      fileSize,
      timestamp: createdLog.timestamp,
      startTime: createdLog.timestamp,
      error,
      stackTrace,
      filePaths,
      performanceMetrics: {
        duration,
        steps,
      },
      latestTimestamp,
    });
  }

  // Convert timestamps in final reconstructed operations
  const convertedOperations = reconstructedOperations.map(op =>
    convertTimestampsToNumbers(op, ['timestamp', 'startTime', 'latestTimestamp'])
  );

  // Also convert timestamps in performanceMetrics.steps
  convertedOperations.forEach(op => {
    if (op.performanceMetrics?.steps) {
      op.performanceMetrics.steps = op.performanceMetrics.steps.map(step =>
        convertTimestampsToNumbers(step, ['timestamp'])
      );
    }
  });

  // Cache result if using default limit
  if (limit === 100) {
    setCachedRecentOperations(convertedOperations);
  }

  return convertedOperations;
}

/**
 * Update metadata for a specific operation log entry
 * @param {string} operationId - Operation ID
 * @param {string} step - Step name (e.g., 'created')
 * @param {Object} newMetadata - New metadata object to merge with existing metadata
 * @returns {Promise<boolean>} True if update was successful, false otherwise
 */
export async function updateOperationLogMetadata(operationId, step, newMetadata) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return false;
  }

  // Get the existing log entry
  const existingLogs = await sql`
    SELECT * FROM operation_logs
    WHERE operation_id = ${operationId} AND step = ${step}
    ORDER BY timestamp ASC
    LIMIT 1
  `;

  if (existingLogs.length === 0) {
    console.error(`Operation log not found: ${operationId}, step: ${step}`);
    return false;
  }

  const existingLog = existingLogs[0];

  // Parse existing metadata
  let existingMetadata = {};
  if (existingLog.metadata) {
    try {
      existingMetadata = JSON.parse(existingLog.metadata);
    } catch (error) {
      console.error('Failed to parse existing metadata:', error);
      existingMetadata = {};
    }
  }

  // Merge with new metadata
  const mergedMetadata = { ...existingMetadata, ...newMetadata };
  const metadataStr = JSON.stringify(mergedMetadata);

  // Update the log entry
  await sql`
    UPDATE operation_logs
    SET metadata = ${metadataStr}
    WHERE operation_id = ${operationId} AND step = ${step} AND timestamp = ${existingLog.timestamp}
  `;

  return true;
}

/**
 * Get operations that are stuck in running status
 * @param {number} maxAgeMinutes - Maximum age in minutes before an operation is considered stuck
 * @returns {Promise<Array>} Array of operation IDs that are stuck
 */
export async function getStuckOperations(maxAgeMinutes = 10) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return [];
  }

  const now = Date.now();
  const maxAge = maxAgeMinutes * 60 * 1000;
  const cutoffTime = now - maxAge;

  // Find operations where the latest status_update has status='running' and is older than cutoff
  const results = await sql`
    SELECT operation_id, MAX(timestamp) as latest_timestamp
    FROM operation_logs
    WHERE step = 'status_update' AND status = 'running'
    GROUP BY operation_id
    HAVING MAX(timestamp) < ${cutoffTime}
  `;

  const stuckOperationIds = results.map(row => row.operation_id);

  // Verify these operations don't have a more recent success/error status
  const verifiedStuck = [];
  for (const operationId of stuckOperationIds) {
    const latestStatusResult = await sql`
      SELECT status, timestamp
      FROM operation_logs
      WHERE operation_id = ${operationId} AND step = 'status_update'
      ORDER BY timestamp DESC
      LIMIT 1
    `;

    if (latestStatusResult.length > 0) {
      const latestStatus = latestStatusResult[0];
      if (latestStatus.status === 'running' && latestStatus.timestamp < cutoffTime) {
        verifiedStuck.push(operationId);
      }
    }
  }

  return verifiedStuck;
}

/**
 * Mark an operation as failed by inserting a status_update log
 * @param {string} operationId - Operation ID to mark as failed
 * @param {string} errorMessage - Error message to include
 * @returns {Promise<void>}
 */
export async function markOperationAsFailed(
  operationId,
  errorMessage = 'Operation timed out - marked as failed due to inactivity'
) {
  await ensurePostgresInitialized();

  // Insert a status_update log marking the operation as error
  await insertOperationLog(operationId, 'status_update', 'error', {
    message: errorMessage,
    metadata: {
      previousStatus: 'running',
      newStatus: 'error',
      reason: 'timeout',
      autoMarked: true,
    },
  });
}
