import { getPostgresConnection } from './connection.js';
import { ensurePostgresInitialized } from './init.js';
import {
  convertTimestampsInArray,
  convertTimestampsToNumbers,
  convertBigIntToNumbers,
  convertBigIntInArray,
} from './helpers-pg.js';

// Define numeric fields in user_metrics table that need conversion from BIGINT strings to numbers
const USER_METRICS_NUMERIC_FIELDS = [
  'total_commands',
  'successful_commands',
  'failed_commands',
  'total_convert',
  'total_download',
  'total_optimize',
  'total_info',
  'total_file_size',
];

// Define timestamp fields in user_metrics table
const USER_METRICS_TIMESTAMP_FIELDS = ['last_command_at', 'updated_at'];

/**
 * Insert or update user metrics
 * @param {string} userId - Discord user ID
 * @param {string} username - Discord username
 * @param {Object} metrics - Metrics to update
 * @returns {Promise<void>}
 */
export async function insertOrUpdateUserMetrics(userId, username, metrics) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return;
  }

  const timestamp = Date.now();

  // Check if user metrics exist
  const existing = await sql`SELECT * FROM user_metrics WHERE user_id = ${userId}`;

  if (existing.length > 0) {
    // Build update query dynamically
    const updates = [];
    const params = [];

    if (metrics.totalCommands !== undefined) {
      updates.push(`total_commands = total_commands + $${params.length + 1}`);
      params.push(metrics.totalCommands);
    }
    if (metrics.successfulCommands !== undefined) {
      updates.push(`successful_commands = successful_commands + $${params.length + 1}`);
      params.push(metrics.successfulCommands);
    }
    if (metrics.failedCommands !== undefined) {
      updates.push(`failed_commands = failed_commands + $${params.length + 1}`);
      params.push(metrics.failedCommands);
    }
    if (metrics.totalConvert !== undefined) {
      updates.push(`total_convert = total_convert + $${params.length + 1}`);
      params.push(metrics.totalConvert);
    }
    if (metrics.totalDownload !== undefined) {
      updates.push(`total_download = total_download + $${params.length + 1}`);
      params.push(metrics.totalDownload);
    }
    if (metrics.totalOptimize !== undefined) {
      updates.push(`total_optimize = total_optimize + $${params.length + 1}`);
      params.push(metrics.totalOptimize);
    }
    if (metrics.totalInfo !== undefined) {
      updates.push(`total_info = total_info + $${params.length + 1}`);
      params.push(metrics.totalInfo);
    }
    if (metrics.totalFileSize !== undefined) {
      updates.push(`total_file_size = total_file_size + $${params.length + 1}`);
      params.push(metrics.totalFileSize);
    }
    if (metrics.lastCommandAt !== undefined) {
      updates.push(`last_command_at = $${params.length + 1}`);
      params.push(metrics.lastCommandAt);
    }

    updates.push(`username = $${params.length + 1}`, `updated_at = $${params.length + 2}`);
    params.push(username, timestamp, userId);

    const query = `UPDATE user_metrics SET ${updates.join(', ')} WHERE user_id = $${params.length}`;
    await sql.unsafe(query, params);
  } else {
    // Insert new user metrics
    await sql`
      INSERT INTO user_metrics (user_id, username, total_commands, successful_commands, failed_commands, total_convert, total_download, total_optimize, total_info, total_file_size, last_command_at, updated_at)
      VALUES (${userId}, ${username}, ${metrics.totalCommands || 0}, ${metrics.successfulCommands || 0}, ${metrics.failedCommands || 0}, ${metrics.totalConvert || 0}, ${metrics.totalDownload || 0}, ${metrics.totalOptimize || 0}, ${metrics.totalInfo || 0}, ${metrics.totalFileSize || 0}, ${metrics.lastCommandAt || timestamp}, ${timestamp})
    `;
  }
}

/**
 * Get user metrics by user ID
 * @param {string} userId - Discord user ID
 * @returns {Promise<Object|null>} User metrics or null if not found
 */
export async function getUserMetrics(userId) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return null;
  }

  const result = await sql`SELECT * FROM user_metrics WHERE user_id = ${userId}`;
  if (result.length === 0) {
    return null;
  }
  // Convert timestamp fields from strings to numbers
  let converted = convertTimestampsToNumbers(result[0], USER_METRICS_TIMESTAMP_FIELDS);
  // Convert numeric BIGINT fields from strings to numbers
  converted = convertBigIntToNumbers(converted, USER_METRICS_NUMERIC_FIELDS);
  return converted;
}

/**
 * Get all users with metrics
 * @param {Object} options - Query options
 * @param {string} [options.search] - Search in username
 * @param {string} [options.sortBy] - Sort field (default: 'total_commands')
 * @param {boolean} [options.sortDesc] - Sort descending (default: true)
 * @param {number} [options.limit] - Limit results
 * @param {number} [options.offset] - Offset for pagination
 * @returns {Promise<Array>} Array of user metrics
 */
export async function getAllUsersMetrics(options = {}) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return [];
  }

  const {
    search = null,
    sortBy = 'total_commands',
    sortDesc = true,
    limit = null,
    offset = null,
  } = options;

  // Whitelist allowed sort columns
  const allowedSortColumns = [
    'user_id',
    'username',
    'total_commands',
    'successful_commands',
    'failed_commands',
    'total_convert',
    'total_download',
    'total_optimize',
    'total_info',
    'total_file_size',
    'last_command_at',
    'updated_at',
  ];

  const safeSortBy = allowedSortColumns.includes(sortBy) ? sortBy : 'total_commands';

  try {
    // Build query using sql.unsafe() for dynamic ORDER BY (column names are whitelisted)
    let query = 'SELECT * FROM user_metrics';
    const params = [];

    if (search) {
      query += ` WHERE username ILIKE $${params.length + 1}`;
      params.push(`%${search}%`);
    }

    // ORDER BY with sanitized column name (already whitelisted)
    query += ` ORDER BY ${safeSortBy} ${sortDesc ? 'DESC' : 'ASC'}`;

    if (limit !== null && limit !== undefined) {
      query += ` LIMIT $${params.length + 1}`;
      params.push(limit);
    }

    if (offset !== null && offset !== undefined) {
      query += ` OFFSET $${params.length + 1}`;
      params.push(offset);
    }

    const result = await sql.unsafe(query, params);

    // Ensure we return an array
    if (!Array.isArray(result)) {
      console.error('getAllUsersMetrics: query did not return an array:', typeof result, result);
      return [];
    }
    // Convert timestamp fields from strings to numbers
    let converted = convertTimestampsInArray(result, USER_METRICS_TIMESTAMP_FIELDS);
    // Convert numeric BIGINT fields from strings to numbers
    converted = convertBigIntInArray(converted, USER_METRICS_NUMERIC_FIELDS);
    return converted;
  } catch (error) {
    console.error('Error in getAllUsersMetrics:', error);
    throw error;
  }
}

/**
 * Get count of users with metrics
 * @param {Object} options - Query options
 * @param {string} [options.search] - Search in username
 * @returns {Promise<number>} Total count
 */
export async function getUserMetricsCount(options = {}) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return 0;
  }

  const { search = null } = options;

  try {
    let result;
    if (search) {
      result =
        await sql`SELECT COUNT(*) as count FROM user_metrics WHERE username ILIKE ${`%${search}%`}`;
    } else {
      result = await sql`SELECT COUNT(*) as count FROM user_metrics`;
    }

    // Ensure result is an array and extract count
    if (!Array.isArray(result) || result.length === 0) {
      return 0;
    }
    const count = result[0]?.count;
    return parseInt(count || 0, 10);
  } catch (error) {
    console.error('Error in getUserMetricsCount:', error);
    throw error;
  }
}

/**
 * Get counts of users active within recent windows, plus the all-time total.
 * "Active" means last_command_at falls within the window - every row in
 * user_metrics has run at least one command, so the unfiltered count doubles
 * as the all-time "ever used the bot" total.
 * @returns {Promise<{total: number, active7d: number, active30d: number}>}
 */
export async function getActiveUserCounts() {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return { total: 0, active7d: 0, active30d: 0 };
  }

  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  try {
    const result = await sql`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE last_command_at >= ${sevenDaysAgo}) AS active_7d,
        COUNT(*) FILTER (WHERE last_command_at >= ${thirtyDaysAgo}) AS active_30d
      FROM user_metrics
    `;

    const row = result[0] || {};
    return {
      total: parseInt(row.total || 0, 10),
      active7d: parseInt(row.active_7d || 0, 10),
      active30d: parseInt(row.active_30d || 0, 10),
    };
  } catch (error) {
    console.error('Error in getActiveUserCounts:', error);
    throw error;
  }
}
