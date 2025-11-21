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
          user_id TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_processed_urls_file_hash ON processed_urls(file_hash);
        CREATE INDEX IF NOT EXISTS idx_processed_urls_processed_at ON processed_urls(processed_at);
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
 * @param {string} [options.level] - Filter by level
 * @param {number} [options.startTime] - Start timestamp (inclusive)
 * @param {number} [options.endTime] - End timestamp (inclusive)
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
    limit = null,
    offset = null,
    orderDesc = true,
  } = options;

  let query = 'SELECT * FROM logs WHERE 1=1';
  const params = [];

  if (component) {
    query += ' AND component = ?';
    params.push(component);
  }

  if (level) {
    query += ' AND level = ?';
    params.push(level);
  }

  if (startTime !== null) {
    query += ' AND timestamp >= ?';
    params.push(startTime);
  }

  if (endTime !== null) {
    query += ' AND timestamp <= ?';
    params.push(endTime);
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
 * Get processed URL record by URL hash
 * @param {string} urlHash - SHA-256 hash of the URL
 * @returns {Object|null} Processed URL record or null if not found
 */
export function getProcessedUrl(urlHash) {
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
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
 * @returns {void}
 */
export function insertProcessedUrl(
  urlHash,
  fileHash,
  fileType,
  fileExtension,
  fileUrl,
  processedAt,
  userId = null
) {
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return;
  }

  // Check if record exists
  const existing = getProcessedUrl(urlHash);
  if (existing) {
    // Update existing record (in case file URL or other info changed)
    const updateStmt = db.prepare(
      'UPDATE processed_urls SET file_hash = ?, file_type = ?, file_extension = ?, file_url = ?, processed_at = ?, user_id = ? WHERE url_hash = ?'
    );
    updateStmt.run(fileHash, fileType, fileExtension, fileUrl, processedAt, userId, urlHash);
  } else {
    // Insert new record
    const insertStmt = db.prepare(
      'INSERT INTO processed_urls (url_hash, file_hash, file_type, file_extension, file_url, processed_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    insertStmt.run(urlHash, fileHash, fileType, fileExtension, fileUrl, processedAt, userId);
  }
}
