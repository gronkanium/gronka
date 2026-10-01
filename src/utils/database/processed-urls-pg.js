import { getPostgresConnection } from './connection.js';
import { r2Config } from '../config.js';
import { ensurePostgresInitialized } from './init.js';
import {
  convertTimestampsToNumbers,
  convertTimestampsInArray,
  convertBigIntToNumbers,
  convertBigIntInArray,
} from './helpers-pg.js';

// Query result cache for getProcessedUrl (in-memory layer on top of DB)
const processedUrlCache = new Map(); // Map<urlHash, {data, timestamp}>
const PROCESSED_URL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get cached processed URL if available and not expired
 * @param {string} urlHash - URL hash
 * @returns {Object|null} Cached processed URL or null
 */
function getCachedProcessedUrl(urlHash) {
  const cached = processedUrlCache.get(urlHash);
  if (!cached) {
    return null;
  }
  const age = Date.now() - cached.timestamp;
  if (age >= PROCESSED_URL_CACHE_TTL) {
    processedUrlCache.delete(urlHash);
    return null;
  }
  return cached.data;
}

/**
 * Cache processed URL
 * @param {string} urlHash - URL hash
 * @param {Object|null} processedUrl - Processed URL object to cache
 */
function setCachedProcessedUrl(urlHash, processedUrl) {
  processedUrlCache.set(urlHash, {
    data: processedUrl,
    timestamp: Date.now(),
  });
}

function invalidateProcessedUrlCache(urlHash = null) {
  if (urlHash) {
    processedUrlCache.delete(urlHash);
  } else {
    processedUrlCache.clear();
  }
}

/**
 * Get processed URL record by URL hash
 * @param {string} urlHash - sha256 hash of the URL
 * @returns {Promise<Object|null>} Processed URL record or null if not found
 */
export async function getProcessedUrl(urlHash) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();

  // Check in-memory cache first
  const cached = getCachedProcessedUrl(urlHash);
  if (cached !== null) {
    return cached;
  }

  const result = await sql`SELECT * FROM processed_urls WHERE url_hash = ${urlHash}`;
  const processedUrl = result.length > 0 ? result[0] : null;

  // Convert timestamp and numeric BIGINT fields from strings to numbers
  let convertedUrl = processedUrl
    ? convertTimestampsToNumbers(processedUrl, ['processed_at', 'r2_expired_at'])
    : null;
  if (convertedUrl) {
    convertedUrl = convertBigIntToNumbers(convertedUrl, ['file_size']);
  }

  // Cache result (even null to avoid repeated queries for non-existent URLs)
  setCachedProcessedUrl(urlHash, convertedUrl);

  return convertedUrl;
}

export async function insertProcessedUrl(
  urlHash,
  fileHash,
  fileType,
  fileExtension,
  fileUrl,
  processedAt,
  userId = null,
  fileSize = null
) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();

  try {
    await sql`
      INSERT INTO processed_urls (url_hash, file_hash, file_type, file_extension, file_url, processed_at, user_id, file_size)
      VALUES (${urlHash}, ${fileHash}, ${fileType}, ${fileExtension}, ${fileUrl}, ${processedAt}, ${userId}, ${fileSize})
      ON CONFLICT (url_hash) DO UPDATE SET
        file_hash = EXCLUDED.file_hash,
        file_type = EXCLUDED.file_type,
        file_extension = EXCLUDED.file_extension,
        file_url = EXCLUDED.file_url,
        processed_at = EXCLUDED.processed_at,
        user_id = EXCLUDED.user_id,
        file_size = EXCLUDED.file_size,
        r2_expired_at = NULL
    `;
    invalidateProcessedUrlCache(urlHash);
  } catch (error) {
    // Handle connection errors gracefully (e.g., when database is closed)
    if (
      error.message &&
      (error.message.includes('CONNECTION_ENDED') || error.message.includes('connection'))
    ) {
      console.error(
        `Database connection not available. Cannot insert processed URL: ${error.message}`
      );
      return; // Return gracefully instead of throwing
    }
    // Log other errors but don't throw - allows graceful degradation
    console.error(`Failed to insert/update processed URL in database: ${error.message}`);
    throw error;
  }
}

export async function getUserMedia(userId, options = {}) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();

  const { limit = null, offset = null } = options;

  let query = `SELECT file_url, file_type, file_extension, processed_at, file_size FROM processed_urls WHERE user_id = $1 AND r2_expired_at IS NULL ORDER BY processed_at DESC`;
  const params = [userId];

  if (limit !== null) {
    query += ` LIMIT $${params.length + 1}`;
    params.push(limit);
  }

  if (offset !== null) {
    query += ` OFFSET $${params.length + 1}`;
    params.push(offset);
  }

  const results = await sql.unsafe(query, params);
  // Convert timestamp and numeric BIGINT fields from strings to numbers
  let converted = convertTimestampsInArray(results, ['processed_at']);
  converted = convertBigIntInArray(converted, ['file_size']);
  return converted;
}

export async function getUserMediaCount(userId) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();

  const result =
    await sql`SELECT COUNT(*) as count FROM processed_urls WHERE user_id = ${userId} AND r2_expired_at IS NULL`;
  return parseInt(result[0]?.count || 0, 10);
}

export async function getUserR2Media(userId, options = {}) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();

  const { limit = null, offset = null, fileType = null } = options;
  const publicDomain = r2Config.publicDomain;
  const r2UrlPrefix = `https://${publicDomain}/`;

  // The newest tracking row tells when the object leaves R2 (or already left). A cache row with
  // no tracking row is a permanent upload, or one made while tracking was off.
  let query = `SELECT p.url_hash, p.file_url, p.file_type, p.file_extension, p.processed_at, p.file_size,
      t.expires_at, t.deleted_at, t.deletion_failed
    FROM processed_urls p
    LEFT JOIN LATERAL (
      SELECT expires_at, deleted_at, deletion_failed FROM temporary_uploads
      WHERE url_hash = p.url_hash ORDER BY expires_at DESC LIMIT 1
    ) t ON true
    WHERE p.user_id = $1 AND p.file_url LIKE $2 AND p.r2_expired_at IS NULL`;
  const params = [userId, `${r2UrlPrefix}%`];

  if (fileType) {
    query += ` AND p.file_type = $${params.length + 1}`;
    params.push(fileType);
  }

  query += ' ORDER BY p.processed_at DESC';

  if (limit !== null) {
    query += ` LIMIT $${params.length + 1}`;
    params.push(limit);
  }

  if (offset !== null) {
    query += ` OFFSET $${params.length + 1}`;
    params.push(offset);
  }

  const results = await sql.unsafe(query, params);
  // Convert timestamp and numeric BIGINT fields from strings to numbers
  let converted = convertTimestampsInArray(results, ['processed_at', 'expires_at', 'deleted_at']);
  converted = convertBigIntInArray(converted, ['file_size']);
  return converted;
}

export async function getUserR2MediaCount(userId, fileType = null) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();

  const publicDomain = r2Config.publicDomain;
  const r2UrlPrefix = `https://${publicDomain}/`;

  let query = `SELECT COUNT(*) as count FROM processed_urls WHERE user_id = $1 AND file_url LIKE $2 AND r2_expired_at IS NULL`;
  const params = [userId, `${r2UrlPrefix}%`];

  if (fileType) {
    query += ` AND file_type = $${params.length + 1}`;
    params.push(fileType);
  }

  const result = await sql.unsafe(query, params);
  return parseInt(result[0]?.count || 0, 10);
}

/**
 * Get per-user R2 storage stats (file count + total bytes), largest first
 * @returns {Promise<Array>} Rows of { user_id, file_count, total_size }
 */
export async function getR2UserStats() {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();

  const publicDomain = r2Config.publicDomain;
  const r2UrlPrefix = `https://${publicDomain}/`;

  const rows = await sql`
    SELECT
      p.user_id,
      COUNT(*) AS file_count,
      COALESCE(SUM(p.file_size), 0) AS total_size
    FROM processed_urls p
    WHERE p.user_id IS NOT NULL AND p.file_url LIKE ${`${r2UrlPrefix}%`} AND p.r2_expired_at IS NULL
    GROUP BY p.user_id
    ORDER BY total_size DESC
  `;

  return rows.map(row => ({
    user_id: row.user_id,
    file_count: parseInt(row.file_count, 10),
    total_size: parseInt(row.total_size, 10),
  }));
}

/**
 * Mark processed_urls rows as R2-expired once their backing R2 upload has been
 * confirmed removed. Keeps the historical row (used for request-count stats)
 * while stopping callers - the moderation "on R2" view, the download/convert/
 * optimize URL cache - from treating file_url as still resolvable.
 * @param {string[]} urlHashes - URL hashes whose R2 upload just expired
 * @returns {Promise<void>}
 */
export async function markProcessedUrlsR2Expired(urlHashes) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql || !urlHashes || urlHashes.length === 0) {
    return;
  }

  try {
    await sql`
      UPDATE processed_urls
      SET r2_expired_at = ${Date.now()}
      WHERE url_hash = ANY(${urlHashes})
    `;
    for (const urlHash of urlHashes) {
      invalidateProcessedUrlCache(urlHash);
    }
  } catch (error) {
    console.error('Failed to mark processed URLs as R2-expired:', error);
  }
}

export async function deleteProcessedUrl(urlHash) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();

  try {
    const result = await sql`DELETE FROM processed_urls WHERE url_hash = ${urlHash}`;
    return result.count > 0;
  } catch (error) {
    console.error('Failed to delete processed URL:', error);
    return false;
  }
}

export async function deleteUserR2Media(userId) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();

  try {
    const publicDomain = r2Config.publicDomain;
    const r2UrlPrefix = `https://${publicDomain}/`;
    const result = await sql`
      DELETE FROM processed_urls
      WHERE user_id = ${userId} AND file_url LIKE ${`${r2UrlPrefix}%`}
    `;
    return result.count;
  } catch (error) {
    console.error('Failed to delete user R2 media:', error);
    return 0;
  }
}
