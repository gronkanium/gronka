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
      name: 'logs',
      sql: `
        CREATE TABLE IF NOT EXISTS logs (
          id SERIAL PRIMARY KEY,
          timestamp BIGINT NOT NULL,
          component TEXT NOT NULL,
          level TEXT NOT NULL,
          message TEXT NOT NULL,
          metadata TEXT
        );
      `,
    },
    {
      name: 'processed_urls',
      sql: `
        CREATE TABLE IF NOT EXISTS processed_urls (
          url_hash TEXT PRIMARY KEY,
          file_hash TEXT NOT NULL,
          file_type TEXT NOT NULL,
          file_extension TEXT,
          file_url TEXT NOT NULL,
          processed_at BIGINT NOT NULL,
          user_id TEXT,
          file_size BIGINT,
          r2_expired_at BIGINT
        );
      `,
    },
    {
      name: 'operation_logs',
      sql: `
        CREATE TABLE IF NOT EXISTS operation_logs (
          id SERIAL PRIMARY KEY,
          operation_id TEXT NOT NULL,
          timestamp BIGINT NOT NULL,
          step TEXT NOT NULL,
          status TEXT NOT NULL,
          message TEXT,
          file_path TEXT,
          stack_trace TEXT,
          metadata TEXT
        );
      `,
    },
    {
      name: 'user_metrics',
      sql: `
        CREATE TABLE IF NOT EXISTS user_metrics (
          user_id TEXT PRIMARY KEY,
          total_commands BIGINT DEFAULT 0,
          failed_commands BIGINT DEFAULT 0,
          first_used BIGINT NOT NULL,
          last_command_at BIGINT
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
          operation_id TEXT,
          user_id TEXT,
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
      name: 'temporary_uploads',
      sql: `
        CREATE TABLE IF NOT EXISTS temporary_uploads (
          id SERIAL PRIMARY KEY,
          url_hash TEXT NOT NULL,
          r2_key TEXT NOT NULL,
          uploaded_at BIGINT NOT NULL,
          expires_at BIGINT NOT NULL,
          deleted_at BIGINT,
          deletion_failed INTEGER DEFAULT 0,
          deletion_error TEXT,
          FOREIGN KEY (url_hash) REFERENCES processed_urls(url_hash) ON DELETE CASCADE,
          UNIQUE(url_hash, r2_key)
        );
      `,
    },
    {
      name: 'guild_prefixes',
      sql: `
        CREATE TABLE IF NOT EXISTS guild_prefixes (
          guild_id TEXT PRIMARY KEY,
          prefix TEXT NOT NULL,
          updated_at BIGINT NOT NULL
        );
      `,
    },
    {
      name: 'banned_users',
      sql: `
        CREATE TABLE IF NOT EXISTS banned_users (
          user_id TEXT PRIMARY KEY,
          reason TEXT NOT NULL,
          banned_at BIGINT NOT NULL,
          appeal_allowed BOOLEAN NOT NULL DEFAULT true
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
          user_id TEXT NOT NULL,
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
      name: 'idx_logs_timestamp',
      sql: 'CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);',
    },
    {
      name: 'idx_logs_component_timestamp',
      sql: 'CREATE INDEX IF NOT EXISTS idx_logs_component_timestamp ON logs(component, timestamp);',
    },
    {
      name: 'idx_processed_urls_file_hash',
      sql: 'CREATE INDEX IF NOT EXISTS idx_processed_urls_file_hash ON processed_urls(file_hash);',
    },
    {
      name: 'idx_processed_urls_processed_at',
      sql: 'CREATE INDEX IF NOT EXISTS idx_processed_urls_processed_at ON processed_urls(processed_at);',
    },
    {
      name: 'idx_processed_urls_user_id',
      sql: 'CREATE INDEX IF NOT EXISTS idx_processed_urls_user_id ON processed_urls(user_id);',
    },
    {
      name: 'idx_operation_logs_timestamp',
      sql: 'CREATE INDEX IF NOT EXISTS idx_operation_logs_timestamp ON operation_logs(timestamp);',
    },
    {
      name: 'idx_operation_logs_operation_id_timestamp',
      sql: 'CREATE INDEX IF NOT EXISTS idx_operation_logs_operation_id_timestamp ON operation_logs(operation_id, timestamp);',
    },
    {
      name: 'idx_operation_logs_step_status',
      sql: 'CREATE INDEX IF NOT EXISTS idx_operation_logs_step_status ON operation_logs(step, status);',
    },
    {
      name: 'idx_user_metrics_total_commands',
      sql: 'CREATE INDEX IF NOT EXISTS idx_user_metrics_total_commands ON user_metrics(total_commands);',
    },
    {
      name: 'idx_user_metrics_last_command_at',
      sql: 'CREATE INDEX IF NOT EXISTS idx_user_metrics_last_command_at ON user_metrics(last_command_at);',
    },
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
      name: 'idx_alerts_operation_id',
      sql: 'CREATE INDEX IF NOT EXISTS idx_alerts_operation_id ON alerts(operation_id);',
    },
    {
      name: 'idx_temporary_uploads_expires_at',
      sql: 'CREATE INDEX IF NOT EXISTS idx_temporary_uploads_expires_at ON temporary_uploads(expires_at);',
    },
    {
      name: 'idx_temporary_uploads_r2_key',
      sql: 'CREATE INDEX IF NOT EXISTS idx_temporary_uploads_r2_key ON temporary_uploads(r2_key);',
    },
    {
      name: 'idx_temporary_uploads_deleted_at',
      sql: 'CREATE INDEX IF NOT EXISTS idx_temporary_uploads_deleted_at ON temporary_uploads(deleted_at);',
    },
    {
      name: 'idx_temporary_uploads_deletion_failed',
      sql: 'CREATE INDEX IF NOT EXISTS idx_temporary_uploads_deletion_failed ON temporary_uploads(deletion_failed);',
    },
    {
      name: 'idx_guild_prefixes_updated_at',
      sql: 'CREATE INDEX IF NOT EXISTS idx_guild_prefixes_updated_at ON guild_prefixes(updated_at);',
    },
    {
      name: 'idx_processed_urls_r2_expired_at',
      sql: 'CREATE INDEX IF NOT EXISTS idx_processed_urls_r2_expired_at ON processed_urls(r2_expired_at);',
    },
    {
      name: 'idx_media_jobs_status',
      sql: 'CREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_jobs(status, id);',
    },
    {
      name: 'idx_operation_logs_status_update',
      sql: "CREATE INDEX IF NOT EXISTS idx_operation_logs_status_update ON operation_logs(operation_id, timestamp DESC) WHERE step = 'status_update';",
    },
    {
      name: 'idx_operation_logs_created',
      sql: "CREATE INDEX IF NOT EXISTS idx_operation_logs_created ON operation_logs(timestamp) WHERE step = 'created';",
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

async function columnExists(sql, tableName, columnName) {
  const result = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = ${tableName}
      AND column_name = ${columnName}
  `;
  return result.length > 0;
}

async function addFileSizeColumnIfNeeded(sql) {
  const exists = await columnExists(sql, 'processed_urls', 'file_size');
  if (!exists) {
    await sql`ALTER TABLE processed_urls ADD COLUMN file_size BIGINT`;
  }
}

// Add r2_expired_at column to processed_urls if it doesn't exist (for migration)
async function addR2ExpiredAtColumnIfNeeded(sql) {
  const exists = await columnExists(sql, 'processed_urls', 'r2_expired_at');
  if (!exists) {
    await sql`ALTER TABLE processed_urls ADD COLUMN r2_expired_at BIGINT`;
  }
}

// Drop the username columns if an older database still has them
async function dropUsernameColumnsIfPresent(sql) {
  await sql`ALTER TABLE user_metrics DROP COLUMN IF EXISTS username`;
}

// One row per user: request and failure counts, first and last use. Everything else was dropped.
export async function mergeUsersIntoUserMetrics(sql) {
  if (!(await columnExists(sql, 'user_metrics', 'updated_at'))) {
    return;
  }
  await sql`ALTER TABLE user_metrics ADD COLUMN IF NOT EXISTS first_used BIGINT`;
  if (await columnExists(sql, 'users', 'first_used')) {
    await sql`
      UPDATE user_metrics m SET first_used = u.first_used
      FROM users u WHERE u.user_id = m.user_id AND m.first_used IS NULL`;
  }
  await sql`
    UPDATE user_metrics m SET first_used = COALESCE(
      (SELECT MIN(processed_at) FROM processed_urls p WHERE p.user_id = m.user_id),
      m.last_command_at, 0)
    WHERE m.first_used IS NULL`;
  await sql`ALTER TABLE user_metrics ALTER COLUMN first_used SET NOT NULL`;
  await sql`DROP TABLE IF EXISTS users`;
  await sql`
    ALTER TABLE user_metrics
      DROP COLUMN IF EXISTS successful_commands, DROP COLUMN IF EXISTS total_convert,
      DROP COLUMN IF EXISTS total_download, DROP COLUMN IF EXISTS total_optimize,
      DROP COLUMN IF EXISTS total_info, DROP COLUMN IF EXISTS total_file_size,
      DROP COLUMN IF EXISTS updated_at`;
}

// Each is a prefix of another index or has about four distinct values; they only cost writes.
async function dropRedundantIndexes(sql) {
  for (const name of [
    'idx_logs_component',
    'idx_logs_level',
    'idx_operation_logs_operation_id',
    'idx_operation_logs_status',
    'idx_operation_logs_step',
    'idx_temporary_uploads_url_hash',
  ]) {
    await sql.unsafe(`DROP INDEX IF EXISTS ${name}`);
  }
}

// Append only: a name, once recorded in schema_migrations, never runs again.
const MIGRATIONS = [
  ['processed_urls_file_size', addFileSizeColumnIfNeeded],
  ['processed_urls_r2_expired_at', addR2ExpiredAtColumnIfNeeded],
  ['drop_username_columns', dropUsernameColumnsIfPresent],
  ['merge_users_into_user_metrics', mergeUsersIntoUserMetrics],
  ['temporary_uploads_cascade_delete', ensureTemporaryUploadsCascadeDelete],
  ['temporary_uploads_unique_key', ensureTemporaryUploadsUniqueKey],
  ['drop_redundant_indexes', dropRedundantIndexes],
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

// Ensure temporary_uploads.url_hash foreign key cascades on delete (for migration)
async function ensureTemporaryUploadsCascadeDelete(sql) {
  const result = await sql`
    SELECT confdeltype
    FROM pg_constraint
    WHERE conname = 'temporary_uploads_url_hash_fkey'
  `;
  // confdeltype 'c' means ON DELETE CASCADE already applied
  if (result.length > 0 && result[0].confdeltype !== 'c') {
    await sql`
      ALTER TABLE temporary_uploads
      DROP CONSTRAINT temporary_uploads_url_hash_fkey
    `;
    await sql`
      ALTER TABLE temporary_uploads
      ADD CONSTRAINT temporary_uploads_url_hash_fkey
      FOREIGN KEY (url_hash) REFERENCES processed_urls(url_hash) ON DELETE CASCADE
    `;
  }
}

// ON CONFLICT (url_hash, r2_key) is rejected without this key; older databases may lack it.
async function ensureTemporaryUploadsUniqueKey(sql) {
  const keyed = await sql`
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = 'temporary_uploads'::regclass AND i.indisunique AND i.indpred IS NULL
      AND (
        SELECT array_agg(a.attname::text ORDER BY a.attname)
        FROM unnest(i.indkey::int2[]) AS k(attnum)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      ) = ARRAY['r2_key', 'url_hash']`;
  if (keyed.length > 0) {
    return;
  }
  await sql`
    DELETE FROM temporary_uploads old USING temporary_uploads newer
    WHERE newer.url_hash = old.url_hash AND newer.r2_key = old.r2_key AND newer.id > old.id`;
  await sql`
    ALTER TABLE temporary_uploads
    ADD CONSTRAINT temporary_uploads_url_hash_r2_key_key UNIQUE (url_hash, r2_key)`;
}
