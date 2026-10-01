import { getPostgresConnection } from './connection.js';
import { ensurePostgresInitialized } from './init.js';
import { createLogger } from '../logger.js';
import { convertTimestampsToNumbers, convertTimestampsInArray } from './helpers-pg.js';

// Define timestamp fields in temporary_uploads table that need conversion from BIGINT strings to numbers
const TEMPORARY_UPLOADS_TIMESTAMP_FIELDS = ['uploaded_at', 'expires_at', 'deleted_at'];

// Lazy logger creation
let logger = null;
function getLogger() {
  if (!logger) {
    logger = createLogger('temporary-uploads');
  }
  return logger;
}

export async function insertTemporaryUpload(urlHash, r2Key, uploadedAt, expiresAt) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();

  const result = await sql`
    INSERT INTO temporary_uploads (url_hash, r2_key, uploaded_at, expires_at)
    VALUES (${urlHash}, ${r2Key}, ${uploadedAt}, ${expiresAt})
    ON CONFLICT (url_hash, r2_key) DO UPDATE SET
      uploaded_at = EXCLUDED.uploaded_at,
      expires_at = EXCLUDED.expires_at,
      deleted_at = NULL,
      deletion_failed = 0,
      deletion_error = NULL
    RETURNING *
  `;
  getLogger().debug(
    `Saved temporary upload record: id=${result[0].id}, url_hash=${urlHash.substring(0, 8)}..., r2_key=${r2Key}`
  );
  return convertTimestampsToNumbers(result[0], TEMPORARY_UPLOADS_TIMESTAMP_FIELDS);
}

// Total bytes of live (not expired, not deleted) temporary R2 uploads
export async function getLiveBytes(now) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();

  const result = await sql`
    SELECT COALESCE(SUM(p.file_size), 0) AS live_bytes
    FROM temporary_uploads t
    JOIN processed_urls p ON p.url_hash = t.url_hash
    WHERE t.deleted_at IS NULL AND t.expires_at > ${now}
  `;
  // SUM of BIGINT comes back as a string; coerce to a number.
  return Number(result[0]?.live_bytes ?? 0);
}

export async function getTemporaryUploadsByR2Key(r2Key) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();

  const results = await sql`SELECT * FROM temporary_uploads WHERE r2_key = ${r2Key}`;
  // Convert timestamp BIGINT fields from strings to numbers
  return convertTimestampsInArray(results, TEMPORARY_UPLOADS_TIMESTAMP_FIELDS);
}

export async function markTemporaryUploadDeletionFailed(id, error, retryCount) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();

  const result = await sql`
    UPDATE temporary_uploads
    SET deletion_failed = ${retryCount}, deletion_error = ${error}
    WHERE id = ${id}
  `;
  return result.count > 0;
}

export async function deleteTemporaryUploadsByR2Key(r2Key) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();

  const result = await sql`DELETE FROM temporary_uploads WHERE r2_key = ${r2Key}`;
  return result.count;
}

export async function getExpiredR2Keys(now) {
  await ensurePostgresInitialized();
  const sql = getPostgresConnection();
  // A key is only deletable once every upload sharing it has expired.
  const rows = await sql`
    SELECT r2_key FROM temporary_uploads
    GROUP BY r2_key
    HAVING COUNT(*) = COUNT(*) FILTER (WHERE expires_at < ${now} AND deleted_at IS NULL)
  `;
  return rows.map(row => row.r2_key);
}

// What is in R2 right now, what leaves next, and what failed to leave. Sizes come from
// processed_urls, same as getLiveBytes.
export async function getStorageOverview(now = Date.now()) {
  await ensurePostgresInitialized();
  const sql = getPostgresConnection();
  const hour = 3600 * 1000;
  const live = sql`t.deleted_at IS NULL AND t.expires_at > ${now}`;
  const [[totals], soon, biggest, [failed]] = await Promise.all([
    sql`
      SELECT COUNT(*)::int AS files, COALESCE(SUM(p.file_size), 0)::bigint AS bytes,
        COALESCE(SUM(p.file_size) FILTER (WHERE t.expires_at <= ${now + hour}), 0)::bigint AS h1,
        COALESCE(SUM(p.file_size) FILTER (WHERE t.expires_at <= ${now + 6 * hour}), 0)::bigint AS h6,
        COALESCE(SUM(p.file_size) FILTER (WHERE t.expires_at <= ${now + 24 * hour}), 0)::bigint AS h24
      FROM temporary_uploads t JOIN processed_urls p ON p.url_hash = t.url_hash WHERE ${live}
    `,
    sql`
      SELECT t.r2_key, t.uploaded_at, t.expires_at, p.file_size, p.file_url, p.user_id, p.file_type
      FROM temporary_uploads t JOIN processed_urls p ON p.url_hash = t.url_hash WHERE ${live}
      ORDER BY t.expires_at LIMIT 12
    `,
    sql`
      SELECT t.r2_key, t.uploaded_at, t.expires_at, p.file_size, p.file_url, p.user_id, p.file_type
      FROM temporary_uploads t JOIN processed_urls p ON p.url_hash = t.url_hash WHERE ${live}
      ORDER BY p.file_size DESC NULLS LAST LIMIT 8
    `,
    sql`
      SELECT COUNT(*)::int AS count, MAX(deletion_error) AS last_error
      FROM temporary_uploads WHERE deleted_at IS NULL AND deletion_failed > 0
    `,
  ]);
  const file = r => ({
    key: r.r2_key,
    uploadedAt: Number(r.uploaded_at),
    expiresAt: Number(r.expires_at),
    size: Number(r.file_size ?? 0),
    url: r.file_url,
    userId: r.user_id,
    type: r.file_type,
  });
  return {
    files: totals.files,
    bytes: Number(totals.bytes),
    expiring: { h1: Number(totals.h1), h6: Number(totals.h6), h24: Number(totals.h24) },
    soon: soon.map(file),
    biggest: biggest.map(file),
    deletionFailures: { count: failed.count, lastError: failed.last_error },
  };
}
