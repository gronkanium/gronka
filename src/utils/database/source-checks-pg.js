import { getPostgresConnection } from './connection.js';
import { ensurePostgresInitialized } from './init.js';

async function db() {
  await ensurePostgresInitialized();
  return getPostgresConnection();
}

export async function saveSourceCheck({ url, site, status, expected, got, cause, ms, at }) {
  const sql = await db();
  const passedAt = status === 'pass' ? at : null;
  await sql`
    INSERT INTO source_checks (url, site, status, expected, got, cause, ms, checked_at, passed_at)
    VALUES (${url}, ${site}, ${status}, ${expected}, ${got}, ${cause}, ${ms}, ${at}, ${passedAt})
    ON CONFLICT (url) DO UPDATE SET
      site = EXCLUDED.site, status = EXCLUDED.status, expected = EXCLUDED.expected,
      got = EXCLUDED.got, cause = EXCLUDED.cause, ms = EXCLUDED.ms,
      checked_at = EXCLUDED.checked_at,
      passed_at = COALESCE(EXCLUDED.passed_at, source_checks.passed_at)
  `;
}

export async function listSourceChecks() {
  const sql = await db();
  const rows = await sql`SELECT * FROM source_checks`;
  return rows.map(row => ({
    url: row.url,
    site: row.site,
    status: row.status,
    expected: row.expected,
    got: row.got,
    cause: row.cause,
    ms: row.ms === null ? null : Number(row.ms),
    checkedAt: Number(row.checked_at),
    passedAt: row.passed_at === null ? null : Number(row.passed_at),
  }));
}

export async function pruneSourceChecks(keepUrls) {
  const sql = await db();
  await sql`DELETE FROM source_checks WHERE NOT (url = ANY(${keepUrls}))`;
}
