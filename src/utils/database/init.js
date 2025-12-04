import {
  initPostgresConnection,
  getPostgresConnection,
  setPostgresConnection,
  getPostgresInitPromise,
  setPostgresInitPromise,
} from './connection.js';
import {
  getTableDefinitions,
  getIndexDefinitions,
  addFileSizeColumnIfNeeded,
} from './schema-pg.js';

/**
 * Initialize PostgreSQL database and create tables
 * @returns {Promise<void>}
 */
export async function initPostgresDatabase() {
  // If initialization is in progress, wait for it
  // This MUST be checked first to prevent race conditions in parallel tests
  const initPromise = getPostgresInitPromise();
  if (initPromise) {
    await initPromise;
    return;
  }

  // If already initialized, return immediately
  const sql = getPostgresConnection();
  if (sql) {
    return; // Already initialized
  }

  // Start initialization
  const newInitPromise = (async () => {
    try {
      // Initialize connection
      const connection = await initPostgresConnection();
      setPostgresConnection(connection);

      // Create tables with error handling for type conflicts
      const tables = getTableDefinitions();
      for (const table of tables) {
        try {
          await connection.unsafe(table.sql);
        } catch (error) {
          // Handle duplicate type/table errors that can occur in parallel test execution
          // 42710: duplicate type error
          // 42P07: duplicate table/relation error
          if (
            error.code === '42710' ||
            error.code === '42P07' ||
            error.message?.includes('pg_type_typname_nsp_index')
          ) {
            console.warn(
              `[Database Init] Conflict for table "${table.name}" (${error.code || 'unknown'}), dropping and recreating...`
            );
            // Drop the table first, then the type, then recreate
            // PostgreSQL won't allow dropping a type that a table depends on
            await connection.unsafe(`DROP TABLE IF EXISTS ${table.name} CASCADE`);
            await connection.unsafe(`DROP TYPE IF EXISTS ${table.name} CASCADE`);
            await connection.unsafe(table.sql);
          } else {
            throw error;
          }
        }
      }

      // Create indexes with error handling for race conditions
      const indexes = getIndexDefinitions();
      for (const index of indexes) {
        try {
          await connection.unsafe(index.sql);
        } catch (error) {
          // Handle index conflicts in parallel test execution
          // 23505: unique constraint violation (race condition in pg_class catalog)
          // 42P07: relation already exists (race condition despite IF NOT EXISTS)
          if (error.code === '23505' || error.code === '42P07') {
            // Index already exists or is being created, this is safe to ignore
            console.warn(
              `[Database Init] Index "${index.name}" already exists (${error.code}), skipping...`
            );
          } else {
            throw error;
          }
        }
      }

      // Add file_size column if needed (for migration compatibility)
      await addFileSizeColumnIfNeeded(connection);

      // Reset SERIAL sequences to match existing data (fixes duplicate key errors after migration)
      await resetSerialSequences(connection);
    } catch (error) {
      setPostgresInitPromise(null); // Reset on error so it can be retried
      setPostgresConnection(null);
      throw error;
    }
  })();

  setPostgresInitPromise(newInitPromise);
  return newInitPromise;
}

/**
 * Reset SERIAL sequences to match the maximum ID in each table
 * This fixes duplicate key errors after data migration
 * NOTE: Skipped in test mode to prevent race conditions with parallel test execution
 * @param {Object} sql - The postgres.js client instance
 * @returns {Promise<void>}
 */
async function resetSerialSequences(sql) {
  // Skip sequence reset in test mode - it can cause race conditions
  // with parallel test execution and tests don't need it (they create fresh data)
  const { isTestMode } = await import('./connection.js');
  if (isTestMode()) {
    return;
  }

  const tablesWithSerial = [
    { table: 'logs', sequence: 'logs_id_seq', column: 'id' },
    { table: 'operation_logs', sequence: 'operation_logs_id_seq', column: 'id' },
    { table: 'system_metrics', sequence: 'system_metrics_id_seq', column: 'id' },
    { table: 'alerts', sequence: 'alerts_id_seq', column: 'id' },
    { table: 'temporary_uploads', sequence: 'temporary_uploads_id_seq', column: 'id' },
  ];

  for (const { table, sequence, column } of tablesWithSerial) {
    try {
      // Get the maximum ID from the table using sql.unsafe for dynamic table/column names
      const maxQuery = `SELECT COALESCE(MAX(${column}), 0) as max_id FROM ${table}`;
      const maxResult = await sql.unsafe(maxQuery);
      const maxId = parseInt(maxResult[0]?.max_id || 0, 10);

      // Reset the sequence to max_id + 1 (or 1 if table is empty)
      // Use setval with false to set the current value without incrementing
      const nextVal = maxId > 0 ? maxId + 1 : 1;
      await sql.unsafe(`SELECT setval('${sequence}', ${nextVal}, false)`);
    } catch (error) {
      // If sequence doesn't exist yet or table doesn't exist, that's okay
      // It will be created on first insert
      console.warn(`Could not reset sequence ${sequence} for table ${table}:`, error.message);
    }
  }
}

/**
 * Close PostgreSQL database connection
 * @returns {Promise<void>}
 */
export async function closePostgresDatabase() {
  const { closePostgresConnection } = await import('./connection.js');
  await closePostgresConnection();
  setPostgresConnection(null);
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
