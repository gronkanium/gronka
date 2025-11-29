import { getDb } from './connection.js';
import { ensureDbInitialized } from './init.js';
import { createLogger } from '../logger.js';

// Lazy logger creation to avoid circular dependency with database.js barrel export
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
  await ensureDbInitialized();

  const db = getDb();
  if (!db) {
    throw new Error('Database initialization failed. Cannot insert temporary upload.');
  }

  try {
    // Check if record exists (by unique constraint: url_hash, r2_key)
    const existingStmt = db.prepare(
      'SELECT * FROM temporary_uploads WHERE url_hash = ? AND r2_key = ?'
    );
    const existing = existingStmt.get(urlHash, r2Key);

    if (existing) {
      // Update existing record (reset expiration if same upload happens again)
      const updateStmt = db.prepare(
        'UPDATE temporary_uploads SET uploaded_at = ?, expires_at = ?, deleted_at = NULL, deletion_failed = 0, deletion_error = NULL WHERE url_hash = ? AND r2_key = ?'
      );
      updateStmt.run(uploadedAt, expiresAt, urlHash, r2Key);
      getLogger().debug(
        `Updated existing temporary upload record: url_hash=${urlHash.substring(0, 8)}..., r2_key=${r2Key}`
      );
      return existingStmt.get(urlHash, r2Key);
    } else {
      // Insert new record
      const insertStmt = db.prepare(
        'INSERT INTO temporary_uploads (url_hash, r2_key, uploaded_at, expires_at) VALUES (?, ?, ?, ?)'
      );
      const result = insertStmt.run(urlHash, r2Key, uploadedAt, expiresAt);
      getLogger().debug(
        `Inserted new temporary upload record: id=${result.lastInsertRowid}, url_hash=${urlHash.substring(0, 8)}..., r2_key=${r2Key}`
      );
      const selectStmt = db.prepare('SELECT * FROM temporary_uploads WHERE id = ?');
      return selectStmt.get(result.lastInsertRowid);
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
  await ensureDbInitialized();

  const db = getDb();
  if (!db) {
    getLogger().error('Database initialization failed.');
    return [];
  }

  try {
    const stmt = db.prepare(
      'SELECT * FROM temporary_uploads WHERE expires_at < ? AND deleted_at IS NULL ORDER BY expires_at ASC'
    );
    return stmt.all(now);
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
  await ensureDbInitialized();

  const db = getDb();
  if (!db) {
    getLogger().error('Database initialization failed.');
    return [];
  }

  try {
    const stmt = db.prepare('SELECT * FROM temporary_uploads WHERE r2_key = ?');
    return stmt.all(r2Key);
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
  await ensureDbInitialized();

  const db = getDb();
  if (!db) {
    getLogger().error('Database initialization failed.');
    return false;
  }

  try {
    const stmt = db.prepare(
      'UPDATE temporary_uploads SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL'
    );
    const result = stmt.run(deletedAt, id);
    return result.changes > 0;
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
  await ensureDbInitialized();

  const db = getDb();
  if (!db) {
    getLogger().error('Database initialization failed.');
    return false;
  }

  try {
    const stmt = db.prepare(
      'UPDATE temporary_uploads SET deletion_failed = ?, deletion_error = ? WHERE id = ?'
    );
    const result = stmt.run(retryCount, error, id);
    return result.changes > 0;
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
  await ensureDbInitialized();

  const db = getDb();
  if (!db) {
    getLogger().error('Database initialization failed.');
    return [];
  }

  try {
    const stmt = db.prepare(
      'SELECT * FROM temporary_uploads WHERE deletion_failed > 0 AND deleted_at IS NULL ORDER BY deletion_failed DESC, expires_at ASC'
    );
    return stmt.all();
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
  await ensureDbInitialized();

  const db = getDb();
  if (!db) {
    getLogger().error('Database initialization failed.');
    return false;
  }

  try {
    const stmt = db.prepare('DELETE FROM temporary_uploads WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
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
  await ensureDbInitialized();

  const db = getDb();
  if (!db) {
    getLogger().error('Database initialization failed.');
    return 0;
  }

  try {
    const stmt = db.prepare('DELETE FROM temporary_uploads WHERE r2_key = ?');
    const result = stmt.run(r2Key);
    return result.changes;
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
  await ensureDbInitialized();

  const db = getDb();
  if (!db) {
    getLogger().error('Database initialization failed.');
    return [];
  }

  try {
    // Get all unique R2 keys that have expired uploads
    const expiredStmt = db.prepare(
      'SELECT DISTINCT r2_key FROM temporary_uploads WHERE expires_at < ? AND deleted_at IS NULL'
    );
    const expiredKeys = expiredStmt.all(now).map(row => row.r2_key);

    // For each R2 key, check if ALL uploads are expired
    const keysToDelete = [];
    for (const r2Key of expiredKeys) {
      const allUploadsStmt = db.prepare(
        'SELECT COUNT(*) as total_count, SUM(CASE WHEN expires_at < ? AND deleted_at IS NULL THEN 1 ELSE 0 END) as expired_count FROM temporary_uploads WHERE r2_key = ?'
      );
      const result = allUploadsStmt.get(now, r2Key);

      // If all uploads for this R2 key are expired, add to deletion list
      if (result && result.total_count > 0 && result.total_count === result.expired_count) {
        keysToDelete.push(r2Key);
      }
    }

    return keysToDelete;
  } catch (error) {
    getLogger().error(`Failed to get expired R2 keys: ${error.message}`);
    return [];
  }
}
