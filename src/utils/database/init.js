import Database from 'better-sqlite3';
import {
  getDb,
  setDb,
  getInitPromise,
  setInitPromise,
  getDbPath,
  ensureDataDir,
} from './connection.js';

/**
 * Initialize the database and create tables
 * @returns {Promise<void>}
 */
export async function initDatabase() {
  const db = getDb();
  if (db) {
    return; // Already initialized
  }

  // If initialization is in progress, wait for it
  const initPromise = getInitPromise();
  if (initPromise) {
    return initPromise;
  }

  // Start initialization
  const newInitPromise = (async () => {
    try {
      ensureDataDir();

      const newDb = new Database(getDbPath());
      setDb(newDb);

      // Enable WAL mode for better concurrency
      newDb.pragma('journal_mode = WAL');

      // Create users table
      newDb.exec(`
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
      newDb.exec(`
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
      newDb.exec(`
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
        newDb.exec(`ALTER TABLE processed_urls ADD COLUMN file_size INTEGER`);
      } catch (error) {
        // Column already exists, ignore error
        if (!error.message.includes('duplicate column name')) {
          console.error('Failed to add file_size column:', error);
        }
      }

      // Create operation_logs table for detailed operation tracking
      newDb.exec(`
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
      newDb.exec(`
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
      newDb.exec(`
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
      newDb.exec(`
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

      // Create temporary_uploads table for tracking temporary R2 uploads with TTL
      newDb.exec(`
        CREATE TABLE IF NOT EXISTS temporary_uploads (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          url_hash TEXT NOT NULL,
          r2_key TEXT NOT NULL,
          uploaded_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          deleted_at INTEGER,
          deletion_failed INTEGER DEFAULT 0,
          deletion_error TEXT,
          FOREIGN KEY (url_hash) REFERENCES processed_urls(url_hash),
          UNIQUE(url_hash, r2_key)
        );

        CREATE INDEX IF NOT EXISTS idx_temporary_uploads_expires_at ON temporary_uploads(expires_at);
        CREATE INDEX IF NOT EXISTS idx_temporary_uploads_r2_key ON temporary_uploads(r2_key);
        CREATE INDEX IF NOT EXISTS idx_temporary_uploads_url_hash ON temporary_uploads(url_hash);
        CREATE INDEX IF NOT EXISTS idx_temporary_uploads_deleted_at ON temporary_uploads(deleted_at);
        CREATE INDEX IF NOT EXISTS idx_temporary_uploads_deletion_failed ON temporary_uploads(deletion_failed);
      `);
    } catch (error) {
      setInitPromise(null); // Reset on error so it can be retried
      setDb(null);
      throw error;
    }
  })();

  setInitPromise(newInitPromise);
  return newInitPromise;
}

/**
 * Close the database connection
 * @returns {void}
 */
export function closeDatabase() {
  const db = getDb();
  if (db) {
    db.close();
    setDb(null);
  }
  setInitPromise(null); // Reset init promise so database can be reinitialized
}

/**
 * Ensure database is initialized before performing operations
 * @returns {Promise<void>}
 */
export async function ensureDbInitialized() {
  const db = getDb();
  if (db) {
    return; // Already initialized
  }

  // If initialization is in progress, wait for it
  const initPromise = getInitPromise();
  if (initPromise) {
    await initPromise;
    return;
  }

  // Start initialization if not already started
  await initDatabase();
}
