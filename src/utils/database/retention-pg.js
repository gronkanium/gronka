import { getPostgresConnection } from './connection.js';
import { ensurePostgresInitialized } from './init.js';

const TIME_SERIES_TABLES = [
  { table: 'alerts', column: 'timestamp' },
  { table: 'media_jobs', column: 'timestamp' },
];

const DELETE_BATCH = 5000;

// Batched so a first run against a large backlog cannot hold one long transaction.
export async function pruneTimeSeriesRows(cutoff) {
  await ensurePostgresInitialized();
  const sql = getPostgresConnection();
  const deleted = {};
  for (const { table, column } of TIME_SERIES_TABLES) {
    deleted[table] = 0;
    for (;;) {
      const result = await sql.unsafe(
        `DELETE FROM ${table} WHERE ctid = ANY(ARRAY(
           SELECT ctid FROM ${table} WHERE ${column} < $1 LIMIT ${DELETE_BATCH}
         ))`,
        [cutoff]
      );
      deleted[table] += result.count ?? 0;
      if ((result.count ?? 0) < DELETE_BATCH) {
        break;
      }
    }
  }
  return deleted;
}
