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
 * @param {string} urlHash - BLAKE3 hash of the URL
 * @returns {Promise<Object|null>} Processed URL record or null if not found
 */
/**
 * Get multiple processed URL records by URL hashes in a single query
 * @param {string[]} urlHashes - Array of URL hashes to look up
 * @returns {Promise<Map<string, Object>>} Map of urlHash → record (missing hashes absent)
 */
export async function getProcessedUrlsBatch(urlHashes) {
  if (!urlHashes || urlHashes.length === 0) return new Map();

  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized.');
    return new Map();
  }

  // Check cache first, collect uncached hashes
  const result = new Map();
  const uncached = [];
  for (const urlHash of urlHashes) {
    const cached = getCachedProcessedUrl(urlHash);
    if (cached !== null) {
      result.set(urlHash, cached);
    } else {
      uncached.push(urlHash);
    }
  }

  if (uncached.length > 0) {
    const rows = await sql`SELECT * FROM processed_urls WHERE url_hash = ANY(${uncached})`;
    for (const row of rows) {
      let converted = convertTimestampsToNumbers(row, ['processed_at']);
      converted = convertBigIntToNumbers(converted, ['file_size']);
      setCachedProcessedUrl(row.url_hash, converted);
      result.set(row.url_hash, converted);
    }
    // Cache null for hashes that had no DB record
    for (const urlHash of uncached) {
      if (!result.has(urlHash)) {
        setCachedProcessedUrl(urlHash, null);
      }
    }
  }

  return result;
}

export async function getProcessedUrl(urlHash) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized.');
    return null;
  }

  // Check in-memory cache first
  const cached = getCachedProcessedUrl(urlHash);
  if (cached !== null) {
    return cached;
  }

  const result = await sql`SELECT * FROM processed_urls WHERE url_hash = ${urlHash}`;
  const processedUrl = result.length > 0 ? result[0] : null;

  // Convert timestamp and numeric BIGINT fields from strings to numbers
  let convertedUrl = processedUrl
    ? convertTimestampsToNumbers(processedUrl, ['processed_at'])
    : null;
  if (convertedUrl) {
    convertedUrl = convertBigIntToNumbers(convertedUrl, ['file_size']);
  }

  // Cache result (even null to avoid repeated queries for non-existent URLs)
  setCachedProcessedUrl(urlHash, convertedUrl);

  return convertedUrl;
}

/**
 * Insert or update a processed URL record
 * @param {string} urlHash - BLAKE3 hash of the URL
 * @param {string} fileHash - File content hash (BLAKE3)
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
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Cannot insert processed URL.');
    return;
  }

  try {
    // Check if record exists
    const existing = await getProcessedUrl(urlHash);
    if (existing) {
      // Update existing record (in case file URL or other info changed)
      await sql`
        UPDATE processed_urls
        SET file_hash = ${fileHash},
            file_type = ${fileType},
            file_extension = ${fileExtension},
            file_url = ${fileUrl},
            processed_at = ${processedAt},
            user_id = ${userId},
            file_size = ${fileSize}
        WHERE url_hash = ${urlHash}
      `;
      // Invalidate cache
      invalidateProcessedUrlCache(urlHash);
    } else {
      // Insert new record
      await sql`
        INSERT INTO processed_urls (url_hash, file_hash, file_type, file_extension, file_url, processed_at, user_id, file_size)
        VALUES (${urlHash}, ${fileHash}, ${fileType}, ${fileExtension}, ${fileUrl}, ${processedAt}, ${userId}, ${fileSize})
      `;
      // Invalidate cache (though entry didn't exist before, clear to be safe)
      invalidateProcessedUrlCache(urlHash);
    }
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

/**
 * Get processed URLs (media files) for a specific user
 * @param {string} userId - Discord user ID
 * @param {Object} options - Query options
 * @param {number} [options.limit] - Maximum number of results
 * @param {number} [options.offset] - Number of results to skip
 * @returns {Promise<Array>} Array of processed URL records
 */
export async function getUserMedia(userId, options = {}) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized.');
    return [];
  }

  const { limit = null, offset = null } = options;

  let query = `SELECT file_url, file_type, file_extension, processed_at, file_size FROM processed_urls WHERE user_id = $1 ORDER BY processed_at DESC`;
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

/**
 * Get total count of processed URLs (media files) for a specific user
 * @param {string} userId - Discord user ID
 * @returns {Promise<number>} Total count of media files for the user
 */
export async function getUserMediaCount(userId) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized.');
    return 0;
  }

  const result = await sql`SELECT COUNT(*) as count FROM processed_urls WHERE user_id = ${userId}`;
  return parseInt(result[0]?.count || 0, 10);
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
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized.');
    return [];
  }

  const { limit = null, offset = null, fileType = null } = options;
  const publicDomain = r2Config.publicDomain;
  const r2UrlPrefix = `https://${publicDomain}/`;

  let query = `SELECT url_hash, file_url, file_type, file_extension, processed_at, file_size FROM processed_urls WHERE user_id = $1 AND file_url LIKE $2`;
  const params = [userId, `${r2UrlPrefix}%`];

  if (fileType) {
    query += ` AND file_type = $${params.length + 1}`;
    params.push(fileType);
  }

  query += ' ORDER BY processed_at DESC';

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

/**
 * Get total count of R2 media files for a specific user
 * @param {string} userId - Discord user ID
 * @param {string} [fileType] - Filter by file type ('gif', 'video', 'image')
 * @returns {Promise<number>} Total count of R2 media files for the user
 */
export async function getUserR2MediaCount(userId, fileType = null) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized.');
    return 0;
  }

  const publicDomain = r2Config.publicDomain;
  const r2UrlPrefix = `https://${publicDomain}/`;

  let query = `SELECT COUNT(*) as count FROM processed_urls WHERE user_id = $1 AND file_url LIKE $2`;
  const params = [userId, `${r2UrlPrefix}%`];

  if (fileType) {
    query += ` AND file_type = $${params.length + 1}`;
    params.push(fileType);
  }

  const result = await sql.unsafe(query, params);
  return parseInt(result[0]?.count || 0, 10);
}

/**
 * Delete a processed URL record by url_hash
 * @param {string} urlHash - URL hash (primary key)
 * @returns {Promise<boolean>} True if record was deleted, false if not found
 */
export async function deleteProcessedUrl(urlHash) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized.');
    return false;
  }

  try {
    const result = await sql`DELETE FROM processed_urls WHERE url_hash = ${urlHash}`;
    return result.count > 0;
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
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized.');
    return 0;
  }

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

/**
 * Get moderation dashboard statistics for R2 uploads
 * @returns {Promise<Object>} Stats object with totalFiles, totalStorageBytes, activeUploaders, uploadsLast24h, uploadsByType
 */
export async function getModerationStats() {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized.');
    return {
      totalFiles: 0,
      totalStorageBytes: 0,
      activeUploaders: 0,
      uploadsLast24h: 0,
      uploadsByType: { gif: 0, video: 0, image: 0 },
    };
  }

  const publicDomain = r2Config.publicDomain;
  const r2UrlPrefix = `https://${publicDomain}/`;
  const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;

  const result = await sql`
    SELECT
      COUNT(*) as total_files,
      COALESCE(SUM(file_size), 0) as total_storage,
      COUNT(DISTINCT user_id) as active_uploaders,
      COUNT(*) FILTER (WHERE processed_at >= ${twentyFourHoursAgo}) as last_24h,
      COUNT(*) FILTER (WHERE file_type = 'gif') as gif_count,
      COUNT(*) FILTER (WHERE file_type = 'video') as video_count,
      COUNT(*) FILTER (WHERE file_type = 'image') as image_count
    FROM processed_urls
    WHERE file_url LIKE ${`${r2UrlPrefix}%`}
  `;

  const row = result[0] || {};
  return {
    totalFiles: parseInt(row.total_files || 0, 10),
    totalStorageBytes: parseInt(row.total_storage || 0, 10),
    activeUploaders: parseInt(row.active_uploaders || 0, 10),
    uploadsLast24h: parseInt(row.last_24h || 0, 10),
    uploadsByType: {
      gif: parseInt(row.gif_count || 0, 10),
      video: parseInt(row.video_count || 0, 10),
      image: parseInt(row.image_count || 0, 10),
    },
  };
}

/**
 * Get recent R2 uploads across all users
 * @param {Object} options - Query options
 * @param {number} [options.limit=25] - Maximum number of results
 * @param {number} [options.offset=0] - Number of results to skip
 * @param {string} [options.fileType] - Filter by file type ('gif', 'video', 'image')
 * @returns {Promise<Array>} Array of upload records with username
 */
export async function getRecentR2Uploads(options = {}) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized.');
    return [];
  }

  const { limit = 25, offset = 0, fileType = null } = options;
  const publicDomain = r2Config.publicDomain;
  const r2UrlPrefix = `https://${publicDomain}/`;

  let query = `
    SELECT p.url_hash, p.file_url, p.file_type, p.file_extension, p.processed_at, p.file_size, p.user_id,
           COALESCE(u.username, um.username, 'Unknown') as username
    FROM processed_urls p
    LEFT JOIN users u ON p.user_id = u.user_id
    LEFT JOIN user_metrics um ON p.user_id = um.user_id
    WHERE p.file_url LIKE $1
  `;
  const params = [`${r2UrlPrefix}%`];

  if (fileType) {
    query += ` AND p.file_type = $${params.length + 1}`;
    params.push(fileType);
  }

  query += ` ORDER BY p.processed_at DESC`;

  if (limit !== null) {
    query += ` LIMIT $${params.length + 1}`;
    params.push(limit);
  }

  if (offset !== null && offset > 0) {
    query += ` OFFSET $${params.length + 1}`;
    params.push(offset);
  }

  const results = await sql.unsafe(query, params);
  let converted = convertTimestampsInArray(results, ['processed_at']);
  converted = convertBigIntInArray(converted, ['file_size']);
  return converted;
}

/**
 * Get total count of R2 uploads
 * @param {string} [fileType] - Filter by file type ('gif', 'video', 'image')
 * @returns {Promise<number>} Total count of R2 uploads
 */
export async function getR2UploadsCount(fileType = null) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized.');
    return 0;
  }

  const publicDomain = r2Config.publicDomain;
  const r2UrlPrefix = `https://${publicDomain}/`;

  let query = `SELECT COUNT(*) as count FROM processed_urls WHERE file_url LIKE $1`;
  const params = [`${r2UrlPrefix}%`];

  if (fileType) {
    query += ` AND file_type = $${params.length + 1}`;
    params.push(fileType);
  }

  const result = await sql.unsafe(query, params);
  return parseInt(result[0]?.count || 0, 10);
}

/**
 * Get users who have R2 uploads (excludes zero-upload users)
 * @param {Object} options - Query options
 * @param {string} [options.search] - Search by username
 * @param {string} [options.sortBy='upload_count'] - Sort field (upload_count, storage_used, last_upload)
 * @param {boolean} [options.sortDesc=true] - Sort descending
 * @param {number} [options.limit=50] - Maximum number of results
 * @param {number} [options.offset=0] - Number of results to skip
 * @returns {Promise<Array>} Array of user objects with upload stats
 */
export async function getUsersWithR2Uploads(options = {}) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized.');
    return [];
  }

  const {
    search = null,
    sortBy = 'upload_count',
    sortDesc = true,
    limit = 50,
    offset = 0,
  } = options;
  const publicDomain = r2Config.publicDomain;
  const r2UrlPrefix = `https://${publicDomain}/`;

  // Validate sortBy to prevent SQL injection
  const validSortFields = ['upload_count', 'storage_used', 'last_upload'];
  const safeSortBy = validSortFields.includes(sortBy) ? sortBy : 'upload_count';
  const sortOrder = sortDesc ? 'DESC' : 'ASC';

  let query = `
    SELECT
      p.user_id,
      COALESCE(u.username, um.username, 'Unknown') as username,
      COUNT(*) as upload_count,
      COALESCE(SUM(p.file_size), 0) as storage_used,
      MAX(p.processed_at) as last_upload
    FROM processed_urls p
    LEFT JOIN users u ON p.user_id = u.user_id
    LEFT JOIN user_metrics um ON p.user_id = um.user_id
    WHERE p.file_url LIKE $1 AND p.user_id IS NOT NULL
  `;
  const params = [`${r2UrlPrefix}%`];

  if (search) {
    query += ` AND (u.username ILIKE $${params.length + 1} OR um.username ILIKE $${params.length + 1})`;
    params.push(`%${search}%`);
  }

  query += ` GROUP BY p.user_id, u.username, um.username`;
  query += ` ORDER BY ${safeSortBy} ${sortOrder}`;

  if (limit !== null) {
    query += ` LIMIT $${params.length + 1}`;
    params.push(limit);
  }

  if (offset !== null && offset > 0) {
    query += ` OFFSET $${params.length + 1}`;
    params.push(offset);
  }

  const results = await sql.unsafe(query, params);
  let converted = convertTimestampsInArray(results, ['last_upload']);
  converted = convertBigIntInArray(converted, ['storage_used', 'upload_count']);
  return converted;
}

/**
 * Get count of users who have R2 uploads
 * @param {string} [search] - Search by username
 * @returns {Promise<number>} Count of users with uploads
 */
export async function getUsersWithR2UploadsCount(search = null) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized.');
    return 0;
  }

  const publicDomain = r2Config.publicDomain;
  const r2UrlPrefix = `https://${publicDomain}/`;

  let query = `
    SELECT COUNT(DISTINCT p.user_id) as count
    FROM processed_urls p
    LEFT JOIN users u ON p.user_id = u.user_id
    LEFT JOIN user_metrics um ON p.user_id = um.user_id
    WHERE p.file_url LIKE $1 AND p.user_id IS NOT NULL
  `;
  const params = [`${r2UrlPrefix}%`];

  if (search) {
    query += ` AND (u.username ILIKE $${params.length + 1} OR um.username ILIKE $${params.length + 1})`;
    params.push(`%${search}%`);
  }

  const result = await sql.unsafe(query, params);
  return parseInt(result[0]?.count || 0, 10);
}
