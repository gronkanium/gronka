import {
  initPostgresConnection,
  getPostgresConnection,
  setPostgresConnection,
  getPostgresInitPromise,
  setPostgresInitPromise,
} from './connection.js';
import { getTableDefinitions, getIndexDefinitions, runMigrations } from './schema-pg.js';
import { createLogger } from '../logger.js';

const logger = createLogger('postgres');

// Bot, workers and web all boot at once; this key serializes their schema setup.
const SCHEMA_LOCK_KEY = 0x67726f6e;

export async function applySchema(sql) {
  await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(${SCHEMA_LOCK_KEY})`;
    for (const table of getTableDefinitions()) {
      await tx.unsafe(table.sql);
    }
    await runMigrations(tx);
    for (const index of getIndexDefinitions()) {
      await tx.unsafe(index.sql);
    }
  });
}

export async function initPostgresDatabase() {
  // This MUST be checked first to prevent race conditions in parallel tests
  const initPromise = getPostgresInitPromise();
  if (initPromise) {
    await initPromise;
    return;
  }

  const sql = getPostgresConnection();
  if (sql) {
    return; // Already initialized
  }

  const newInitPromise = (async () => {
    try {
      const connection = await initPostgresConnection();
      setPostgresConnection(connection);

      await applySchema(connection);

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

// Realigns SERIAL sequences with each table's max id after a restore; skipped in tests, where parallel runs race on it
async function resetSerialSequences(sql) {
  // Skip sequence reset in test mode - it can cause race conditions
  // with parallel test execution and tests don't need it (they create fresh data)
  const { isTestMode } = await import('./connection.js');
  if (isTestMode()) {
    return;
  }

  const tablesWithSerial = [{ table: 'alerts', sequence: 'alerts_id_seq', column: 'id' }];

  for (const { table, sequence, column } of tablesWithSerial) {
    try {
      // Get the maximum ID from the table using sql.unsafe for dynamic table/column names
      const maxQuery = `SELECT COALESCE(MAX(${column}), 0) as max_id FROM ${table}`;
      const maxResult = await sql.unsafe(maxQuery);
      const maxId = parseInt(maxResult[0]?.max_id || 0, 10);

      // Reset the sequence to max_id + 1 (or 1 if table is empty).
      // GREATEST ensures the sequence only ever moves forward: multiple processes
      // (bot + webui, or parallel test files) can run this concurrently, and moving
      // a sequence backwards while another process is inserting hands out
      // already-used ids and causes duplicate-key errors.
      const nextVal = maxId > 0 ? maxId + 1 : 1;
      await sql.unsafe(
        `SELECT setval('${sequence}', GREATEST(COALESCE((SELECT last_value FROM ${sequence}), 1), ${nextVal}), false)`
      );
    } catch (error) {
      // If sequence doesn't exist yet or table doesn't exist, that's okay
      // It will be created on first insert
      logger.warn(`Could not reset sequence ${sequence} for table ${table}: ${error.message}`);
    }
  }
}

export async function closePostgresDatabase() {
  const { closePostgresConnection } = await import('./connection.js');
  await closePostgresConnection();
  setPostgresConnection(null);
  setPostgresInitPromise(null);
}

// The connection is published before the schema is applied, so the init promise is the only
// proof the tables exist; checking the connection first let early callers query missing tables.
export async function ensurePostgresInitialized() {
  const initPromise = getPostgresInitPromise();
  if (initPromise) {
    await initPromise;
    return;
  }
  if (getPostgresConnection()) return;
  await initPostgresDatabase();
}
