import { getPostgresConnection } from './connection.js';
import { ensurePostgresInitialized } from './init.js';

const TIME_SERIES_TABLES = [
  { table: 'logs', column: 'timestamp' },
  { table: 'operation_logs', column: 'timestamp' },
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

// Never a row whose R2 upload is still live: that orphans the object with nothing left to expire it.
export async function pruneUrlCache(cutoff) {
  await ensurePostgresInitialized();
  const sql = getPostgresConnection();
  const result = await sql`
    DELETE FROM processed_urls
    WHERE processed_at < ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM temporary_uploads t
        WHERE t.url_hash = processed_urls.url_hash AND t.deleted_at IS NULL
      )
  `;
  return result.count ?? 0;
}
