import { getDb } from './connection.js';

/**
 * Insert a log entry into the database
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @param {string} component - Service name (bot, server, webui)
 * @param {string} level - Log level (DEBUG, INFO, WARN, ERROR)
 * @param {string} message - Log message
 * @param {Object} [metadata] - Optional metadata object (will be JSON stringified)
 * @returns {void}
 */
export function insertLog(timestamp, component, level, message, metadata = null) {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return;
  }

  const metadataStr = metadata ? JSON.stringify(metadata) : null;

  const stmt = db.prepare(
    'INSERT INTO logs (timestamp, component, level, message, metadata) VALUES (?, ?, ?, ?, ?)'
  );
  stmt.run(timestamp, component, level, message, metadataStr);
}

/**
 * Query logs with optional filters
 * @param {Object} options - Query options
 * @param {string} [options.component] - Filter by component
 * @param {string|string[]} [options.level] - Filter by level (single or array)
 * @param {number} [options.startTime] - Start timestamp (inclusive)
 * @param {number} [options.endTime] - End timestamp (inclusive)
 * @param {string} [options.search] - Search in message (case-insensitive)
 * @param {number} [options.limit] - Maximum number of results
 * @param {number} [options.offset] - Offset for pagination
 * @param {boolean} [options.orderDesc=true] - Order by timestamp descending
 * @returns {Array} Array of log entries
 */
export function getLogs(options = {}) {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return [];
  }

  const {
    component = null,
    level = null,
    startTime = null,
    endTime = null,
    search = null,
    limit = null,
    offset = null,
    orderDesc = true,
    excludedComponents = null,
    excludeComponentLevels = null, // Array of {component, level} objects to exclude
  } = options;

  let query = 'SELECT * FROM logs WHERE 1=1';
  const params = [];

  if (component) {
    query += ' AND component = ?';
    params.push(component);
  }

  if (excludedComponents && Array.isArray(excludedComponents) && excludedComponents.length > 0) {
    const placeholders = excludedComponents.map(() => '?').join(',');
    query += ` AND component NOT IN (${placeholders})`;
    params.push(...excludedComponents);
  }

  // Exclude specific component+level combinations (e.g., webui INFO logs)
  if (
    excludeComponentLevels &&
    Array.isArray(excludeComponentLevels) &&
    excludeComponentLevels.length > 0
  ) {
    excludeComponentLevels.forEach(({ component: comp, level: lvl }) => {
      query += ' AND NOT (component = ? AND level = ?)';
      params.push(comp, lvl);
    });
  }

  if (level) {
    if (Array.isArray(level)) {
      // Multiple levels
      const placeholders = level.map(() => '?').join(',');
      query += ` AND level IN (${placeholders})`;
      params.push(...level);
    } else {
      // Single level
      query += ' AND level = ?';
      params.push(level);
    }
  }

  if (startTime !== null) {
    query += ' AND timestamp >= ?';
    params.push(startTime);
  }

  if (endTime !== null) {
    query += ' AND timestamp <= ?';
    params.push(endTime);
  }

  if (search) {
    query += ' AND message LIKE ?';
    params.push(`%${search}%`);
  }

  query += ` ORDER BY timestamp ${orderDesc ? 'DESC' : 'ASC'}`;

  if (limit !== null) {
    query += ' LIMIT ?';
    params.push(limit);
  }

  if (offset !== null) {
    query += ' OFFSET ?';
    params.push(offset);
  }

  const stmt = db.prepare(query);
  const rawLogs = stmt.all(...params);

  // Parse metadata JSON strings into objects
  return rawLogs.map(log => {
    let metadata = null;
    if (log.metadata) {
      try {
        metadata = JSON.parse(log.metadata);
      } catch (error) {
        console.error('Failed to parse metadata for log:', error);
        // Keep as string if parsing fails
        metadata = log.metadata;
      }
    }
    return {
      ...log,
      metadata,
    };
  });
}

/**
 * Get total count of logs matching filters
 * @param {Object} options - Query options (same as getLogs)
 * @returns {number} Total count of matching logs
 */
export function getLogsCount(options = {}) {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return 0;
  }

  const {
    component = null,
    level = null,
    startTime = null,
    endTime = null,
    search = null,
    excludedComponents = null,
    excludeComponentLevels = null, // Array of {component, level} objects to exclude
  } = options;

  let query = 'SELECT COUNT(*) as count FROM logs WHERE 1=1';
  const params = [];

  if (component) {
    query += ' AND component = ?';
    params.push(component);
  }

  if (excludedComponents && Array.isArray(excludedComponents) && excludedComponents.length > 0) {
    const placeholders = excludedComponents.map(() => '?').join(',');
    query += ` AND component NOT IN (${placeholders})`;
    params.push(...excludedComponents);
  }

  // Exclude specific component+level combinations (e.g., webui INFO logs)
  if (
    excludeComponentLevels &&
    Array.isArray(excludeComponentLevels) &&
    excludeComponentLevels.length > 0
  ) {
    excludeComponentLevels.forEach(({ component: comp, level: lvl }) => {
      query += ' AND NOT (component = ? AND level = ?)';
      params.push(comp, lvl);
    });
  }

  if (level) {
    if (Array.isArray(level)) {
      const placeholders = level.map(() => '?').join(',');
      query += ` AND level IN (${placeholders})`;
      params.push(...level);
    } else {
      query += ' AND level = ?';
      params.push(level);
    }
  }

  if (startTime !== null) {
    query += ' AND timestamp >= ?';
    params.push(startTime);
  }

  if (endTime !== null) {
    query += ' AND timestamp <= ?';
    params.push(endTime);
  }

  if (search) {
    query += ' AND message LIKE ?';
    params.push(`%${search}%`);
  }

  const stmt = db.prepare(query);
  const result = stmt.get(...params);
  return result ? result.count : 0;
}

/**
 * Get all unique components from logs
 * @returns {string[]} Array of component names
 */
export function getLogComponents() {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return [];
  }

  const stmt = db.prepare('SELECT DISTINCT component FROM logs ORDER BY component');
  const results = stmt.all();
  return results.map(r => r.component);
}

/**
 * Get log metrics for dashboard
 * @param {Object} options - Options
 * @param {number} [options.timeRange] - Time range in milliseconds (default: last 24 hours)
 * @param {string[]} [options.excludedComponents] - Components to exclude from metrics
 * @returns {Object} Metrics object
 */
export function getLogMetrics(options = {}) {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return {
      total: 0,
      byLevel: {},
      byComponent: {},
      errorCount1h: 0,
      errorCount24h: 0,
      warnCount1h: 0,
      warnCount24h: 0,
    };
  }

  const { timeRange: timeRangeOption, excludedComponents = null } = options;

  const now = Date.now();
  const timeRange = timeRangeOption || 24 * 60 * 60 * 1000; // 24 hours
  const oneHourAgo = now - 60 * 60 * 1000;
  const startTime = now - timeRange;

  // Build exclusion clause if needed
  let exclusionClause = '';
  let exclusionParams = [];
  if (excludedComponents && Array.isArray(excludedComponents) && excludedComponents.length > 0) {
    const placeholders = excludedComponents.map(() => '?').join(',');
    exclusionClause = ` AND component NOT IN (${placeholders})`;
    exclusionParams = excludedComponents;
  }

  // Total logs in time range
  const totalQuery = `SELECT COUNT(*) as count FROM logs WHERE timestamp >= ?${exclusionClause}`;
  const totalStmt = db.prepare(totalQuery);
  const totalResult = totalStmt.get(startTime, ...exclusionParams);
  const total = totalResult ? totalResult.count : 0;

  // Logs by level in time range
  const levelQuery = `SELECT level, COUNT(*) as count FROM logs WHERE timestamp >= ?${exclusionClause} GROUP BY level`;
  const levelStmt = db.prepare(levelQuery);
  const levelResults = levelStmt.all(startTime, ...exclusionParams);
  const byLevel = {};
  levelResults.forEach(row => {
    byLevel[row.level] = row.count;
  });

  // Logs by component in time range (only ERROR and WARN levels)
  const componentQuery = `SELECT component, COUNT(*) as count FROM logs WHERE timestamp >= ? AND (level = 'ERROR' OR level = 'WARN')${exclusionClause} GROUP BY component ORDER BY count DESC`;
  const componentStmt = db.prepare(componentQuery);
  const componentResults = componentStmt.all(startTime, ...exclusionParams);
  const byComponent = {};
  componentResults.forEach(row => {
    byComponent[row.component] = row.count;
  });

  // Error count in last hour
  const errorCount1hQuery = `SELECT COUNT(*) as count FROM logs WHERE level = ? AND timestamp >= ?${exclusionClause}`;
  const errorCount1hStmt = db.prepare(errorCount1hQuery);
  const errorCount1h = errorCount1hStmt.get('ERROR', oneHourAgo, ...exclusionParams)?.count || 0;

  // Error count in last 24 hours
  const errorCount24h = byLevel['ERROR'] || 0;

  // Warning count in last hour
  const warnCount1h = errorCount1hStmt.get('WARN', oneHourAgo, ...exclusionParams)?.count || 0;

  // Warning count in last 24 hours
  const warnCount24h = byLevel['WARN'] || 0;

  // Recent errors timeline (last 24 hours, grouped by hour)
  const errorTimelineQuery = `
    SELECT 
      (timestamp / 3600000) * 3600000 as hour,
      COUNT(*) as count
    FROM logs 
    WHERE level = 'ERROR' AND timestamp >= ?${exclusionClause}
    GROUP BY hour
    ORDER BY hour ASC
  `;
  const errorTimelineStmt = db.prepare(errorTimelineQuery);
  const errorTimeline = errorTimelineStmt.all(startTime, ...exclusionParams);

  return {
    total,
    byLevel,
    byComponent,
    errorCount1h,
    errorCount24h,
    warnCount1h,
    warnCount24h,
    errorTimeline,
  };
}
