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

function setCachedRecentOperations(operations) {
  recentOperationsCache.data = operations;
  recentOperationsCache.timestamp = Date.now();
}

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

async function getOperationLogs(operationId) {
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

async function reconstructOperationsByIds(operationIds) {
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

    // Extract fileSize, error, stackTrace, sourceUrl
    let fileSize = null;
    let error = null;
    let stackTrace = null;
    let sourceUrl = null;

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
      if (log.metadata?.sourceUrl && sourceUrl === null) {
        sourceUrl = log.metadata.sourceUrl;
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
      originalUrl: context.originalUrl || null,
      sourceUrl,
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
      // Same DB-reconstruction limitation as reconstruction.js: granular step
      // logs are never persisted, so `steps` is always empty here.
      stepsAvailable: false,
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

  return convertedOperations;
}

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

  const convertedOperations = await reconstructOperationsByIds(operationIds);

  // Cache result if using default limit
  if (limit === 100) {
    setCachedRecentOperations(convertedOperations);
  }

  return convertedOperations;
}

/**
 * Search operations with SQL-level filtering across the full history (not just
 * the most recent N operations), so filters reliably find older matches.
 * Filters map onto the 'created' log's metadata (userId, username, operationType,
 * earlyFailure, timestamp) and the latest 'status_update' log (status, duration).
 * @param {Object} filters - Filter criteria
 * @param {string} [filters.operationId]
 * @param {string} [filters.userId]
 * @param {string} [filters.username] - Substring match, case-insensitive
 * @param {string} [filters.urlPattern] - Substring match on originalUrl, case-insensitive
 * @param {Array<string>} [filters.types] - Operation types to include
 * @param {Array<string>} [filters.statuses] - Statuses to include
 * @param {boolean} [filters.failedOnly]
 * @param {boolean} [filters.earlyFailureOnly]
 * @param {number} [filters.dateFrom] - Unix ms timestamp
 * @param {number} [filters.dateTo] - Unix ms timestamp
 * @param {number} [filters.minDuration] - Milliseconds
 * @param {number} [filters.maxDuration] - Milliseconds
 * @param {number} [filters.minFileSize] - Bytes
 * @param {number} [filters.maxFileSize] - Bytes
 * @param {Object} [pagination]
 * @param {number} [pagination.limit=50]
 * @param {number} [pagination.offset=0]
 * @param {string} [pagination.sort='newest'] - newest | oldest | slowest | fastest
 * @returns {Promise<{operations: Array, total: number}>}
 */
export async function searchOperations(filters = {}, { limit = 50, offset = 0, sort } = {}) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return { operations: [], total: 0 };
  }

  const conditions = [];
  const params = [];
  const p = value => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.operationId) {
    conditions.push(`c.operation_id = ${p(filters.operationId)}`);
  }
  if (filters.userId) {
    conditions.push(`(c.metadata::jsonb ->> 'userId') = ${p(filters.userId)}`);
  }
  if (filters.username) {
    conditions.push(`(c.metadata::jsonb ->> 'username') ILIKE ${p(`%${filters.username}%`)}`);
  }
  if (filters.urlPattern) {
    conditions.push(`(c.metadata::jsonb ->> 'originalUrl') ILIKE ${p(`%${filters.urlPattern}%`)}`);
  }
  if (filters.types && filters.types.length > 0) {
    conditions.push(`(c.metadata::jsonb ->> 'operationType') = ANY(${p(filters.types)}::text[])`);
  }
  if (filters.statuses && filters.statuses.length > 0) {
    conditions.push(`COALESCE(ls.status, 'pending') = ANY(${p(filters.statuses)}::text[])`);
  }
  if (filters.failedOnly) {
    conditions.push(`COALESCE(ls.status, 'pending') = 'error'`);
  }
  if (filters.earlyFailureOnly) {
    conditions.push(`(c.metadata::jsonb ->> 'earlyFailure') = 'true'`);
  }
  if (filters.dateFrom) {
    conditions.push(`c.created_at >= ${p(filters.dateFrom)}`);
  }
  if (filters.dateTo) {
    conditions.push(`c.created_at <= ${p(filters.dateTo)}`);
  }
  if (filters.minDuration) {
    conditions.push(
      `ls.status_at IS NOT NULL AND (ls.status_at - c.created_at) >= ${p(filters.minDuration)}`
    );
  }
  if (filters.maxDuration) {
    conditions.push(
      `ls.status_at IS NOT NULL AND (ls.status_at - c.created_at) <= ${p(filters.maxDuration)}`
    );
  }
  if (filters.minFileSize) {
    conditions.push(`EXISTS (
      SELECT 1 FROM operation_logs su
      WHERE su.operation_id = c.operation_id AND su.step = 'status_update'
        AND (su.metadata::jsonb ->> 'fileSize') IS NOT NULL
        AND (su.metadata::jsonb ->> 'fileSize')::bigint >= ${p(filters.minFileSize)}
    )`);
  }
  if (filters.maxFileSize) {
    conditions.push(`EXISTS (
      SELECT 1 FROM operation_logs su
      WHERE su.operation_id = c.operation_id AND su.step = 'status_update'
        AND (su.metadata::jsonb ->> 'fileSize') IS NOT NULL
        AND (su.metadata::jsonb ->> 'fileSize')::bigint <= ${p(filters.maxFileSize)}
    )`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const cte = `
    WITH created AS (
      SELECT operation_id, timestamp AS created_at, metadata
      FROM operation_logs
      WHERE step = 'created'
    ),
    latest_status AS (
      SELECT DISTINCT ON (operation_id) operation_id, status, timestamp AS status_at
      FROM operation_logs
      WHERE step = 'status_update'
      ORDER BY operation_id, timestamp DESC
    )
  `;

  const countQuery = `
    ${cte}
    SELECT COUNT(*) AS total
    FROM created c
    LEFT JOIN latest_status ls ON ls.operation_id = c.operation_id
    ${whereClause}
  `;
  const countResult = await sql.unsafe(countQuery, params);
  const total = parseInt(countResult[0]?.total ?? 0, 10);

  // Whitelisted ORDER BY variants; duration sorts push never-finished operations last
  const orderByClauses = {
    newest: 'c.created_at DESC',
    oldest: 'c.created_at ASC',
    slowest: '(ls.status_at - c.created_at) DESC NULLS LAST',
    fastest: '(ls.status_at - c.created_at) ASC NULLS LAST',
  };
  const orderBy = orderByClauses[sort] || orderByClauses.newest;

  const idsQuery = `
    ${cte}
    SELECT c.operation_id
    FROM created c
    LEFT JOIN latest_status ls ON ls.operation_id = c.operation_id
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ${p(limit)} OFFSET ${p(offset)}
  `;
  const idsResult = await sql.unsafe(idsQuery, params);
  const operationIds = idsResult.map(row => row.operation_id);

  const reconstructed = await reconstructOperationsByIds(operationIds);
  // Preserve SQL ORDER BY (reconstruction doesn't guarantee input order)
  const orderIndex = new Map(operationIds.map((id, i) => [id, i]));
  reconstructed.sort((a, b) => orderIndex.get(a.id) - orderIndex.get(b.id));

  return { operations: reconstructed, total };
}

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
