/**
 * Database test helper functions for cleaning up test data
 */

import { getPostgresConnection } from './connection.js';

/**
 * Flag to track if schema has been verified (prevents parallel checks)
 * @type {boolean}
 */
let logsSchemaVerified = false;

/**
 * Ensure the logs table has the correct schema (SERIAL PRIMARY KEY on id)
 * This checks if the table needs to be recreated and only does it once per process
 * @returns {Promise<void>}
 */
export async function ensureLogsTableSchema() {
  // Only verify once per process to avoid race conditions
  if (logsSchemaVerified) {
    return;
  }

  const sql = getPostgresConnection();
  if (!sql) {
    return;
  }

  try {
    // Check if the logs table exists and has a SERIAL id column
    const columnInfo = await sql`
      SELECT column_name, column_default
      FROM information_schema.columns
      WHERE table_name = 'logs'
        AND table_schema = 'public'
        AND column_name = 'id'
    `;

    // If id column exists with a sequence default, schema is correct
    if (columnInfo.length > 0 && columnInfo[0].column_default?.includes('nextval')) {
      logsSchemaVerified = true;
      return;
    }

    // Table has wrong schema or doesn't exist - recreate it
    console.warn('[Test Helper] Logs table has incorrect schema, recreating...');
    await sql`DROP TABLE IF EXISTS logs CASCADE`;
    await sql`
      CREATE TABLE logs (
        id SERIAL PRIMARY KEY,
        timestamp BIGINT NOT NULL,
        component TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata TEXT
      )
    `;
    // Recreate indexes
    await sql`CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_logs_component ON logs(component)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_logs_component_timestamp ON logs(component, timestamp)`;

    logsSchemaVerified = true;
  } catch (error) {
    // Mark as verified even on error to prevent repeated attempts
    logsSchemaVerified = true;
    console.warn('[Test Helper] Could not verify logs table schema:', error.message);
  }
}

/**
 * Truncate all tables in the test database
 * This ensures clean state between test files running in parallel
 * @returns {Promise<void>}
 */
export async function truncateAllTables() {
  const sql = getPostgresConnection();
  if (!sql) {
    throw new Error('Database connection not initialized');
  }

  try {
    // Truncate all tables but DO NOT reset sequences
    // RESTART IDENTITY would cause race conditions with parallel tests
    // CASCADE ensures that foreign key constraints don't block truncation
    await sql`
      TRUNCATE TABLE 
        logs,
        users,
        processed_urls,
        operation_logs,
        user_metrics,
        system_metrics,
        alerts,
        temporary_uploads
      CASCADE
    `;
  } catch (error) {
    // If truncate fails (e.g., tables don't exist yet), that's okay
    console.warn('Warning: Failed to truncate tables:', error.message);
  }
}

/**
 * Clear all data from tables without resetting sequences
 * Useful for clearing data between individual tests
 * @returns {Promise<void>}
 */
export async function clearAllData() {
  const sql = getPostgresConnection();
  if (!sql) {
    throw new Error('Database connection not initialized');
  }

  try {
    await sql`DELETE FROM logs`;
    await sql`DELETE FROM operation_logs`;
    await sql`DELETE FROM processed_urls`;
    await sql`DELETE FROM users`;
    await sql`DELETE FROM user_metrics`;
    await sql`DELETE FROM system_metrics`;
    await sql`DELETE FROM alerts`;
    await sql`DELETE FROM temporary_uploads`;
  } catch (error) {
    console.warn('Warning: Failed to clear data:', error.message);
  }
}

// ============================================================================
// Test Data Uniqueness Helpers
// These helpers ensure test data is unique across parallel test execution
// to prevent race conditions and primary key collisions
// ============================================================================

/**
 * Counter for generating unique test namespaces within a process
 * @type {number}
 */
let testFileCounter = 0;

/**
 * Global counter for timestamp uniqueness within the same millisecond
 * Incremented on each call to ensure uniqueness even in rapid succession
 * @type {number}
 */
let timestampCounter = 0;

/**
 * Global counter for component uniqueness within the same millisecond
 * @type {number}
 */
let componentCounter = 0;

/**
 * Base offset using process PID to ensure uniqueness across parallel test processes
 * Multiplied by 10 billion to provide ample separation between processes
 * This allows for millions of timestamps per process without collision
 * @type {number}
 */
const TEST_OFFSET_BASE = process.pid * 10000000000;

/**
 * Get a unique namespace for the current test file
 * Useful for prefixing component names or other identifiers
 * @returns {string} Unique namespace string
 */
export function getTestNamespace() {
  return `test_${process.pid}_${++testFileCounter}`;
}

/**
 * Get a unique timestamp for test data insertion
 * Combines Date.now() with a process-specific offset and an incrementing counter
 * to guarantee uniqueness even when called multiple times in the same millisecond
 * @param {number} [offset=0] - Additional offset to add (for multiple inserts in same test)
 * @returns {number} Unique timestamp
 */
export function getUniqueTestTimestamp(offset = 0) {
  // Increment counter to ensure uniqueness even within the same millisecond
  timestampCounter++;
  return Date.now() + TEST_OFFSET_BASE + timestampCounter * 1000 + offset;
}

/**
 * Get a unique component name for test data
 * Combines base name with PID and incrementing counter for guaranteed uniqueness
 * @param {string} base - Base component name (e.g., 'test', 'bot', 'webui')
 * @returns {string} Unique component name
 */
export function getUniqueTestComponent(base) {
  componentCounter++;
  return `${base}_${process.pid}_${componentCounter}`;
}
