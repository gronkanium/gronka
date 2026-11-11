import { getPostgresConnection } from './connection.js';
import { ensurePostgresInitialized, withSchemaLock } from './init.js';
import { runMigrations } from './schema-pg.js';

// Accounts are gone: a key is its id and keyed hash, nothing else. Existing keys keep working.
async function dropWebAccounts(sql) {
  await sql`DROP TABLE IF EXISTS web_sessions, web_recovery_codes, web_passkeys, web_accounts CASCADE`;
  await sql`
    ALTER TABLE web_api_keys
      DROP COLUMN IF EXISTS account_id,
      DROP COLUMN IF EXISTS label,
      DROP COLUMN IF EXISTS created_on,
      DROP COLUMN IF EXISTS last_used_on`;
}

// Append only, like the bot's: a name recorded in schema_migrations never runs again.
const WEB_MIGRATIONS = [['drop_web_accounts', dropWebAccounts]];

export async function ensureWebSchema() {
  await ensurePostgresInitialized();
  await withSchemaLock(getPostgresConnection(), async tx => {
    await tx`
      CREATE TABLE IF NOT EXISTS web_api_keys (
        id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL
      )`;
    await runMigrations(tx, WEB_MIGRATIONS);
  });
}

export async function insertApiKey(id, secretHash) {
  const sql = getPostgresConnection();
  const rows = await sql`
    INSERT INTO web_api_keys (id, secret_hash) VALUES (${id}, ${secretHash})
    ON CONFLICT (id) DO NOTHING RETURNING id`;
  return rows.length > 0;
}

export async function getApiKeyHash(id) {
  const sql = getPostgresConnection();
  const [row] = await sql`SELECT secret_hash FROM web_api_keys WHERE id = ${id}`;
  return row?.secret_hash ?? null;
}

export async function deleteApiKey(id) {
  const sql = getPostgresConnection();
  await sql`DELETE FROM web_api_keys WHERE id = ${id}`;
}
