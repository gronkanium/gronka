import { getDb, getR2PublicDomain, getCachedStatement } from './connection.js';
import { ensureDbInitialized } from './init.js';

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

/**
 * Invalidate processed URL cache
 * @param {string} urlHash - URL hash to invalidate (or null to clear all)
 */
export function invalidateProcessedUrlCache(urlHash = null) {
  if (urlHash) {
    processedUrlCache.delete(urlHash);
  } else {
    processedUrlCache.clear();
  }
}

/**
 * Get processed URL record by URL hash
 * @param {string} urlHash - SHA-256 hash of the URL
 * @returns {Promise<Object|null>} Processed URL record or null if not found
 */
export async function getProcessedUrl(urlHash) {
  await ensureDbInitialized();

  const db = getDb();
  if (!db) {
    console.error('Database initialization failed.');
    return null;
  }

  // Check in-memory cache first
  const cached = getCachedProcessedUrl(urlHash);
  if (cached !== null) {
    return cached;
  }

  const stmt = getCachedStatement('SELECT * FROM processed_urls WHERE url_hash = ?');
  const processedUrl = stmt.get(urlHash) || null;

  // Cache result (even null to avoid repeated queries for non-existent URLs)
  setCachedProcessedUrl(urlHash, processedUrl);

  return processedUrl;
}

/**
 * Insert or update a processed URL record
 * @param {string} urlHash - SHA-256 hash of the URL
 * @param {string} fileHash - File content hash (MD5 or SHA-256)
 * @param {string} fileType - File type ('gif', 'video', or 'image')
 * @param {string} fileExtension - File extension (e.g., '.mp4', '.gif')
 * @param {string} fileUrl - Final CDN URL or path
 * @param {number} processedAt - Unix timestamp in milliseconds
 * @param {string} [userId] - Discord user ID who requested it
 * @param {number} [fileSize] - File size in bytes
 * @returns {Promise<void>}
 */
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
  await ensureDbInitialized();

  const db = getDb();
  if (!db) {
    console.error('Database initialization failed. Cannot insert processed URL.');
    return;
  }

  try {
    // Check if record exists
    const existing = await getProcessedUrl(urlHash);
    if (existing) {
      // Update existing record (in case file URL or other info changed)
      const updateStmt = getCachedStatement(
        'UPDATE processed_urls SET file_hash = ?, file_type = ?, file_extension = ?, file_url = ?, processed_at = ?, user_id = ?, file_size = ? WHERE url_hash = ?'
      );
      updateStmt.run(
        fileHash,
        fileType,
        fileExtension,
        fileUrl,
        processedAt,
        userId,
        fileSize,
        urlHash
      );
      // Invalidate cache
      invalidateProcessedUrlCache(urlHash);
    } else {
      // Insert new record
      const insertStmt = getCachedStatement(
        'INSERT INTO processed_urls (url_hash, file_hash, file_type, file_extension, file_url, processed_at, user_id, file_size) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      insertStmt.run(
        urlHash,
        fileHash,
        fileType,
        fileExtension,
        fileUrl,
        processedAt,
        userId,
        fileSize
      );
      // Invalidate cache (though entry didn't exist before, clear to be safe)
      invalidateProcessedUrlCache(urlHash);
    }
  } catch (error) {
    // Log error but don't throw - allows graceful degradation if database is read-only
    console.error(`Failed to insert/update processed URL in database: ${error.message}`);
    // Re-throw if it's not a read-only error, as that indicates a real problem
    if (error.code !== 'SQLITE_READONLY') {
      throw error;
    }
  }
}

/**
 * Get processed URLs (media files) for a specific user
 * @param {string} userId - Discord user ID
 * @param {Object} options - Query options
 * @param {number} [options.limit] - Maximum number of results
 * @param {number} [options.offset] - Number of results to skip
 * @returns {Promise<Array>} Array of processed URL records
 */
export async function getUserMedia(userId, options = {}) {
  await ensureDbInitialized();

  const db = getDb();
  if (!db) {
    console.error('Database initialization failed.');
    return [];
  }

  const { limit = null, offset = null } = options;

  let query =
    'SELECT file_url, file_type, file_extension, processed_at, file_size FROM processed_urls WHERE user_id = ? ORDER BY processed_at DESC';
  const params = [userId];

  if (limit !== null) {
    query += ' LIMIT ?';
    params.push(limit);
  }

  if (offset !== null) {
    query += ' OFFSET ?';
    params.push(offset);
  }

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

/**
 * Get total count of processed URLs (media files) for a specific user
 * @param {string} userId - Discord user ID
 * @returns {Promise<number>} Total count of media files for the user
 */
export async function getUserMediaCount(userId) {
  await ensureDbInitialized();

  const db = getDb();
  if (!db) {
    console.error('Database initialization failed.');
    return 0;
  }

  const stmt = getCachedStatement('SELECT COUNT(*) as count FROM processed_urls WHERE user_id = ?');
  const result = stmt.get(userId);
  return result ? result.count : 0;
}

/**
 * Get R2 media files for a specific user
 * @param {string} userId - Discord user ID
 * @param {Object} options - Query options
 * @param {number} [options.limit] - Maximum number of results
 * @param {number} [options.offset] - Number of results to skip
 * @param {string} [options.fileType] - Filter by file type ('gif', 'video', 'image')
 * @returns {Promise<Array>} Array of R2 media file records
 */
export async function getUserR2Media(userId, options = {}) {
  await ensureDbInitialized();

  const db = getDb();
  if (!db) {
    console.error('Database initialization failed.');
    return [];
  }

  const { limit = null, offset = null, fileType = null } = options;
  const publicDomain = getR2PublicDomain();
  const r2UrlPrefix = `https://${publicDomain}/`;

  let query =
    'SELECT url_hash, file_url, file_type, file_extension, processed_at, file_size FROM processed_urls WHERE user_id = ? AND file_url LIKE ?';
  const params = [userId, `${r2UrlPrefix}%`];

  if (fileType) {
    query += ' AND file_type = ?';
    params.push(fileType);
  }

  query += ' ORDER BY processed_at DESC';

  if (limit !== null) {
    query += ' LIMIT ?';
    params.push(limit);
  }

  if (offset !== null) {
    query += ' OFFSET ?';
    params.push(offset);
  }

  const stmt = db.prepare(query);
  return stmt.all(...params);
}

/**
 * Get total count of R2 media files for a specific user
 * @param {string} userId - Discord user ID
 * @param {string} [fileType] - Filter by file type ('gif', 'video', 'image')
 * @returns {Promise<number>} Total count of R2 media files for the user
 */
export async function getUserR2MediaCount(userId, fileType = null) {
  await ensureDbInitialized();

  const db = getDb();
  if (!db) {
    console.error('Database initialization failed.');
    return 0;
  }

  const publicDomain = getR2PublicDomain();
  const r2UrlPrefix = `https://${publicDomain}/`;

  let query = 'SELECT COUNT(*) as count FROM processed_urls WHERE user_id = ? AND file_url LIKE ?';
  const params = [userId, `${r2UrlPrefix}%`];

  if (fileType) {
    query += ' AND file_type = ?';
    params.push(fileType);
  }

  const stmt = db.prepare(query);
  const result = stmt.get(...params);
  return result ? result.count : 0;
}

/**
 * Delete a processed URL record by url_hash
 * @param {string} urlHash - URL hash (primary key)
 * @returns {Promise<boolean>} True if record was deleted, false if not found
 */
export async function deleteProcessedUrl(urlHash) {
  await ensureDbInitialized();

  const db = getDb();
  if (!db) {
    console.error('Database initialization failed.');
    return false;
  }

  try {
    const stmt = getCachedStatement('DELETE FROM processed_urls WHERE url_hash = ?');
    const result = stmt.run(urlHash);
    return result.changes > 0;
  } catch (error) {
    console.error('Failed to delete processed URL:', error);
    return false;
  }
}

/**
 * Delete all R2 media records for a user from database
 * @param {string} userId - Discord user ID
 * @returns {Promise<number>} Number of records deleted
 */
export async function deleteUserR2Media(userId) {
  await ensureDbInitialized();

  const db = getDb();
  if (!db) {
    console.error('Database initialization failed.');
    return 0;
  }

  try {
    const publicDomain = getR2PublicDomain();
    const r2UrlPrefix = `https://${publicDomain}/`;
    const stmt = getCachedStatement(
      'DELETE FROM processed_urls WHERE user_id = ? AND file_url LIKE ?'
    );
    const result = stmt.run(userId, `${r2UrlPrefix}%`);
    return result.changes;
  } catch (error) {
    console.error('Failed to delete user R2 media:', error);
    return 0;
  }
}
