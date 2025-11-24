import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

/**
 * Get the database path (supports environment variable override for testing)
 * @returns {string} Database file path
 */
function getDbPath() {
  return process.env.GRONKA_DB_PATH || path.join(projectRoot, 'data', 'gronka.db');
}

let db = null;
let initPromise = null;

/**
 * Ensure data directory exists
 * @returns {void}
 */
function ensureDataDir() {
  try {
    const dataDir = path.dirname(getDbPath());
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * Initialize the database and create tables
 * @returns {Promise<void>}
 */
export async function initDatabase() {
  if (db) {
    return; // Already initialized
  }

  // If initialization is in progress, wait for it
  if (initPromise) {
    return initPromise;
  }

  // Start initialization
  initPromise = (async () => {
    try {
      ensureDataDir();

      db = new Database(getDbPath());

      // Enable WAL mode for better concurrency
      db.pragma('journal_mode = WAL');

      // Create users table
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          user_id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          first_used INTEGER NOT NULL,
          last_used INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id);
        CREATE INDEX IF NOT EXISTS idx_users_last_used ON users(last_used);
      `);

      // Create logs table
      db.exec(`
        CREATE TABLE IF NOT EXISTS logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          component TEXT NOT NULL,
          level TEXT NOT NULL,
          message TEXT NOT NULL,
          metadata TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
        CREATE INDEX IF NOT EXISTS idx_logs_component ON logs(component);
        CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
        CREATE INDEX IF NOT EXISTS idx_logs_component_timestamp ON logs(component, timestamp);
      `);

      // Create processed_urls table
      db.exec(`
        CREATE TABLE IF NOT EXISTS processed_urls (
          url_hash TEXT PRIMARY KEY,
          file_hash TEXT NOT NULL,
          file_type TEXT NOT NULL,
          file_extension TEXT,
          file_url TEXT NOT NULL,
          processed_at INTEGER NOT NULL,
          user_id TEXT,
          file_size INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_processed_urls_file_hash ON processed_urls(file_hash);
        CREATE INDEX IF NOT EXISTS idx_processed_urls_processed_at ON processed_urls(processed_at);
        CREATE INDEX IF NOT EXISTS idx_processed_urls_user_id ON processed_urls(user_id);
      `);

      // Add file_size column if it doesn't exist (for existing databases)
      try {
        db.exec(`ALTER TABLE processed_urls ADD COLUMN file_size INTEGER`);
      } catch (error) {
        // Column already exists, ignore error
        if (!error.message.includes('duplicate column name')) {
          console.error('Failed to add file_size column:', error);
        }
      }

      // Create operation_logs table for detailed operation tracking
      db.exec(`
        CREATE TABLE IF NOT EXISTS operation_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          operation_id TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          step TEXT NOT NULL,
          status TEXT NOT NULL,
          message TEXT,
          file_path TEXT,
          stack_trace TEXT,
          metadata TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_operation_logs_operation_id ON operation_logs(operation_id);
        CREATE INDEX IF NOT EXISTS idx_operation_logs_timestamp ON operation_logs(timestamp);
        CREATE INDEX IF NOT EXISTS idx_operation_logs_status ON operation_logs(status);
      `);

      // Create user_metrics table for aggregated statistics
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_metrics (
          user_id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          total_commands INTEGER DEFAULT 0,
          successful_commands INTEGER DEFAULT 0,
          failed_commands INTEGER DEFAULT 0,
          total_convert INTEGER DEFAULT 0,
          total_download INTEGER DEFAULT 0,
          total_optimize INTEGER DEFAULT 0,
          total_info INTEGER DEFAULT 0,
          total_file_size INTEGER DEFAULT 0,
          last_command_at INTEGER,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_user_metrics_total_commands ON user_metrics(total_commands);
        CREATE INDEX IF NOT EXISTS idx_user_metrics_last_command_at ON user_metrics(last_command_at);
      `);

      // Create system_metrics table for health monitoring
      db.exec(`
        CREATE TABLE IF NOT EXISTS system_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          cpu_usage REAL,
          memory_usage REAL,
          memory_total REAL,
          disk_usage REAL,
          disk_total REAL,
          process_uptime INTEGER,
          process_memory REAL,
          metadata TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_system_metrics_timestamp ON system_metrics(timestamp);
      `);

      // Create alerts table for notification history
      db.exec(`
        CREATE TABLE IF NOT EXISTS alerts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          severity TEXT NOT NULL,
          component TEXT NOT NULL,
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          operation_id TEXT,
          user_id TEXT,
          metadata TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp);
        CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity);
        CREATE INDEX IF NOT EXISTS idx_alerts_component ON alerts(component);
        CREATE INDEX IF NOT EXISTS idx_alerts_operation_id ON alerts(operation_id);
      `);
    } catch (error) {
      initPromise = null; // Reset on error so it can be retried
      throw error;
    }
  })();

  return initPromise;
}

/**
 * Close the database connection
 * @returns {void}
 */
export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
  initPromise = null; // Reset init promise so database can be reinitialized
}

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
 * Insert or update a user in the database
 * @param {string} userId - Discord user ID
 * @param {string} username - Discord username/tag
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {void}
 */
export function insertOrUpdateUser(userId, username, timestamp) {
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return;
  }

  if (!userId || typeof userId !== 'string') {
    return;
  }

  // Check if user exists
  const getUserStmt = db.prepare('SELECT first_used FROM users WHERE user_id = ?');
  const existing = getUserStmt.get(userId);

  if (existing) {
    // Update last_used and username (in case username changed)
    const updateStmt = db.prepare('UPDATE users SET last_used = ?, username = ? WHERE user_id = ?');
    updateStmt.run(timestamp, username, userId);
  } else {
    // Insert new user
    const insertStmt = db.prepare(
      'INSERT INTO users (user_id, username, first_used, last_used) VALUES (?, ?, ?, ?)'
    );
    insertStmt.run(userId, username, timestamp, timestamp);
  }
}

/**
 * Get user information from the database
 * @param {string} userId - Discord user ID
 * @returns {Object|null} User object or null if not found
 */
export function getUser(userId) {
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return null;
  }

  const stmt = db.prepare('SELECT * FROM users WHERE user_id = ?');
  return stmt.get(userId) || null;
}

/**
 * Get unique user count
 * @returns {number} Number of unique users
 */
export function getUniqueUserCount() {
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return 0;
  }

  const stmt = db.prepare('SELECT COUNT(*) as count FROM users');
  const result = stmt.get();
  return result ? result.count : 0;
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
  return stmt.all(...params);
}

/**
 * Get total count of logs matching filters
 * @param {Object} options - Query options (same as getLogs)
 * @returns {number} Total count of matching logs
 */
export function getLogsCount(options = {}) {
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

  // Logs by component in time range
  const componentQuery = `SELECT component, COUNT(*) as count FROM logs WHERE timestamp >= ?${exclusionClause} GROUP BY component ORDER BY count DESC`;
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

/**
 * Ensure database is initialized before performing operations
 * @returns {Promise<void>}
 */
async function ensureDbInitialized() {
  if (db) {
    return; // Already initialized
  }

  // If initialization is in progress, wait for it
  if (initPromise) {
    await initPromise;
    return;
  }

  // Start initialization if not already started
  await initDatabase();
}

/**
 * Get processed URL record by URL hash
 * @param {string} urlHash - SHA-256 hash of the URL
 * @returns {Promise<Object|null>} Processed URL record or null if not found
 */
export async function getProcessedUrl(urlHash) {
  await ensureDbInitialized();

  if (!db) {
    console.error('Database initialization failed.');
    return null;
  }

  const stmt = db.prepare('SELECT * FROM processed_urls WHERE url_hash = ?');
  return stmt.get(urlHash) || null;
}

/**
 * Insert or update a processed URL record
 * @param {string} urlHash - SHA-256 hash of the URL
 * @param {string} fileHash - File content hash (MD5 or SHA-256)
 * @param {string} fileType - File type ('gif', 'video', or 'image')
 * @param {string} fileExtension - File extension (e.g., '.mp4', '.gif')
 * @param {string} fileUrl - Final CDN URL or path
 * @param {number} processedAt - Unix timestamp in milliseconds
 * @param {string} [userId] - Discord user ID who requested it
 * @param {number} [fileSize] - File size in bytes
 * @returns {Promise<void>}
 */
export async function insertProcessedUrl(
  urlHash,
  fileHash,
  fileType,
  fileExtension,
  fileUrl,
  processedAt,
  userId = null,
  fileSize = null
) {
  await ensureDbInitialized();

  if (!db) {
    console.error('Database initialization failed. Cannot insert processed URL.');
    return;
  }

  try {
    // Check if record exists
    const existing = await getProcessedUrl(urlHash);
    if (existing) {
      // Update existing record (in case file URL or other info changed)
      const updateStmt = db.prepare(
        'UPDATE processed_urls SET file_hash = ?, file_type = ?, file_extension = ?, file_url = ?, processed_at = ?, user_id = ?, file_size = ? WHERE url_hash = ?'
      );
      updateStmt.run(
        fileHash,
        fileType,
        fileExtension,
        fileUrl,
        processedAt,
        userId,
        fileSize,
        urlHash
      );
    } else {
      // Insert new record
      const insertStmt = db.prepare(
        'INSERT INTO processed_urls (url_hash, file_hash, file_type, file_extension, file_url, processed_at, user_id, file_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      insertStmt.run(
        urlHash,
        fileHash,
        fileType,
        fileExtension,
        fileUrl,
        processedAt,
        userId,
        fileSize
      );
    }
  } catch (error) {
    // Log error but don't throw - allows graceful degradation if database is read-only
    console.error(`Failed to insert/update processed URL in database: ${error.message}`);
    // Re-throw if it's not a read-only error, as that indicates a real problem
    if (error.code !== 'SQLITE_READONLY') {
      throw error;
    }
  }
}

/**
 * Get processed URLs (media files) for a specific user
 * @param {string} userId - Discord user ID
 * @param {Object} options - Query options
 * @param {number} [options.limit] - Maximum number of results
 * @param {number} [options.offset] - Number of results to skip
 * @returns {Promise<Array>} Array of processed URL records
 */
export async function getUserMedia(userId, options = {}) {
  await ensureDbInitialized();

  if (!db) {
    console.error('Database initialization failed.');
    return [];
  }

  const { limit = null, offset = null } = options;

  let query =
    'SELECT file_url, file_type, file_extension, processed_at, file_size FROM processed_urls WHERE user_id = ? ORDER BY processed_at DESC';
  const params = [userId];

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
 * Get total count of processed URLs (media files) for a specific user
 * @param {string} userId - Discord user ID
 * @returns {Promise<number>} Total count of media files for the user
 */
export async function getUserMediaCount(userId) {
  await ensureDbInitialized();

  if (!db) {
    console.error('Database initialization failed.');
    return 0;
  }

  const stmt = db.prepare('SELECT COUNT(*) as count FROM processed_urls WHERE user_id = ?');
  const result = stmt.get(userId);
  return result ? result.count : 0;
}

/**
 * Insert an operation log entry
 * @param {string} operationId - Operation ID
 * @param {string} step - Step name (e.g., 'download_start', 'processing', 'complete')
 * @param {string} status - Status ('pending', 'running', 'success', 'error')
 * @param {Object} [data] - Optional data (message, filePath, stackTrace, metadata)
 * @returns {void}
 */
export function insertOperationLog(operationId, step, status, data = {}) {
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
 * Insert or update user metrics
 * @param {string} userId - Discord user ID
 * @param {string} username - Discord username
 * @param {Object} metrics - Metrics to update
 * @returns {void}
 */
export function insertOrUpdateUserMetrics(userId, username, metrics) {
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
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return null;
  }

  const stmt = db.prepare('SELECT * FROM system_metrics ORDER BY timestamp DESC LIMIT 1');
  return stmt.get() || null;
}

/**
 * Insert an alert/notification entry
 * @param {Object} alert - Alert data
 * @returns {void}
 */
export function insertAlert(alert) {
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return;
  }

  const timestamp = Date.now();
  const {
    severity,
    component,
    title,
    message,
    operationId = null,
    userId = null,
    metadata = null,
  } = alert;

  const metadataStr = metadata ? JSON.stringify(metadata) : null;

  const stmt = db.prepare(
    'INSERT INTO alerts (timestamp, severity, component, title, message, operation_id, user_id, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const result = stmt.run(
    timestamp,
    severity,
    component,
    title,
    message,
    operationId,
    userId,
    metadataStr
  );

  // Return the inserted alert record
  return {
    id: result.lastInsertRowid,
    timestamp,
    severity,
    component,
    title,
    message,
    operationId,
    userId,
    metadata: metadata ? JSON.parse(metadataStr) : null,
  };
}

/**
 * Get alerts with filtering
 * @param {Object} options - Query options
 * @param {string} [options.severity] - Filter by severity
 * @param {string} [options.component] - Filter by component
 * @param {number} [options.startTime] - Start timestamp
 * @param {number} [options.endTime] - End timestamp
 * @param {string} [options.search] - Search in title/message
 * @param {number} [options.limit] - Limit results
 * @param {number} [options.offset] - Offset for pagination
 * @returns {Array} Array of alerts
 */
export function getAlerts(options = {}) {
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return [];
  }

  const {
    severity = null,
    component = null,
    startTime = null,
    endTime = null,
    search = null,
    limit = null,
    offset = null,
  } = options;

  let query = 'SELECT * FROM alerts WHERE 1=1';
  const params = [];

  if (severity) {
    query += ' AND severity = ?';
    params.push(severity);
  }

  if (component) {
    query += ' AND component = ?';
    params.push(component);
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
    query += ' AND (title LIKE ? OR message LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  query += ' ORDER BY timestamp DESC';

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
 * Get count of alerts matching filters
 * @param {Object} options - Query options (same as getAlerts)
 * @returns {number} Total count
 */
export function getAlertsCount(options = {}) {
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return 0;
  }

  const {
    severity = null,
    component = null,
    startTime = null,
    endTime = null,
    search = null,
  } = options;

  let query = 'SELECT COUNT(*) as count FROM alerts WHERE 1=1';
  const params = [];

  if (severity) {
    query += ' AND severity = ?';
    params.push(severity);
  }

  if (component) {
    query += ' AND component = ?';
    params.push(component);
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
    query += ' AND (title LIKE ? OR message LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  const stmt = db.prepare(query);
  const result = stmt.get(...params);
  return result ? result.count : 0;
}
