import { getPostgresConnection } from './connection.js';
import { ensurePostgresInitialized } from './init.js';
import { convertBigIntInArray } from './helpers-pg.js';

/**
 * Get usage analytics with time-series data
 * @param {Object} options - Query options
 * @param {string} [options.interval='daily'] - Grouping interval: 'hourly', 'daily', 'weekly'
 * @param {number} [options.startTime] - Start timestamp (ms)
 * @param {number} [options.endTime] - End timestamp (ms)
 * @returns {Promise<Object>} Usage analytics data
 */
export async function getUsageAnalytics(options = {}) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return { intervals: [], summary: {} };
  }

  const {
    interval = 'daily',
    startTime = Date.now() - 7 * 24 * 60 * 60 * 1000,
    endTime = Date.now(),
  } = options;

  // Determine bucket size in milliseconds
  let bucketSize;
  switch (interval) {
    case 'hourly':
      bucketSize = 60 * 60 * 1000;
      break;
    case 'weekly':
      bucketSize = 7 * 24 * 60 * 60 * 1000;
      break;
    case 'daily':
    default:
      bucketSize = 24 * 60 * 60 * 1000;
  }

  // Get operations grouped by time bucket with status counts
  const operationsQuery = await sql`
    WITH operation_status AS (
      SELECT
        operation_id,
        (SELECT timestamp FROM operation_logs ol2 WHERE ol2.operation_id = ol.operation_id AND ol2.step = 'created' LIMIT 1) as created_at,
        (SELECT status FROM operation_logs ol2 WHERE ol2.operation_id = ol.operation_id ORDER BY timestamp DESC LIMIT 1) as final_status,
        (SELECT (metadata::jsonb->>'userId')::text FROM operation_logs ol2 WHERE ol2.operation_id = ol.operation_id AND ol2.step = 'created' LIMIT 1) as user_id,
        (SELECT (metadata::jsonb->>'operationType')::text FROM operation_logs ol2 WHERE ol2.operation_id = ol.operation_id AND ol2.step = 'created' LIMIT 1) as operation_type
      FROM operation_logs ol
      WHERE timestamp >= ${startTime} AND timestamp <= ${endTime}
      GROUP BY operation_id
    )
    SELECT
      (created_at / ${bucketSize}) * ${bucketSize} as bucket,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE final_status = 'success') as success_count,
      COUNT(*) FILTER (WHERE final_status = 'error') as error_count,
      COUNT(DISTINCT user_id) as active_users,
      COUNT(*) FILTER (WHERE operation_type = 'convert') as convert_count,
      COUNT(*) FILTER (WHERE operation_type = 'download') as download_count,
      COUNT(*) FILTER (WHERE operation_type = 'optimize') as optimize_count
    FROM operation_status
    WHERE created_at IS NOT NULL
    GROUP BY bucket
    ORDER BY bucket ASC
  `;

  // Convert the results
  const intervals = operationsQuery.map(row => ({
    timestamp: Number(row.bucket),
    operations: {
      total: Number(row.total || 0),
      success: Number(row.success_count || 0),
      error: Number(row.error_count || 0),
    },
    users: {
      active: Number(row.active_users || 0),
    },
    byType: {
      convert: Number(row.convert_count || 0),
      download: Number(row.download_count || 0),
      optimize: Number(row.optimize_count || 0),
    },
  }));

  // Calculate summary
  const totalOperations = intervals.reduce((sum, i) => sum + i.operations.total, 0);
  const totalSuccess = intervals.reduce((sum, i) => sum + i.operations.success, 0);
  const avgSuccessRate = totalOperations > 0 ? (totalSuccess / totalOperations) * 100 : 0;

  // Get unique users count
  const uniqueUsersResult = await sql`
    SELECT COUNT(DISTINCT (metadata::jsonb->>'userId')::text) as unique_users
    FROM operation_logs
    WHERE step = 'created'
      AND timestamp >= ${startTime}
      AND timestamp <= ${endTime}
      AND metadata IS NOT NULL
  `;
  const totalUsers = Number(uniqueUsersResult[0]?.unique_users || 0);

  return {
    intervals,
    summary: {
      totalOperations,
      totalUsers,
      avgSuccessRate: Math.round(avgSuccessRate * 10) / 10,
    },
  };
}

/**
 * Get performance analytics
 * @param {Object} options - Query options
 * @param {number} [options.startTime] - Start timestamp (ms)
 * @param {number} [options.endTime] - End timestamp (ms)
 * @returns {Promise<Object>} Performance analytics data
 */
export async function getPerformanceAnalytics(options = {}) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return { durations: {}, successRates: {}, errorPatterns: [] };
  }

  const { startTime = Date.now() - 7 * 24 * 60 * 60 * 1000, endTime = Date.now() } = options;

  // Get duration percentiles
  const durationResult = await sql`
    WITH operation_durations AS (
      SELECT
        operation_id,
        MAX(timestamp) - MIN(timestamp) as duration,
        (SELECT (metadata::jsonb->>'operationType')::text FROM operation_logs ol2 WHERE ol2.operation_id = ol.operation_id AND ol2.step = 'created' LIMIT 1) as operation_type
      FROM operation_logs ol
      WHERE timestamp >= ${startTime} AND timestamp <= ${endTime}
      GROUP BY operation_id
      HAVING COUNT(*) > 1 AND MAX(timestamp) - MIN(timestamp) > 0
    )
    SELECT
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration) as p50,
      PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY duration) as p75,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration) as p95,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration) as p99,
      AVG(duration) as avg_duration
    FROM operation_durations
  `;

  // Get duration by type
  const durationByTypeResult = await sql`
    WITH operation_durations AS (
      SELECT
        operation_id,
        MAX(timestamp) - MIN(timestamp) as duration,
        (SELECT (metadata::jsonb->>'operationType')::text FROM operation_logs ol2 WHERE ol2.operation_id = ol.operation_id AND ol2.step = 'created' LIMIT 1) as operation_type
      FROM operation_logs ol
      WHERE timestamp >= ${startTime} AND timestamp <= ${endTime}
      GROUP BY operation_id
      HAVING COUNT(*) > 1 AND MAX(timestamp) - MIN(timestamp) > 0
    )
    SELECT
      operation_type,
      AVG(duration) as avg_duration,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration) as p95
    FROM operation_durations
    WHERE operation_type IS NOT NULL
    GROUP BY operation_type
  `;

  const byType = {};
  for (const row of durationByTypeResult) {
    if (row.operation_type) {
      byType[row.operation_type] = {
        avg: Math.round(Number(row.avg_duration || 0)),
        p95: Math.round(Number(row.p95 || 0)),
      };
    }
  }

  // Get success rates
  const successRateResult = await sql`
    WITH operation_status AS (
      SELECT
        operation_id,
        (SELECT status FROM operation_logs ol2 WHERE ol2.operation_id = ol.operation_id ORDER BY timestamp DESC LIMIT 1) as final_status,
        (SELECT (metadata::jsonb->>'operationType')::text FROM operation_logs ol2 WHERE ol2.operation_id = ol.operation_id AND ol2.step = 'created' LIMIT 1) as operation_type
      FROM operation_logs ol
      WHERE timestamp >= ${startTime} AND timestamp <= ${endTime}
      GROUP BY operation_id
    )
    SELECT
      operation_type,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE final_status = 'success') as success_count
    FROM operation_status
    WHERE operation_type IS NOT NULL
    GROUP BY operation_type
  `;

  let totalOps = 0;
  let totalSuccess = 0;
  const successByType = {};
  for (const row of successRateResult) {
    const total = Number(row.total || 0);
    const success = Number(row.success_count || 0);
    totalOps += total;
    totalSuccess += success;
    if (row.operation_type) {
      successByType[row.operation_type] = total > 0 ? Math.round((success / total) * 1000) / 10 : 0;
    }
  }

  // Get error patterns
  const errorPatternsResult = await sql`
    SELECT
      COALESCE(
        CASE
          WHEN message ILIKE '%ffmpeg%' THEN 'FFMPEG_ERROR'
          WHEN message ILIKE '%timeout%' THEN 'TIMEOUT'
          WHEN message ILIKE '%download%' THEN 'DOWNLOAD_ERROR'
          WHEN message ILIKE '%unsupported%' THEN 'UNSUPPORTED_FORMAT'
          WHEN message ILIKE '%cobalt%' THEN 'COBALT_ERROR'
          WHEN message ILIKE '%file size%' OR message ILIKE '%too large%' THEN 'FILE_SIZE_ERROR'
          ELSE 'OTHER'
        END,
        'OTHER'
      ) as pattern,
      COUNT(*) as count
    FROM operation_logs
    WHERE step = 'error'
      AND timestamp >= ${startTime}
      AND timestamp <= ${endTime}
    GROUP BY pattern
    ORDER BY count DESC
    LIMIT 10
  `;

  const totalErrors = errorPatternsResult.reduce((sum, r) => sum + Number(r.count || 0), 0);
  const errorPatterns = errorPatternsResult.map(row => ({
    pattern: row.pattern,
    count: Number(row.count || 0),
    percentage: totalErrors > 0 ? Math.round((Number(row.count || 0) / totalErrors) * 100) : 0,
  }));

  return {
    durations: {
      p50: Math.round(Number(durationResult[0]?.p50 || 0)),
      p75: Math.round(Number(durationResult[0]?.p75 || 0)),
      p95: Math.round(Number(durationResult[0]?.p95 || 0)),
      p99: Math.round(Number(durationResult[0]?.p99 || 0)),
      avg: Math.round(Number(durationResult[0]?.avg_duration || 0)),
      byType,
    },
    successRates: {
      overall: totalOps > 0 ? Math.round((totalSuccess / totalOps) * 1000) / 10 : 0,
      byType: successByType,
    },
    errorPatterns,
  };
}

/**
 * Get user analytics
 * @param {Object} options - Query options
 * @param {number} [options.startTime] - Start timestamp (ms)
 * @param {number} [options.endTime] - End timestamp (ms)
 * @param {number} [options.limit=10] - Number of top users to return
 * @returns {Promise<Object>} User analytics data
 */
export async function getUserAnalytics(options = {}) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return { activeUsers: {}, topUsers: [], commandDistribution: {} };
  }

  const {
    startTime = Date.now() - 7 * 24 * 60 * 60 * 1000,
    _endTime = Date.now(),
    limit = 10,
  } = options;

  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000;

  // Get active users for different time periods
  const activeUsersResult = await sql`
    SELECT
      COUNT(DISTINCT CASE WHEN last_command_at >= ${dayAgo} THEN user_id END) as daily,
      COUNT(DISTINCT CASE WHEN last_command_at >= ${weekAgo} THEN user_id END) as weekly,
      COUNT(DISTINCT CASE WHEN last_command_at >= ${monthAgo} THEN user_id END) as monthly
    FROM user_metrics
  `;

  // Get top users
  const topUsersResult = await sql`
    SELECT
      user_id,
      username,
      total_commands,
      successful_commands,
      failed_commands
    FROM user_metrics
    WHERE last_command_at >= ${startTime}
    ORDER BY total_commands DESC
    LIMIT ${limit}
  `;

  const topUsers = convertBigIntInArray(topUsersResult, [
    'total_commands',
    'successful_commands',
    'failed_commands',
  ]).map(user => ({
    userId: user.user_id,
    username: user.username,
    commands: Number(user.total_commands || 0),
    successRate:
      user.total_commands > 0
        ? Math.round((Number(user.successful_commands || 0) / Number(user.total_commands)) * 1000) /
          10
        : 0,
  }));

  // Get command distribution from user_metrics
  const commandDistResult = await sql`
    SELECT
      SUM(total_convert) as convert,
      SUM(total_download) as download,
      SUM(total_optimize) as optimize
    FROM user_metrics
    WHERE last_command_at >= ${startTime}
  `;

  const convert = Number(commandDistResult[0]?.convert || 0);
  const download = Number(commandDistResult[0]?.download || 0);
  const optimize = Number(commandDistResult[0]?.optimize || 0);
  const totalCommands = convert + download + optimize;

  const commandDistribution = {
    convert: totalCommands > 0 ? Math.round((convert / totalCommands) * 1000) / 10 : 0,
    download: totalCommands > 0 ? Math.round((download / totalCommands) * 1000) / 10 : 0,
    optimize: totalCommands > 0 ? Math.round((optimize / totalCommands) * 1000) / 10 : 0,
  };

  return {
    activeUsers: {
      daily: Number(activeUsersResult[0]?.daily || 0),
      weekly: Number(activeUsersResult[0]?.weekly || 0),
      monthly: Number(activeUsersResult[0]?.monthly || 0),
    },
    topUsers,
    commandDistribution,
  };
}
