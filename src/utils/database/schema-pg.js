/**
 * PostgreSQL schema definitions
 * Converts SQLite schema to PostgreSQL syntax
 */

export function getTableDefinitions() {
  return [
    {
      name: 'schema_migrations',
      sql: `
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name TEXT PRIMARY KEY,
          applied_at BIGINT NOT NULL
        );
      `,
    },

    {
      name: 'alerts',
      sql: `
        CREATE TABLE IF NOT EXISTS alerts (
          id SERIAL PRIMARY KEY,
          timestamp BIGINT NOT NULL,
          severity TEXT NOT NULL,
          component TEXT NOT NULL,
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          metadata TEXT
        );
      `,
    },
    {
      name: 'bot_settings',
      sql: `
        CREATE TABLE IF NOT EXISTS bot_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at BIGINT NOT NULL
        );
      `,
    },

    {
      name: 'command_counts',
      sql: `
        CREATE TABLE IF NOT EXISTS command_counts (
          hour BIGINT NOT NULL,
          command TEXT NOT NULL,
          outcome TEXT NOT NULL,
          count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (hour, command, outcome)
        );
      `,
    },
    {
      name: 'media_jobs',
      sql: `
        CREATE TABLE IF NOT EXISTS media_jobs (
          id BIGSERIAL PRIMARY KEY,
          kind TEXT NOT NULL,
          args JSONB NOT NULL,
          reply JSONB NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          attempts INTEGER NOT NULL DEFAULT 0,
          operation_id TEXT,
          worker TEXT,
          error TEXT,
          created_at BIGINT NOT NULL,
          timestamp BIGINT NOT NULL,
          heartbeat_at BIGINT
        );
      `,
    },
    {
      name: 'media_workers',
      sql: `
        CREATE TABLE IF NOT EXISTS media_workers (
          id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          version TEXT,
          started_at BIGINT NOT NULL,
          seen_at BIGINT NOT NULL,
          rss BIGINT,
          cpu REAL,
          running INTEGER NOT NULL DEFAULT 0
        );
      `,
    },
  ];
}

export function getIndexDefinitions() {
  return [
    {
      name: 'idx_alerts_timestamp',
      sql: 'CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp);',
    },
    {
      name: 'idx_alerts_severity',
      sql: 'CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity);',
    },
    {
      name: 'idx_alerts_component',
      sql: 'CREATE INDEX IF NOT EXISTS idx_alerts_component ON alerts(component);',
    },

    {
      name: 'idx_media_jobs_status',
      sql: 'CREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_jobs(status, id);',
    },

    {
      name: 'idx_media_jobs_timestamp',
      sql: 'CREATE INDEX IF NOT EXISTS idx_media_jobs_timestamp ON media_jobs(timestamp);',
    },
    {
      name: 'idx_media_jobs_operation_id',
      sql: 'CREATE INDEX IF NOT EXISTS idx_media_jobs_operation_id ON media_jobs(operation_id) WHERE operation_id IS NOT NULL;',
    },
  ];
}

// Each is a prefix of another index or has about four distinct values; they only cost writes.
async function dropRedundantIndexes(sql) {
  for (const name of [
    'idx_logs_component',
    'idx_logs_level',
    'idx_operation_logs_operation_id',
    'idx_operation_logs_status',
    'idx_operation_logs_step',
  ]) {
    await sql.unsafe(`DROP INDEX IF EXISTS ${name}`);
  }
}

// Nothing is deduplicated or banned any more, so these tables have no reader.
async function dropUrlCacheAndBans(sql) {
  await sql`DROP TABLE IF EXISTS temporary_uploads, processed_urls, banned_users CASCADE`;
}

// No per-request or per-user history: only failures (alerts) and anonymous hourly counts remain.
async function dropRequestHistory(sql) {
  const [{ exists }] = await sql`SELECT to_regclass('user_metrics') IS NOT NULL AS exists`;
  if (exists) {
    // Lifetime totals survive as one anonymous row; the per-user rows do not.
    await sql`
      INSERT INTO command_counts (hour, command, outcome, count)
      SELECT 0, 'earlier', o.outcome, o.count FROM (
        SELECT 'success' AS outcome, COALESCE(SUM(total_commands - failed_commands), 0)::int AS count
        FROM user_metrics
        UNION ALL
        SELECT 'error', COALESCE(SUM(failed_commands), 0)::int FROM user_metrics
      ) o WHERE o.count > 0
      ON CONFLICT DO NOTHING`;
  }
  await sql`DROP TABLE IF EXISTS logs, operation_logs, user_metrics, users CASCADE`;
  await sql`ALTER TABLE alerts DROP COLUMN IF EXISTS user_id, DROP COLUMN IF EXISTS operation_id`;
  await sql`DROP INDEX IF EXISTS idx_alerts_operation_id`;
  await sql`ALTER TABLE media_jobs DROP COLUMN IF EXISTS user_id`;
}

// Without the Message Content intent a server's messages arrive empty, so a custom prefix can't be read.
async function dropGuildPrefixes(sql) {
  await sql`DROP TABLE IF EXISTS guild_prefixes CASCADE`;
}

// Rows older versions left behind: success alerts, failures with unredacted errors, finished jobs.
async function purgeEarlierRows(sql) {
  await sql`DELETE FROM media_jobs WHERE status NOT IN ('queued', 'running')`;
  await sql`
    DELETE FROM alerts WHERE component <> 'r2-cleanup'
      AND NOT (title = 'command failed' AND metadata LIKE '%"errorClass"%')`;
}

// Append only: a name, once recorded in schema_migrations, never runs again.
const MIGRATIONS = [
  ['drop_redundant_indexes', dropRedundantIndexes],
  ['drop_url_cache_and_bans', dropUrlCacheAndBans],
  ['drop_request_history', dropRequestHistory],
  ['drop_guild_prefixes', dropGuildPrefixes],
  ['purge_earlier_rows', purgeEarlierRows],
];

export async function runMigrations(sql) {
  const applied = new Set((await sql`SELECT name FROM schema_migrations`).map(r => r.name));
  for (const [name, migrate] of MIGRATIONS) {
    if (!applied.has(name)) {
      await migrate(sql);
      await sql`INSERT INTO schema_migrations (name, applied_at) VALUES (${name}, ${Date.now()})`;
    }
  }
}
