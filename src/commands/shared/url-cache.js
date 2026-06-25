import { createLogger } from '../../utils/logger.js';
import { insertProcessedUrl } from '../../utils/database.js';
import { extractR2KeyFromUrl } from '../../utils/r2-storage.js';
import { trackTemporaryUpload } from '../../utils/storage.js';
import { r2Config } from '../../utils/config.js';

const logger = createLogger('url-cache');

// Shared cache-write helpers for the download / convert / optimize commands. Previously the
// insertProcessedUrl(...) call and the "extract R2 key -> trackTemporaryUpload" pattern were
// duplicated ~10 times across the three command files.

/**
 * Record a processed result in the URL cache so identical future requests can be served from cache.
 * @param {object} params
 * @param {string} params.urlHash - Cache key (hash of the original URL, possibly with params)
 * @param {string} params.contentHash - Content hash of the produced file
 * @param {'gif'|'video'|'image'} params.fileType
 * @param {string} params.fileExtension - e.g. '.gif', '.mp4'
 * @param {string} params.fileUrl - The R2 URL or Discord attachment URL to cache
 * @param {string} params.userId
 * @param {number} params.fileSize - Size in bytes
 * @returns {Promise<void>}
 */
export async function recordProcessedUrl({
  urlHash,
  contentHash,
  fileType,
  fileExtension,
  fileUrl,
  userId,
  fileSize,
}) {
  await insertProcessedUrl(
    urlHash,
    contentHash,
    fileType,
    fileExtension,
    fileUrl,
    Date.now(),
    userId,
    fileSize
  );
  logger.debug(`Recorded processed URL in database (urlHash: ${urlHash.substring(0, 8)}...)`);
}

/**
 * If the given URL is an R2 upload, record it as a temporary upload so the cleanup job can expire it.
 * No-op for non-R2 (e.g. Discord attachment) URLs.
 * @param {string} urlHash - Cache key the upload is associated with
 * @param {string} fileUrl - The uploaded file URL
 * @param {boolean} adminUser - Whether the uploader is an admin (affects retention)
 * @returns {Promise<void>}
 */
export async function trackR2UploadIfApplicable(urlHash, fileUrl, adminUser) {
  if (!fileUrl || !fileUrl.startsWith('https://')) {
    return;
  }
  const r2Key = extractR2KeyFromUrl(fileUrl, r2Config);
  if (r2Key) {
    await trackTemporaryUpload(urlHash, r2Key, null, adminUser);
  }
}
