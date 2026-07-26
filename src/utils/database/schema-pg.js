/**
 * PostgreSQL schema definitions
 * Converts SQLite schema to PostgreSQL syntax
 */

/**
 * Get all table creation SQL statements
 * @returns {Array<{name: string, sql: string}>} Array of table definitions
 */
export function getTableDefinitions() {
  return [
    {
      name: 'users',
      sql: `
        CREATE TABLE IF NOT EXISTS users (
          user_id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          first_used BIGINT NOT NULL,
          last_used BIGINT NOT NULL
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
          username TEXT NOT NULL,
          total_commands BIGINT DEFAULT 0,
          successful_commands BIGINT DEFAULT 0,
          failed_commands BIGINT DEFAULT 0,
          total_convert BIGINT DEFAULT 0,
          total_download BIGINT DEFAULT 0,
          total_optimize BIGINT DEFAULT 0,
          total_info BIGINT DEFAULT 0,
          total_file_size BIGINT DEFAULT 0,
          last_command_at BIGINT,
          updated_at BIGINT NOT NULL
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
  ];
}

/**
 * Get all index creation SQL statements
 * @returns {Array<{name: string, sql: string}>} Array of index definitions
 */
export function getIndexDefinitions() {
  return [
    {
      name: 'idx_users_user_id',
      sql: 'CREATE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id);',
    },
    {
      name: 'idx_users_last_used',
      sql: 'CREATE INDEX IF NOT EXISTS idx_users_last_used ON users(last_used);',
    },
    {
      name: 'idx_logs_timestamp',
      sql: 'CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);',
    },
    {
      name: 'idx_logs_component',
      sql: 'CREATE INDEX IF NOT EXISTS idx_logs_component ON logs(component);',
    },
    {
      name: 'idx_logs_level',
      sql: 'CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);',
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
      name: 'idx_operation_logs_operation_id',
      sql: 'CREATE INDEX IF NOT EXISTS idx_operation_logs_operation_id ON operation_logs(operation_id);',
    },
    {
      name: 'idx_operation_logs_timestamp',
      sql: 'CREATE INDEX IF NOT EXISTS idx_operation_logs_timestamp ON operation_logs(timestamp);',
    },
    {
      name: 'idx_operation_logs_status',
      sql: 'CREATE INDEX IF NOT EXISTS idx_operation_logs_status ON operation_logs(status);',
    },
    {
      name: 'idx_operation_logs_step',
      sql: 'CREATE INDEX IF NOT EXISTS idx_operation_logs_step ON operation_logs(step);',
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
      name: 'idx_temporary_uploads_url_hash',
      sql: 'CREATE INDEX IF NOT EXISTS idx_temporary_uploads_url_hash ON temporary_uploads(url_hash);',
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
  ];
}

async function columnExists(sql, tableName, columnName) {
  const result = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = ${tableName}
      AND column_name = ${columnName}
  `;
  return result.length > 0;
}

export async function addFileSizeColumnIfNeeded(sql) {
  const exists = await columnExists(sql, 'processed_urls', 'file_size');
  if (!exists) {
    await sql`ALTER TABLE processed_urls ADD COLUMN file_size BIGINT`;
  }
}

/**
 * Add r2_expired_at column to processed_urls if it doesn't exist (for migration).
 * Set by the R2 cleanup job once a row's backing R2 upload has actually expired
 * and been removed, so callers can stop treating file_url as resolvable without
 * losing the historical processed_urls row (used for request-count stats).
 * @param {postgres.Sql} sql - PostgreSQL connection
 * @returns {Promise<void>}
 */
export async function addR2ExpiredAtColumnIfNeeded(sql) {
  const exists = await columnExists(sql, 'processed_urls', 'r2_expired_at');
  if (!exists) {
    await sql`ALTER TABLE processed_urls ADD COLUMN r2_expired_at BIGINT`;
  }
}

/**
 * Ensure temporary_uploads.url_hash foreign key cascades on delete (for migration).
 * Without this, deleting a processed_urls row that still has a temporary_uploads
 * reference fails with a foreign key violation - the R2 file gets deleted but the
 * DB row is left behind.
 * @param {postgres.Sql} sql - PostgreSQL connection
 * @returns {Promise<void>}
 */
export async function ensureTemporaryUploadsCascadeDelete(sql) {
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
