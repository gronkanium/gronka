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

/**
 * Insert or update a temporary upload record
 * @param {string} urlHash - Foreign key to processed_urls.url_hash
 * @param {string} r2Key - R2 object key (e.g., gifs/abc123.gif)
 * @param {number} uploadedAt - Unix timestamp in milliseconds when file was uploaded
 * @param {number} expiresAt - Unix timestamp in milliseconds when file expires
 * @returns {Promise<Object>} The inserted/updated record
 */
export async function insertTemporaryUpload(urlHash, r2Key, uploadedAt, expiresAt) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    throw new Error('PostgreSQL not initialized. Cannot insert temporary upload.');
  }

  try {
    // Check if record exists
    const existing = await sql`
      SELECT * FROM temporary_uploads
      WHERE url_hash = ${urlHash} AND r2_key = ${r2Key}
    `;

    if (existing.length > 0) {
      // Update existing record
      await sql`
        UPDATE temporary_uploads
        SET uploaded_at = ${uploadedAt},
            expires_at = ${expiresAt},
            deleted_at = NULL,
            deletion_failed = 0,
            deletion_error = NULL
        WHERE url_hash = ${urlHash} AND r2_key = ${r2Key}
      `;
      getLogger().debug(
        `Updated existing temporary upload record: url_hash=${urlHash.substring(0, 8)}..., r2_key=${r2Key}`
      );
      const updated = await sql`
        SELECT * FROM temporary_uploads
        WHERE url_hash = ${urlHash} AND r2_key = ${r2Key}
      `;
      // Convert timestamp BIGINT fields from strings to numbers
      return convertTimestampsToNumbers(updated[0], TEMPORARY_UPLOADS_TIMESTAMP_FIELDS);
    } else {
      // Insert new record
      const result = await sql`
        INSERT INTO temporary_uploads (url_hash, r2_key, uploaded_at, expires_at)
        VALUES (${urlHash}, ${r2Key}, ${uploadedAt}, ${expiresAt})
        RETURNING *
      `;
      getLogger().debug(
        `Inserted new temporary upload record: id=${result[0].id}, url_hash=${urlHash.substring(0, 8)}..., r2_key=${r2Key}`
      );
      // Convert timestamp BIGINT fields from strings to numbers
      return convertTimestampsToNumbers(result[0], TEMPORARY_UPLOADS_TIMESTAMP_FIELDS);
    }
  } catch (error) {
    getLogger().error(`Failed to insert/update temporary upload: ${error.message}`);
    throw error;
  }
}

/**
 * Get all expired temporary uploads that haven't been deleted
 * @param {number} now - Current Unix timestamp in milliseconds
 * @returns {Promise<Array>} Array of expired temporary upload records
 */
export async function getExpiredTemporaryUploads(now) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    getLogger().error('PostgreSQL not initialized.');
    return [];
  }

  try {
    const results = await sql`
      SELECT * FROM temporary_uploads
      WHERE expires_at < ${now} AND deleted_at IS NULL
      ORDER BY expires_at ASC
    `;
    // Convert timestamp BIGINT fields from strings to numbers
    return convertTimestampsInArray(results, TEMPORARY_UPLOADS_TIMESTAMP_FIELDS);
  } catch (error) {
    getLogger().error(`Failed to get expired temporary uploads: ${error.message}`);
    return [];
  }
}

/**
 * Get all temporary upload records for a given R2 key
 * @param {string} r2Key - R2 object key
 * @returns {Promise<Array>} Array of temporary upload records for the R2 key
 */
export async function getTemporaryUploadsByR2Key(r2Key) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    getLogger().error('PostgreSQL not initialized.');
    return [];
  }

  try {
    const results = await sql`SELECT * FROM temporary_uploads WHERE r2_key = ${r2Key}`;
    // Convert timestamp BIGINT fields from strings to numbers
    return convertTimestampsInArray(results, TEMPORARY_UPLOADS_TIMESTAMP_FIELDS);
  } catch (error) {
    getLogger().error(`Failed to get temporary uploads by R2 key: ${error.message}`);
    return [];
  }
}

/**
 * Mark a temporary upload as deleted
 * @param {number} id - Temporary upload record ID
 * @param {number} deletedAt - Unix timestamp in milliseconds when deleted
 * @returns {Promise<boolean>} True if record was updated
 */
export async function markTemporaryUploadDeleted(id, deletedAt) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    getLogger().error('PostgreSQL not initialized.');
    return false;
  }

  try {
    const result = await sql`
      UPDATE temporary_uploads
      SET deleted_at = ${deletedAt}
      WHERE id = ${id} AND deleted_at IS NULL
    `;
    return result.count > 0;
  } catch (error) {
    getLogger().error(`Failed to mark temporary upload as deleted: ${error.message}`);
    return false;
  }
}

/**
 * Mark a deletion attempt as failed
 * @param {number} id - Temporary upload record ID
 * @param {string} error - Error message from deletion attempt
 * @param {number} retryCount - Current retry count (deletion_failed)
 * @returns {Promise<boolean>} True if record was updated
 */
export async function markTemporaryUploadDeletionFailed(id, error, retryCount) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    getLogger().error('PostgreSQL not initialized.');
    return false;
  }

  try {
    const result = await sql`
      UPDATE temporary_uploads
      SET deletion_failed = ${retryCount}, deletion_error = ${error}
      WHERE id = ${id}
    `;
    return result.count > 0;
  } catch (error) {
    getLogger().error(`Failed to mark temporary upload deletion as failed: ${error.message}`);
    return false;
  }
}

/**
 * Get all records with failed deletions for manual review
 * @returns {Promise<Array>} Array of temporary upload records with failed deletions
 */
export async function getFailedDeletions() {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    getLogger().error('PostgreSQL not initialized.');
    return [];
  }

  try {
    const results = await sql`
      SELECT * FROM temporary_uploads
      WHERE deletion_failed > 0 AND deleted_at IS NULL
      ORDER BY deletion_failed DESC, expires_at ASC
    `;
    // Convert timestamp BIGINT fields from strings to numbers
    return convertTimestampsInArray(results, TEMPORARY_UPLOADS_TIMESTAMP_FIELDS);
  } catch (error) {
    getLogger().error(`Failed to get failed deletions: ${error.message}`);
    return [];
  }
}

/**
 * Hard delete a temporary upload record (after R2 deletion confirmed)
 * @param {number} id - Temporary upload record ID
 * @returns {Promise<boolean>} True if record was deleted
 */
export async function deleteTemporaryUpload(id) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    getLogger().error('PostgreSQL not initialized.');
    return false;
  }

  try {
    const result = await sql`DELETE FROM temporary_uploads WHERE id = ${id}`;
    return result.count > 0;
  } catch (error) {
    getLogger().error(`Failed to delete temporary upload record: ${error.message}`);
    return false;
  }
}

/**
 * Delete all temporary upload records for an R2 key
 * @param {string} r2Key - R2 object key
 * @returns {Promise<number>} Number of records deleted
 */
export async function deleteTemporaryUploadsByR2Key(r2Key) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    getLogger().error('PostgreSQL not initialized.');
    return 0;
  }

  try {
    const result = await sql`DELETE FROM temporary_uploads WHERE r2_key = ${r2Key}`;
    return result.count;
  } catch (error) {
    getLogger().error(`Failed to delete temporary uploads by R2 key: ${error.message}`);
    return 0;
  }
}

/**
 * Get R2 keys that have all uploads expired and ready for deletion
 * @param {number} now - Current Unix timestamp in milliseconds
 * @returns {Promise<Array<string>>} Array of R2 keys where all uploads are expired
 */
export async function getExpiredR2Keys(now) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    getLogger().error('PostgreSQL not initialized.');
    return [];
  }

  try {
    // Get all unique R2 keys that have expired uploads
    const expiredKeysResult = await sql`
      SELECT DISTINCT r2_key
      FROM temporary_uploads
      WHERE expires_at < ${now} AND deleted_at IS NULL
    `;
    const expiredKeys = expiredKeysResult.map(row => row.r2_key);

    // For each R2 key, check if ALL uploads are expired
    const keysToDelete = [];
    for (const r2Key of expiredKeys) {
      const result = await sql`
        SELECT
          COUNT(*) as total_count,
          SUM(CASE WHEN expires_at < ${now} AND deleted_at IS NULL THEN 1 ELSE 0 END) as expired_count
        FROM temporary_uploads
        WHERE r2_key = ${r2Key}
      `;

      const row = result[0];
      if (
        row &&
        parseInt(row.total_count, 10) > 0 &&
        parseInt(row.total_count, 10) === parseInt(row.expired_count, 10)
      ) {
        keysToDelete.push(r2Key);
      }
    }

    return keysToDelete;
  } catch (error) {
    getLogger().error(`Failed to get expired R2 keys: ${error.message}`);
    return [];
  }
}
