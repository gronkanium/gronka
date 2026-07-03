import { getPostgresConnection } from './connection.js';
import { ensurePostgresInitialized } from './init.js';
import { convertTimestampsInArray } from './helpers-pg.js';

/**
 * Insert a log entry into the database
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @param {string} component - Service name (bot, server, webui)
 * @param {string} level - Log level (DEBUG, INFO, WARN, ERROR)
 * @param {string} message - Log message
 * @param {Object} [metadata] - Optional metadata object (will be JSON stringified)
 * @returns {Promise<void>}
 */
export async function insertLog(timestamp, component, level, message, metadata = null) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return;
  }

  const metadataStr = metadata ? JSON.stringify(metadata) : null;

  await sql`
    INSERT INTO logs (timestamp, component, level, message, metadata)
    VALUES (${timestamp}, ${component}, ${level}, ${message}, ${metadataStr})
  `;
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
 * @returns {Promise<Array>} Array of log entries
 */
export async function getLogs(options = {}) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
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
    excludeComponentLevels = null,
  } = options;

  // Build query parts
  const conditions = [];
  const params = [];

  if (component) {
    conditions.push(`component = $${params.length + 1}`);
    params.push(component);
  }

  if (excludedComponents && Array.isArray(excludedComponents) && excludedComponents.length > 0) {
    const placeholders = excludedComponents.map((_, i) => `$${params.length + i + 1}`).join(',');
    conditions.push(`component NOT IN (${placeholders})`);
    params.push(...excludedComponents);
  }

  if (
    excludeComponentLevels &&
    Array.isArray(excludeComponentLevels) &&
    excludeComponentLevels.length > 0
  ) {
    for (const { component: comp, level: lvl } of excludeComponentLevels) {
      conditions.push(`NOT (component = $${params.length + 1} AND level = $${params.length + 2})`);
      params.push(comp, lvl);
    }
  }

  if (level) {
    if (Array.isArray(level)) {
      const placeholders = level.map((_, i) => `$${params.length + i + 1}`).join(',');
      conditions.push(`level IN (${placeholders})`);
      params.push(...level);
    } else {
      conditions.push(`level = $${params.length + 1}`);
      params.push(level);
    }
  }

  if (startTime !== null) {
    conditions.push(`timestamp >= $${params.length + 1}`);
    params.push(startTime);
  }

  if (endTime !== null) {
    conditions.push(`timestamp <= $${params.length + 1}`);
    params.push(endTime);
  }

  if (search) {
    conditions.push(`message ILIKE $${params.length + 1}`);
    params.push(`%${search}%`);
  }

  let query = 'SELECT * FROM logs';
  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(' AND ')}`;
  }

  query += ` ORDER BY timestamp ${orderDesc ? 'DESC' : 'ASC'}`;

  if (limit !== null) {
    query += ` LIMIT $${params.length + 1}`;
    params.push(limit);
  }

  if (offset !== null) {
    query += ` OFFSET $${params.length + 1}`;
    params.push(offset);
  }

  const rawLogs = await sql.unsafe(query, params);

  // Parse metadata JSON strings into objects and convert timestamps to numbers
  const logs = rawLogs.map(log => {
    let metadata = null;
    if (log.metadata) {
      try {
        metadata = JSON.parse(log.metadata);
      } catch (error) {
        console.error('Failed to parse metadata for log:', error);
        metadata = log.metadata;
      }
    }
    return {
      ...log,
      metadata,
    };
  });

  // Convert timestamp fields from strings to numbers
  return convertTimestampsInArray(logs, ['timestamp']);
}

/**
 * Get total count of logs matching filters
 * @param {Object} options - Query options (same as getLogs)
 * @returns {Promise<number>} Total count of matching logs
 */
export async function getLogsCount(options = {}) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return 0;
  }

  const {
    component = null,
    level = null,
    startTime = null,
    endTime = null,
    search = null,
    excludedComponents = null,
    excludeComponentLevels = null,
  } = options;

  const conditions = [];
  const params = [];

  if (component) {
    conditions.push(`component = $${params.length + 1}`);
    params.push(component);
  }

  if (excludedComponents && Array.isArray(excludedComponents) && excludedComponents.length > 0) {
    const placeholders = excludedComponents.map((_, i) => `$${params.length + i + 1}`).join(',');
    conditions.push(`component NOT IN (${placeholders})`);
    params.push(...excludedComponents);
  }

  if (
    excludeComponentLevels &&
    Array.isArray(excludeComponentLevels) &&
    excludeComponentLevels.length > 0
  ) {
    for (const { component: comp, level: lvl } of excludeComponentLevels) {
      conditions.push(`NOT (component = $${params.length + 1} AND level = $${params.length + 2})`);
      params.push(comp, lvl);
    }
  }

  if (level) {
    if (Array.isArray(level)) {
      const placeholders = level.map((_, i) => `$${params.length + i + 1}`).join(',');
      conditions.push(`level IN (${placeholders})`);
      params.push(...level);
    } else {
      conditions.push(`level = $${params.length + 1}`);
      params.push(level);
    }
  }

  if (startTime !== null) {
    conditions.push(`timestamp >= $${params.length + 1}`);
    params.push(startTime);
  }

  if (endTime !== null) {
    conditions.push(`timestamp <= $${params.length + 1}`);
    params.push(endTime);
  }

  if (search) {
    conditions.push(`message ILIKE $${params.length + 1}`);
    params.push(`%${search}%`);
  }

  let query = 'SELECT COUNT(*) as count FROM logs';
  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(' AND ')}`;
  }

  const result = await sql.unsafe(query, params);
  return parseInt(result[0]?.count || 0, 10);
}

/**
 * Get all unique components from logs
 * @returns {Promise<string[]>} Array of component names
 */
export async function getLogComponents() {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return [];
  }

  const results = await sql`SELECT DISTINCT component FROM logs ORDER BY component`;
  return results.map(r => r.component);
}
