import {
  initPostgresConnection,
  getPostgresConnection,
  setPostgresConnection,
  getPostgresInitPromise,
  setPostgresInitPromise,
} from './connection-pg.js';
import {
  getTableDefinitions,
  getIndexDefinitions,
  addFileSizeColumnIfNeeded,
} from './schema-pg.js';
import { setDb, setDbType } from './connection.js';

/**
 * Initialize PostgreSQL database and create tables
 * @returns {Promise<void>}
 */
export async function initPostgresDatabase() {
  const sql = getPostgresConnection();
  if (sql) {
    return; // Already initialized
  }

  // If initialization is in progress, wait for it
  const initPromise = getPostgresInitPromise();
  if (initPromise) {
    return initPromise;
  }

  // Start initialization
  const newInitPromise = (async () => {
    try {
      // Initialize connection
      const connection = await initPostgresConnection();
      setPostgresConnection(connection);
      setDb(connection);
      setDbType('postgres');

      // Create tables
      const tables = getTableDefinitions();
      for (const table of tables) {
        await connection.unsafe(table.sql);
      }

      // Create indexes
      const indexes = getIndexDefinitions();
      for (const index of indexes) {
        await connection.unsafe(index.sql);
      }

      // Add file_size column if needed (for migration compatibility)
      await addFileSizeColumnIfNeeded(connection);
    } catch (error) {
      setPostgresInitPromise(null); // Reset on error so it can be retried
      setPostgresConnection(null);
      setDb(null);
      throw error;
    }
  })();

  setPostgresInitPromise(newInitPromise);
  return newInitPromise;
}

/**
 * Close PostgreSQL database connection
 * @returns {Promise<void>}
 */
export async function closePostgresDatabase() {
  const { closePostgresConnection } = await import('./connection-pg.js');
  await closePostgresConnection();
  setPostgresConnection(null);
  setDb(null);
  setPostgresInitPromise(null);
}

/**
 * Ensure PostgreSQL database is initialized before performing operations
 * @returns {Promise<void>}
 */
export async function ensurePostgresInitialized() {
  const sql = getPostgresConnection();
  if (sql) {
    return; // Already initialized
  }

  // If initialization is in progress, wait for it
  const initPromise = getPostgresInitPromise();
  if (initPromise) {
    await initPromise;
    return;
  }

  // Start initialization if not already started
  await initPostgresDatabase();
}
