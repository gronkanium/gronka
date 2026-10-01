import { getPostgresConnection } from './connection.js';
import { ensurePostgresInitialized } from './init.js';
import {
  convertTimestampsInArray,
  convertTimestampsToNumbers,
  convertBigIntToNumbers,
  convertBigIntInArray,
} from './helpers-pg.js';

// Define numeric fields in user_metrics table that need conversion from BIGINT strings to numbers
const USER_METRICS_NUMERIC_FIELDS = ['total_commands', 'failed_commands'];

// Define timestamp fields in user_metrics table
const USER_METRICS_TIMESTAMP_FIELDS = ['first_used', 'last_command_at'];

export async function recordUserCommand(userId, { failed = false, at = Date.now() } = {}) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();

  await sql`
    INSERT INTO user_metrics (user_id, total_commands, failed_commands, first_used, last_command_at)
    VALUES (${userId}, 1, ${failed ? 1 : 0}, ${at}, ${at})
    ON CONFLICT (user_id) DO UPDATE SET
      total_commands = user_metrics.total_commands + 1,
      failed_commands = user_metrics.failed_commands + EXCLUDED.failed_commands,
      last_command_at = GREATEST(user_metrics.last_command_at, EXCLUDED.last_command_at)
  `;
}

/**
 * Get user metrics by user ID
 * @param {string} userId - Discord user ID
 * @returns {Promise<Object|null>} User metrics or null if not found
 */
export async function getUserMetrics(userId) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();

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

export async function getAllUsersMetrics(options = {}) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();

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
    'total_commands',
    'failed_commands',
    'first_used',
    'last_command_at',
  ];

  const safeSortBy = allowedSortColumns.includes(sortBy) ? sortBy : 'total_commands';

  try {
    // Build query using sql.unsafe() for dynamic ORDER BY (column names are whitelisted)
    let query = 'SELECT * FROM user_metrics';
    const params = [];

    if (search) {
      // Ids only, there is no name to search on any more.
      query += ` WHERE user_id LIKE $${params.length + 1}`;
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

export async function getUserMetricsCount(options = {}) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();

  const { search = null } = options;

  try {
    let result;
    if (search) {
      result =
        await sql`SELECT COUNT(*) as count FROM user_metrics WHERE user_id LIKE ${`%${search}%`}`;
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
