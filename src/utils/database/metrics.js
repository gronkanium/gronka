import { getDb } from './connection.js';

/**
 * Insert or update user metrics
 * @param {string} userId - Discord user ID
 * @param {string} username - Discord username
 * @param {Object} metrics - Metrics to update
 * @returns {void}
 */
export function insertOrUpdateUserMetrics(userId, username, metrics) {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return;
  }

  const timestamp = Date.now();

  // Check if user metrics exist
  const getStmt = db.prepare('SELECT * FROM user_metrics WHERE user_id = ?');
  const existing = getStmt.get(userId);

  if (existing) {
    // Build update query dynamically based on provided metrics
    const updates = [];
    const params = [];

    if (metrics.totalCommands !== undefined) {
      updates.push('total_commands = total_commands + ?');
      params.push(metrics.totalCommands);
    }
    if (metrics.successfulCommands !== undefined) {
      updates.push('successful_commands = successful_commands + ?');
      params.push(metrics.successfulCommands);
    }
    if (metrics.failedCommands !== undefined) {
      updates.push('failed_commands = failed_commands + ?');
      params.push(metrics.failedCommands);
    }
    if (metrics.totalConvert !== undefined) {
      updates.push('total_convert = total_convert + ?');
      params.push(metrics.totalConvert);
    }
    if (metrics.totalDownload !== undefined) {
      updates.push('total_download = total_download + ?');
      params.push(metrics.totalDownload);
    }
    if (metrics.totalOptimize !== undefined) {
      updates.push('total_optimize = total_optimize + ?');
      params.push(metrics.totalOptimize);
    }
    if (metrics.totalInfo !== undefined) {
      updates.push('total_info = total_info + ?');
      params.push(metrics.totalInfo);
    }
    if (metrics.totalFileSize !== undefined) {
      updates.push('total_file_size = total_file_size + ?');
      params.push(metrics.totalFileSize);
    }
    if (metrics.lastCommandAt !== undefined) {
      updates.push('last_command_at = ?');
      params.push(metrics.lastCommandAt);
    }

    updates.push('username = ?', 'updated_at = ?');
    params.push(username, timestamp, userId);

    const updateStmt = db.prepare(
      `UPDATE user_metrics SET ${updates.join(', ')} WHERE user_id = ?`
    );
    updateStmt.run(...params);
  } else {
    // Insert new user metrics
    const insertStmt = db.prepare(
      'INSERT INTO user_metrics (user_id, username, total_commands, successful_commands, failed_commands, total_convert, total_download, total_optimize, total_info, total_file_size, last_command_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    insertStmt.run(
      userId,
      username,
      metrics.totalCommands || 0,
      metrics.successfulCommands || 0,
      metrics.failedCommands || 0,
      metrics.totalConvert || 0,
      metrics.totalDownload || 0,
      metrics.totalOptimize || 0,
      metrics.totalInfo || 0,
      metrics.totalFileSize || 0,
      metrics.lastCommandAt || timestamp,
      timestamp
    );
  }
}

/**
 * Get user metrics by user ID
 * @param {string} userId - Discord user ID
 * @returns {Object|null} User metrics or null if not found
 */
export function getUserMetrics(userId) {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return null;
  }

  const stmt = db.prepare('SELECT * FROM user_metrics WHERE user_id = ?');
  return stmt.get(userId) || null;
}

/**
 * Get all users with metrics
 * @param {Object} options - Query options
 * @param {string} [options.search] - Search in username
 * @param {string} [options.sortBy] - Sort field (default: 'total_commands')
 * @param {boolean} [options.sortDesc] - Sort descending (default: true)
 * @param {number} [options.limit] - Limit results
 * @param {number} [options.offset] - Offset for pagination
 * @returns {Array} Array of user metrics
 */
export function getAllUsersMetrics(options = {}) {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return [];
  }

  const {
    search = null,
    sortBy = 'total_commands',
    sortDesc = true,
    limit = null,
    offset = null,
  } = options;

  // Whitelist allowed sort columns to prevent SQL injection
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

  let query = 'SELECT * FROM user_metrics WHERE 1=1';
  const params = [];

  if (search) {
    query += ' AND username LIKE ?';
    params.push(`%${search}%`);
  }

  query += ` ORDER BY ${safeSortBy} ${sortDesc ? 'DESC' : 'ASC'}`;

  if (limit !== null) {
    query += ' LIMIT ?';
    params.push(limit);
  }

  if (offset !== null) {
    query += ' OFFSET ?';
    params.push(offset);
  }

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

/**
 * Get count of users with metrics
 * @param {Object} options - Query options
 * @param {string} [options.search] - Search in username
 * @returns {number} Total count
 */
export function getUserMetricsCount(options = {}) {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return 0;
  }

  const { search = null } = options;

  let query = 'SELECT COUNT(*) as count FROM user_metrics WHERE 1=1';
  const params = [];

  if (search) {
    query += ' AND username LIKE ?';
    params.push(`%${search}%`);
  }

  const stmt = db.prepare(query);
  const result = stmt.get(...params);
  return result ? result.count : 0;
}

/**
 * Insert system metrics snapshot
 * @param {Object} metrics - System metrics
 * @returns {void}
 */
export function insertSystemMetrics(metrics) {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
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

  const stmt = db.prepare(
    'INSERT INTO system_metrics (timestamp, cpu_usage, memory_usage, memory_total, disk_usage, disk_total, process_uptime, process_memory, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  stmt.run(
    timestamp,
    cpuUsage,
    memoryUsage,
    memoryTotal,
    diskUsage,
    diskTotal,
    processUptime,
    processMemory,
    metadataStr
  );
}

/**
 * Get system metrics
 * @param {Object} options - Query options
 * @param {number} [options.limit] - Limit results (default: 100)
 * @param {number} [options.startTime] - Start timestamp
 * @param {number} [options.endTime] - End timestamp
 * @returns {Array} Array of system metrics
 */
export function getSystemMetrics(options = {}) {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return [];
  }

  const { limit = 100, startTime = null, endTime = null } = options;

  let query = 'SELECT * FROM system_metrics WHERE 1=1';
  const params = [];

  if (startTime !== null) {
    query += ' AND timestamp >= ?';
    params.push(startTime);
  }

  if (endTime !== null) {
    query += ' AND timestamp <= ?';
    params.push(endTime);
  }

  query += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

/**
 * Get latest system metrics
 * @returns {Object|null} Latest system metrics or null
 */
export function getLatestSystemMetrics() {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return null;
  }

  const stmt = db.prepare('SELECT * FROM system_metrics ORDER BY timestamp DESC LIMIT 1');
  return stmt.get() || null;
}
