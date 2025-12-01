import { getPostgresConnection } from './connection-pg.js';
import { ensurePostgresInitialized } from './init-pg.js';

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
  return result.length > 0 ? result[0] : null;
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
    return result;
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
 * Insert system metrics snapshot
 * @param {Object} metrics - System metrics
 * @returns {Promise<void>}
 */
export async function insertSystemMetrics(metrics) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return;
  }

  const timestamp = Date.now();
  const {
    cpuUsage = null,
    memoryUsage = null,
    memoryTotal = null,
    diskUsage = null,
    diskTotal = null,
    processUptime = null,
    processMemory = null,
    metadata = null,
  } = metrics;

  const metadataStr = metadata ? JSON.stringify(metadata) : null;

  await sql`
    INSERT INTO system_metrics (timestamp, cpu_usage, memory_usage, memory_total, disk_usage, disk_total, process_uptime, process_memory, metadata)
    VALUES (${timestamp}, ${cpuUsage}, ${memoryUsage}, ${memoryTotal}, ${diskUsage}, ${diskTotal}, ${processUptime}, ${processMemory}, ${metadataStr})
  `;
}

/**
 * Get system metrics
 * @param {Object} options - Query options
 * @param {number} [options.limit] - Limit results (default: 100)
 * @param {number} [options.startTime] - Start timestamp
 * @param {number} [options.endTime] - End timestamp
 * @returns {Promise<Array>} Array of system metrics
 */
export async function getSystemMetrics(options = {}) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return [];
  }

  const { limit = 100, startTime = null, endTime = null } = options;

  let query = 'SELECT * FROM system_metrics WHERE 1=1';
  const params = [];

  if (startTime !== null) {
    query += ` AND timestamp >= $${params.length + 1}`;
    params.push(startTime);
  }

  if (endTime !== null) {
    query += ` AND timestamp <= $${params.length + 1}`;
    params.push(endTime);
  }

  query += ` ORDER BY timestamp DESC LIMIT $${params.length + 1}`;
  params.push(limit);

  return await sql.unsafe(query, params);
}

/**
 * Get latest system metrics
 * @returns {Promise<Object|null>} Latest system metrics or null
 */
export async function getLatestSystemMetrics() {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return null;
  }

  const result = await sql`SELECT * FROM system_metrics ORDER BY timestamp DESC LIMIT 1`;
  return result.length > 0 ? result[0] : null;
}
