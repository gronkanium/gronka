import fs from 'fs/promises';
import path from 'path';
import { createLogger } from './logger.js';
import { r2Config, botConfig } from './config.js';
import {
  uploadGifToR2,
  uploadVideoToR2,
  uploadImageToR2,
  gifExistsInR2,
  videoExistsInR2,
  imageExistsInR2,
  getR2PublicUrl,
  listObjectsInR2,
} from './r2-storage.js';
import {
  insertTemporaryUpload,
  getBooleanSetting,
  getProcessedUrl,
  getSetting,
} from './database.js';
import { ttlHoursForSize, DEFAULT_TTL_TIERS } from './upload-tiers.js';

const logger = createLogger('storage');

// Discord upload threshold: files smaller than this will be sent as Discord attachments
const DISCORD_UPLOAD_THRESHOLD = 8 * 1024 * 1024; // 8MB in bytes

export function shouldUploadToDiscord(buffer) {
  return buffer.length < DISCORD_UPLOAD_THRESHOLD;
}

// Stats cache: Map<storagePath, {stats, timestamp}>
// Caches storage statistics to avoid expensive recalculations (filesystem scans or R2 LIST operations)
// TTL is configurable via STATS_CACHE_TTL env var (default 5 minutes, 0 to disable)
const statsCache = new Map();

// Mutex to prevent concurrent stats calculations for the same storage path
// Map<storagePath, Promise<stats>>
const statsCalculationPromises = new Map();

// R2 usage cache: {usageBytes, timestamp} - single value, not per-path
// 24 hour TTL (86400000 ms)
const R2_CACHE_TTL = 24 * 60 * 60 * 1000;
let r2UsageCache = null;

/**
 * Get cached stats if available and not expired
 * @param {string} storagePath - Storage path used as cache key
 * @returns {Object|null} Cached stats or null if not available/expired
 */
function getCachedStats(storagePath) {
  const cacheEntry = statsCache.get(storagePath);
  if (!cacheEntry) {
    return null;
  }

  const ttl = botConfig.statsCacheTtl;
  if (ttl === 0) {
    return null;
  }

  const age = Date.now() - cacheEntry.timestamp;
  if (age >= ttl) {
    statsCache.delete(storagePath);
    return null;
  }

  logger.debug(`Using cached stats for ${storagePath} (age: ${Math.round(age / 1000)}s)`);
  return cacheEntry.stats;
}

function setCachedStats(storagePath, stats) {
  const ttl = botConfig.statsCacheTtl;
  if (ttl === 0) {
    return;
  }

  statsCache.set(storagePath, {
    stats,
    timestamp: Date.now(),
  });
  logger.debug(`Cached stats for ${storagePath}`);
}

export function invalidateStatsCache(storagePath) {
  if (statsCache.delete(storagePath)) {
    logger.debug(`Invalidated stats cache for ${storagePath}`);
  }
}

/**
 * Get cached R2 usage if available and not expired
 * @returns {number|null} Cached usage in bytes or null if not available/expired
 */
function getR2UsageCache() {
  if (!r2UsageCache) {
    return null;
  }

  const age = Date.now() - r2UsageCache.timestamp;
  if (age >= R2_CACHE_TTL) {
    r2UsageCache = null;
    return null;
  }

  logger.debug(`Using cached R2 usage (age: ${Math.round(age / 1000)}s)`);
  return r2UsageCache.usageBytes;
}

function setR2UsageCache(usageBytes) {
  r2UsageCache = {
    usageBytes,
    timestamp: Date.now(),
  };
  logger.debug(`Cached R2 usage: ${formatFileSize(usageBytes)}`);
}

function incrementR2UsageCache(fileSizeBytes) {
  if (!r2UsageCache) {
    logger.debug('R2 usage cache not initialized, skipping increment');
    return;
  }

  const age = Date.now() - r2UsageCache.timestamp;
  if (age >= R2_CACHE_TTL) {
    logger.debug('R2 usage cache expired, skipping increment');
    r2UsageCache = null;
    return;
  }

  r2UsageCache.usageBytes += fileSizeBytes;
  logger.debug(
    `Incremented R2 usage cache: ${formatFileSize(r2UsageCache.usageBytes)} (+${formatFileSize(fileSizeBytes)})`
  );
}

/**
 * Initialize R2 usage cache by fetching from R2 if needed
 * This caches R2 stats on startup to limit class A operations (LIST requests) for the /stats Discord command
 * @returns {Promise<void>}
 */
export async function initializeR2UsageCache() {
  if (
    !r2Config.accountId ||
    !r2Config.accessKeyId ||
    !r2Config.secretAccessKey ||
    !r2Config.bucketName
  ) {
    logger.debug('R2 not configured, skipping R2 usage cache initialization');
    return;
  }

  const cachedUsage = getR2UsageCache();
  if (cachedUsage !== null) {
    logger.info(`R2 usage cache already initialized: ${formatFileSize(cachedUsage)}`);
    return;
  }

  logger.info('Initializing R2 usage cache (this may take a moment)...');
  try {
    const allObjects = await listObjectsInR2('', r2Config);
    logger.debug(`Listed ${allObjects.length} total objects from R2`);

    let totalUsage = 0;
    for (const obj of allObjects) {
      totalUsage += obj.size || 0;
    }

    setR2UsageCache(totalUsage);
    logger.info(`R2 usage cache initialized: ${formatFileSize(totalUsage)}`);
  } catch (error) {
    logger.error(`Failed to initialize R2 usage cache:`, error.message);
    setR2UsageCache(0);
  }
}

function getStoragePath(storagePath) {
  if (!storagePath || typeof storagePath !== 'string') {
    logger.error('Invalid storagePath provided to getStoragePath:', {
      storagePath,
      type: typeof storagePath,
    });
    throw new Error('Storage path must be a non-empty string');
  }

  const trimmedPath = storagePath.trim();
  if (trimmedPath === '') {
    logger.error('Empty storagePath provided to getStoragePath');
    throw new Error('Storage path cannot be empty');
  }

  try {
    if (path.isAbsolute(trimmedPath)) {
      return trimmedPath;
    }
    // Relative path - resolve from project root
    return path.resolve(process.cwd(), trimmedPath);
  } catch (error) {
    logger.error('Failed to resolve storage path:', {
      error: error.message,
      storagePath: trimmedPath,
      cwd: process.cwd(),
    });
    throw new Error(`Failed to resolve storage path: ${error.message}`, { cause: error });
  }
}

/**
 * Detect file type from extension and content type
 * @param {string} extension - File extension (e.g., '.mp4', '.png', '.gif')
 * @param {string} [contentType] - Optional content type (e.g., 'video/mp4', 'image/png')
 * @param {Buffer} [buffer] - File contents; when passed, its magic bytes override both signals
 * @returns {'gif'|'video'|'image'} File type
 */
export function detectFileType(extension, contentType = '', buffer = null) {
  const ext = extension.toLowerCase();

  // Magic bytes beat both other signals: they describe the file we actually have, whereas the
  // extension and the content-type are both claims by the source. Some sources serve real GIFs
  // under a video/* content-type, and trusting that put genuine gifs behind the videos/ prefix.
  if (buffer && buffer.length >= 6) {
    const magic = buffer.subarray(0, 6).toString('latin1');
    if (magic === 'GIF87a' || magic === 'GIF89a') {
      return 'gif';
    }
    // ISO-BMFF ('ftyp' at offset 4) covers mp4/mov/m4v — an mp4 named .gif lands here.
    if (buffer.length >= 12 && buffer.subarray(4, 8).toString('latin1') === 'ftyp') {
      return 'video';
    }
  }

  // Check content-type first if provided (more reliable than extension)
  // This handles cases where files have incorrect extensions (e.g., .gif filename but video/mp4 content-type)
  if (contentType) {
    const contentTypeLower = contentType.toLowerCase();
    if (contentTypeLower.startsWith('video/')) {
      return 'video';
    }
    // Only return 'gif' or 'image' if content-type matches
    // This prevents misidentifying videos with .gif extensions
    if (contentTypeLower.startsWith('image/gif')) {
      return 'gif';
    }
    if (contentTypeLower.startsWith('image/')) {
      return 'image';
    }
  }

  // Fall back to extension if content-type is not available or doesn't match known types
  if (ext === '.gif') {
    return 'gif';
  }

  const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];
  if (videoExtensions.includes(ext)) {
    return 'video';
  }

  const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp'];
  if (imageExtensions.includes(ext)) {
    return 'image';
  }

  // Default to video if unknown (for backward compatibility)
  return 'video';
}

export async function gifExists(hash, storagePath) {
  if (
    r2Config.accountId &&
    r2Config.accessKeyId &&
    r2Config.secretAccessKey &&
    r2Config.bucketName
  ) {
    return await gifExistsInR2(hash, r2Config);
  }
  try {
    const gifPath = getGifPath(hash, storagePath);
    await fs.access(gifPath);
    return true;
  } catch {
    return false;
  }
}

export function getGifPath(hash, storagePath) {
  const basePath = getStoragePath(storagePath);
  // Ensure hash is safe (alphanumeric only)
  const safeHash = hash.replace(/[^a-f0-9]/gi, '');
  // Check if basePath already ends with 'gifs' to avoid double gifs/gifs
  const normalizedBasePath = basePath.replace(/\\/g, '/');
  if (normalizedBasePath.endsWith('/gifs') || normalizedBasePath.endsWith('\\gifs')) {
    return path.join(basePath, `${safeHash}.gif`);
  }
  return path.join(basePath, 'gifs', `${safeHash}.gif`);
}

/**
 * Save a GIF buffer to R2 or disk
 * @param {Buffer} buffer - GIF file buffer
 * @param {string} hash - BLAKE3 hash of the video
 * @param {string} storagePath - Base storage path (for local fallback)
 * @param {Object} [metadata={}] - Optional metadata to attach to the object
 * @returns {Promise<{url: string, method: string, buffer: Buffer}>} Object with URL, upload method, and buffer
 */
export async function saveGif(buffer, hash, storagePath, metadata = {}) {
  const method = shouldUploadToDiscord(buffer) ? 'discord' : 'r2';

  // Only upload to R2 if file is >= 8MB (Discord limit)
  if (
    method === 'r2' &&
    r2Config.accountId &&
    r2Config.accessKeyId &&
    r2Config.secretAccessKey &&
    r2Config.bucketName
  ) {
    try {
      // Check if file already exists in R2 specifically (not local disk)
      const existsInR2 = await gifExistsInR2(hash, r2Config);
      if (existsInR2) {
        const safeHash = hash.replace(/[^a-f0-9]/gi, '');
        const key = `gifs/${safeHash}.gif`;
        const publicUrl = getR2PublicUrl(key, r2Config);
        logger.info(`GIF already exists in R2: ${publicUrl}`);
        return { url: publicUrl, method, buffer };
      }

      logger.info(
        `Uploading GIF to R2 (hash: ${hash.substring(0, 8)}..., size: ${(buffer.length / (1024 * 1024)).toFixed(2)}MB)`
      );
      const publicUrl = await uploadGifToR2(buffer, hash, r2Config, metadata);
      logger.info(
        `Saved GIF to R2: ${publicUrl} (size: ${(buffer.length / (1024 * 1024)).toFixed(2)}MB)`
      );
      incrementR2UsageCache(buffer.length);
      // Invalidate stats cache since we added a new file
      invalidateStatsCache(storagePath);
      return { url: publicUrl, method, buffer };
    } catch (error) {
      logger.error(`Failed to upload GIF to R2, falling back to local storage:`, error.message);
      logger.error(`R2 upload error details:`, error);
      // Fall through to local storage
    }
  }

  // Save to local disk (for Discord uploads < 8MB, or as fallback)
  const _basePath = getStoragePath(storagePath);
  const gifPath = getGifPath(hash, storagePath);

  await fs.mkdir(path.dirname(gifPath), { recursive: true });

  // Write file (fs.writeFile overwrites if file exists, so no TOCTOU issue)
  await fs.writeFile(gifPath, buffer);
  logger.debug(`Saved GIF: ${gifPath} (size: ${(buffer.length / (1024 * 1024)).toFixed(2)}MB)`);

  // Invalidate stats cache since we added a new file
  invalidateStatsCache(storagePath);

  return { url: gifPath, method, buffer };
}

export async function cleanupTempFiles(tempFiles) {
  logger.debug(`Cleaning up ${tempFiles.length} temporary files`);
  const deletePromises = tempFiles.map(async filePath => {
    try {
      await fs.unlink(filePath);
      logger.debug(`Deleted temp file: ${filePath}`);
    } catch (error) {
      // Ignore errors if file doesn't exist
      if (error.code !== 'ENOENT') {
        logger.error(`Failed to delete temp file ${filePath}:`, error.message);
      }
    }
  });

  await Promise.all(deletePromises);
}

export function formatFileSize(bytes) {
  if (bytes === null || bytes === undefined) {
    logger.warn('formatFileSize called with null/undefined, returning 0.00 MB');
    return '0.00 MB';
  }

  const numBytes = typeof bytes === 'string' ? parseFloat(bytes) : Number(bytes);

  if (isNaN(numBytes) || !isFinite(numBytes)) {
    logger.warn('formatFileSize called with invalid number:', { bytes, numBytes });
    return '0.00 MB';
  }

  if (numBytes < 0) {
    logger.warn('formatFileSize called with negative number:', { bytes, numBytes });
    return '0.00 MB';
  }

  if (numBytes === 0) {
    return '0.00 MB';
  }

  try {
    const mb = numBytes / (1024 * 1024);
    if (mb >= 1024) {
      const gb = mb / 1024;
      return `${gb.toFixed(2)} GB`;
    }
    return `${mb.toFixed(2)} MB`;
  } catch (error) {
    logger.error('Error formatting file size:', { error: error.message, bytes, numBytes });
    return '0.00 MB';
  }
}

export function getVideoPath(hash, extension, storagePath) {
  const basePath = getStoragePath(storagePath);
  // Ensure hash is safe (alphanumeric only)
  const safeHash = hash.replace(/[^a-f0-9]/gi, '');
  // Ensure extension is safe (alphanumeric and dots only)
  const safeExt = extension.replace(/[^a-zA-Z0-9.]/gi, '');
  const ext = safeExt.startsWith('.') ? safeExt : `.${safeExt}`;
  // Check if basePath ends with 'gifs' - if so, go up one level to avoid gifs/videos nesting
  const normalizedBasePath = basePath.replace(/\\/g, '/');
  if (normalizedBasePath.endsWith('/gifs') || normalizedBasePath.endsWith('\\gifs')) {
    return path.join(path.dirname(basePath), 'videos', `${safeHash}${ext}`);
  }
  return path.join(basePath, 'videos', `${safeHash}${ext}`);
}

export async function videoExists(hash, extension, storagePath) {
  if (
    r2Config.accountId &&
    r2Config.accessKeyId &&
    r2Config.secretAccessKey &&
    r2Config.bucketName
  ) {
    return await videoExistsInR2(hash, extension, r2Config);
  }
  try {
    const videoPath = getVideoPath(hash, extension, storagePath);
    await fs.access(videoPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Save a video buffer to R2 or disk
 * @param {Buffer} buffer - Video file buffer
 * @param {string} hash - BLAKE3 hash of the video
 * @param {string} extension - File extension (e.g., '.mp4', '.webm')
 * @param {string} storagePath - Base storage path (for local fallback)
 * @param {Object} [metadata={}] - Optional metadata to attach to the object
 * @returns {Promise<{url: string, method: string, buffer: Buffer}>} Object with URL, upload method, and buffer
 */
export async function saveVideo(buffer, hash, extension, storagePath, metadata = {}) {
  const method = shouldUploadToDiscord(buffer) ? 'discord' : 'r2';

  // Only upload to R2 if file is >= 8MB (Discord limit)
  if (
    method === 'r2' &&
    r2Config.accountId &&
    r2Config.accessKeyId &&
    r2Config.secretAccessKey &&
    r2Config.bucketName
  ) {
    try {
      // Check if file already exists in R2 specifically (not local disk)
      const existsInR2 = await videoExistsInR2(hash, extension, r2Config);
      if (existsInR2) {
        const safeHash = hash.replace(/[^a-f0-9]/gi, '');
        const safeExt = extension.replace(/[^a-zA-Z0-9.]/gi, '');
        const ext = safeExt.startsWith('.') ? safeExt : `.${safeExt}`;
        const key = `videos/${safeHash}${ext}`;
        const publicUrl = getR2PublicUrl(key, r2Config);
        logger.info(`Video already exists in R2: ${publicUrl}`);
        return { url: publicUrl, method, buffer };
      }

      logger.info(
        `Uploading video to R2 (hash: ${hash.substring(0, 8)}..., size: ${(buffer.length / (1024 * 1024)).toFixed(2)}MB)`
      );
      const publicUrl = await uploadVideoToR2(buffer, hash, extension, r2Config, metadata);
      logger.info(
        `Saved video to R2: ${publicUrl} (size: ${(buffer.length / (1024 * 1024)).toFixed(2)}MB)`
      );
      incrementR2UsageCache(buffer.length);
      // Invalidate stats cache since we added a new file
      invalidateStatsCache(storagePath);
      return { url: publicUrl, method, buffer };
    } catch (error) {
      logger.error(`Failed to upload video to R2, falling back to local storage:`, error.message);
      logger.error(`R2 upload error details:`, error);
      // Fall through to local storage
    }
  }

  // Save to local disk (for Discord uploads < 8MB, or as fallback)
  const _basePath = getStoragePath(storagePath);
  const videoPath = getVideoPath(hash, extension, storagePath);

  await fs.mkdir(path.dirname(videoPath), { recursive: true });

  // Write file (fs.writeFile overwrites if file exists, so no TOCTOU issue)
  await fs.writeFile(videoPath, buffer);
  logger.debug(`Saved video: ${videoPath} (size: ${(buffer.length / (1024 * 1024)).toFixed(2)}MB)`);

  // Invalidate stats cache since we added a new file
  invalidateStatsCache(storagePath);

  return { url: videoPath, method, buffer };
}

export function getImagePath(hash, extension, storagePath) {
  const basePath = getStoragePath(storagePath);
  // Ensure hash is safe (alphanumeric only)
  const safeHash = hash.replace(/[^a-f0-9]/gi, '');
  // Ensure extension is safe (alphanumeric and dots only)
  const safeExt = extension.replace(/[^a-zA-Z0-9.]/gi, '');
  const ext = safeExt.startsWith('.') ? safeExt : `.${safeExt}`;
  // Check if basePath ends with 'gifs' - if so, go up one level to avoid gifs/images nesting
  const normalizedBasePath = basePath.replace(/\\/g, '/');
  if (normalizedBasePath.endsWith('/gifs') || normalizedBasePath.endsWith('\\gifs')) {
    return path.join(path.dirname(basePath), 'images', `${safeHash}${ext}`);
  }
  return path.join(basePath, 'images', `${safeHash}${ext}`);
}

export async function imageExists(hash, extension, storagePath) {
  if (
    r2Config.accountId &&
    r2Config.accessKeyId &&
    r2Config.secretAccessKey &&
    r2Config.bucketName
  ) {
    return await imageExistsInR2(hash, extension, r2Config);
  }
  try {
    const imagePath = getImagePath(hash, extension, storagePath);
    await fs.access(imagePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Save an image buffer to R2 or disk
 * @param {Buffer} buffer - Image file buffer
 * @param {string} hash - BLAKE3 hash of the image
 * @param {string} extension - File extension (e.g., '.png', '.jpg')
 * @param {string} storagePath - Base storage path (for local fallback)
 * @param {Object} [metadata={}] - Optional metadata to attach to the object
 * @returns {Promise<{url: string, method: string, buffer: Buffer}>} Object with URL, upload method, and buffer
 */
export async function saveImage(buffer, hash, extension, storagePath, metadata = {}) {
  const method = shouldUploadToDiscord(buffer) ? 'discord' : 'r2';

  // Only upload to R2 if file is >= 8MB (Discord limit)
  if (
    method === 'r2' &&
    r2Config.accountId &&
    r2Config.accessKeyId &&
    r2Config.secretAccessKey &&
    r2Config.bucketName
  ) {
    try {
      // Check if file already exists in R2 specifically (not local disk)
      const existsInR2 = await imageExistsInR2(hash, extension, r2Config);
      if (existsInR2) {
        const safeHash = hash.replace(/[^a-f0-9]/gi, '');
        const safeExt = extension.replace(/[^a-zA-Z0-9.]/gi, '');
        const ext = safeExt.startsWith('.') ? safeExt : `.${safeExt}`;
        const key = `images/${safeHash}${ext}`;
        const publicUrl = getR2PublicUrl(key, r2Config);
        logger.info(`Image already exists in R2: ${publicUrl}`);
        return { url: publicUrl, method, buffer };
      }

      logger.info(
        `Uploading image to R2 (hash: ${hash.substring(0, 8)}..., size: ${(buffer.length / (1024 * 1024)).toFixed(2)}MB)`
      );
      const publicUrl = await uploadImageToR2(buffer, hash, extension, r2Config, metadata);
      logger.info(
        `Saved image to R2: ${publicUrl} (size: ${(buffer.length / (1024 * 1024)).toFixed(2)}MB)`
      );
      incrementR2UsageCache(buffer.length);
      // Invalidate stats cache since we added a new file
      invalidateStatsCache(storagePath);
      return { url: publicUrl, method, buffer };
    } catch (error) {
      logger.error(`Failed to upload image to R2, falling back to local storage:`, error.message);
      logger.error(`R2 upload error details:`, error);
      // Fall through to local storage
    }
  }

  // Save to local disk (for Discord uploads < 8MB, or as fallback)
  const _basePath = getStoragePath(storagePath);
  const imagePath = getImagePath(hash, extension, storagePath);

  await fs.mkdir(path.dirname(imagePath), { recursive: true });

  // Write file (fs.writeFile overwrites if file exists, so no TOCTOU issue)
  await fs.writeFile(imagePath, buffer);
  logger.debug(`Saved image: ${imagePath} (size: ${(buffer.length / (1024 * 1024)).toFixed(2)}MB)`);

  // Invalidate stats cache since we added a new file
  invalidateStatsCache(storagePath);

  return { url: imagePath, method, buffer };
}

/**
 * Get storage statistics
 * @param {string} storagePath - Base storage path
 * @returns {Promise<{totalGifs: number, totalVideos: number, totalImages: number, diskUsageBytes: number, diskUsageFormatted: string, gifsDiskUsageBytes: number, gifsDiskUsageFormatted: string, videosDiskUsageBytes: number, videosDiskUsageFormatted: string, imagesDiskUsageBytes: number, imagesDiskUsageFormatted: string}>}
 */
export async function getStorageStats(storagePath) {
  try {
    if (!storagePath || typeof storagePath !== 'string' || storagePath.trim() === '') {
      logger.error('getStorageStats called with invalid storagePath:', {
        storagePath,
        type: typeof storagePath,
      });
      throw new Error('Storage path must be a non-empty string');
    }

    logger.debug(`Getting storage stats for: ${storagePath}`);

    try {
      const cachedStats = getCachedStats(storagePath);
      if (cachedStats) {
        logger.debug('Returning cached stats');
        return cachedStats;
      }
    } catch (error) {
      logger.warn('Error checking stats cache, continuing with fresh calculation:', error.message);
    }

    // Check if there's already a calculation in progress for this storage path
    // This prevents concurrent filesystem scans that could cause issues
    const existingCalculation = statsCalculationPromises.get(storagePath);
    if (existingCalculation) {
      logger.debug(`Stats calculation already in progress for ${storagePath}, waiting for result`);
      return await existingCalculation;
    }

    // Start a new calculation and store the promise
    // Add timeout to prevent hanging (30 seconds should be more than enough)
    const calculationPromise = Promise.race([
      calculateStorageStats(storagePath),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Stats calculation timeout')), 30000)
      ),
    ]);
    statsCalculationPromises.set(storagePath, calculationPromise);

    try {
      const result = await calculationPromise;
      return result;
    } catch (error) {
      logger.error('Stats calculation failed or timed out:', {
        error: error.message,
        storagePath,
      });
      // Return safe defaults - don't rethrow to avoid breaking the caller
      return {
        totalGifs: 0,
        totalVideos: 0,
        totalImages: 0,
        diskUsageBytes: 0,
        diskUsageFormatted: '0.00 MB',
        gifsDiskUsageBytes: 0,
        gifsDiskUsageFormatted: '0.00 MB',
        videosDiskUsageBytes: 0,
        videosDiskUsageFormatted: '0.00 MB',
        imagesDiskUsageBytes: 0,
        imagesDiskUsageFormatted: '0.00 MB',
      };
    } finally {
      statsCalculationPromises.delete(storagePath);
    }
  } catch (error) {
    // Make sure to clean up on error too
    statsCalculationPromises.delete(storagePath);
    logger.error(`Failed to get storage stats:`, {
      error: error.message,
      stack: error.stack,
      storagePath,
      storagePathType: typeof storagePath,
    });

    return {
      totalGifs: 0,
      totalVideos: 0,
      totalImages: 0,
      diskUsageBytes: 0,
      diskUsageFormatted: '0.00 MB',
      gifsDiskUsageBytes: 0,
      gifsDiskUsageFormatted: '0.00 MB',
      videosDiskUsageBytes: 0,
      videosDiskUsageFormatted: '0.00 MB',
      imagesDiskUsageBytes: 0,
      imagesDiskUsageFormatted: '0.00 MB',
    };
  }
}

/**
 * Internal function to actually calculate storage stats
 * This is separated to allow mutex protection in getStorageStats
 * @param {string} storagePath - Base storage path
 * @returns {Promise<Object>} Stats object
 */
async function calculateStorageStats(storagePath) {
  try {
    const useR2 =
      r2Config.accountId && r2Config.accessKeyId && r2Config.secretAccessKey && r2Config.bucketName;

    let totalGifs = 0;
    let totalVideos = 0;
    let totalImages = 0;
    let totalSize = 0;
    let gifsSize = 0;
    let videosSize = 0;
    let imagesSize = 0;

    if (useR2) {
      logger.debug('R2 configured, querying R2 for storage stats');

      // Single LIST call to get all objects (consolidated from 3 separate calls)
      // This limits class A operations by making one LIST request instead of three separate calls for gifs/videos/images
      try {
        const allObjects = await listObjectsInR2('', r2Config);
        logger.debug(`Listed ${allObjects.length} total objects from R2`);

        const gifFilesOnly = allObjects.filter(
          obj => obj.key.startsWith('gifs/') && obj.key.endsWith('.gif')
        );
        totalGifs = gifFilesOnly.length;
        logger.debug(`Found ${totalGifs} GIFs in R2`);
        for (const obj of gifFilesOnly) {
          gifsSize += obj.size;
          totalSize += obj.size;
        }

        const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];
        const videoFilesOnly = allObjects.filter(obj => {
          if (!obj.key.startsWith('videos/')) return false;
          const ext = path.extname(obj.key).toLowerCase();
          return videoExtensions.includes(ext);
        });
        totalVideos = videoFilesOnly.length;
        logger.debug(`Found ${totalVideos} videos in R2`);
        for (const obj of videoFilesOnly) {
          videosSize += obj.size;
          totalSize += obj.size;
        }

        const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp'];
        const imageFilesOnly = allObjects.filter(obj => {
          if (!obj.key.startsWith('images/')) return false;
          const ext = path.extname(obj.key).toLowerCase();
          return imageExtensions.includes(ext);
        });
        totalImages = imageFilesOnly.length;
        logger.debug(`Found ${totalImages} images in R2`);
        for (const obj of imageFilesOnly) {
          imagesSize += obj.size;
          totalSize += obj.size;
        }
      } catch (error) {
        logger.warn(`Failed to list objects from R2:`, error.message);
      }
    } else {
      logger.debug('R2 not configured, using local filesystem for storage stats');

      let basePath;
      try {
        basePath = getStoragePath(storagePath);
        logger.debug(`Resolved storage path to: ${basePath}`);
      } catch (error) {
        logger.error('Failed to resolve storage path in getStorageStats:', {
          error: error.message,
          stack: error.stack,
          storagePath,
        });
        throw error; // Re-throw to be caught by outer try-catch
      }

      try {
        const gifsPath = path.join(basePath, 'gifs');
        const gifFiles = await fs.readdir(gifsPath);
        const gifFilesOnly = gifFiles.filter(f => f.endsWith('.gif'));
        totalGifs = gifFilesOnly.length;

        for (const file of gifFilesOnly) {
          try {
            const filePath = path.join(gifsPath, file);
            const stats = await fs.stat(filePath);
            const fileSize = stats.size;
            gifsSize += fileSize;
            totalSize += fileSize;
          } catch (error) {
            logger.warn(`Failed to stat GIF file ${file}:`, error.message);
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          logger.warn(`Failed to read gifs directory:`, error.message);
        }
      }

      try {
        const videosPath = path.join(basePath, 'videos');
        const videoFiles = await fs.readdir(videosPath);
        const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];
        const videoFilesOnly = videoFiles.filter(f => {
          const ext = path.extname(f).toLowerCase();
          return videoExtensions.includes(ext);
        });
        totalVideos = videoFilesOnly.length;

        for (const file of videoFilesOnly) {
          try {
            const filePath = path.join(videosPath, file);
            const stats = await fs.stat(filePath);
            const fileSize = stats.size;
            videosSize += fileSize;
            totalSize += fileSize;
          } catch (error) {
            logger.warn(`Failed to stat video file ${file}:`, error.message);
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          logger.warn(`Failed to read videos directory:`, error.message);
        }
      }

      try {
        const imagesPath = path.join(basePath, 'images');
        const imageFiles = await fs.readdir(imagesPath);
        logger.debug(`Found ${imageFiles.length} entries in images directory`);
        const imageExtensions = ['.png', '.jpg', '.jpeg', '.webp'];
        const imageFilesOnly = [];

        for (const file of imageFiles) {
          try {
            const filePath = path.join(imagesPath, file);
            const stats = await fs.stat(filePath);

            // Only count regular files, not directories or symlinks
            if (!stats.isFile()) {
              logger.debug(
                `Skipping non-file entry in images directory: ${file} (isDirectory: ${stats.isDirectory()})`
              );
              continue;
            }

            const ext = path.extname(file).toLowerCase();
            if (imageExtensions.includes(ext)) {
              imageFilesOnly.push(file);
              logger.debug(
                `Found image file: ${file} (extension: ${ext}, size: ${stats.size} bytes)`
              );
            } else {
              logger.debug(`Skipping file with non-image extension: ${file} (extension: ${ext})`);
            }
          } catch (error) {
            logger.warn(`Failed to stat entry ${file} in images directory:`, error.message);
          }
        }

        totalImages = imageFilesOnly.length;
        logger.debug(`Total image files found: ${totalImages}`);

        for (const file of imageFilesOnly) {
          try {
            const filePath = path.join(imagesPath, file);
            const stats = await fs.stat(filePath);
            const fileSize = stats.size;
            imagesSize += fileSize;
            totalSize += fileSize;
          } catch (error) {
            logger.warn(`Failed to stat image file ${file}:`, error.message);
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          logger.warn(`Failed to read images directory:`, error.message);
        } else {
          logger.debug(`Images directory does not exist: ${path.join(basePath, 'images')}`);
        }
      }
    }

    let stats;
    try {
      stats = {
        totalGifs,
        totalVideos,
        totalImages,
        diskUsageBytes: totalSize,
        diskUsageFormatted: formatFileSize(totalSize),
        gifsDiskUsageBytes: gifsSize,
        gifsDiskUsageFormatted: formatFileSize(gifsSize),
        videosDiskUsageBytes: videosSize,
        videosDiskUsageFormatted: formatFileSize(videosSize),
        imagesDiskUsageBytes: imagesSize,
        imagesDiskUsageFormatted: formatFileSize(imagesSize),
      };
    } catch (error) {
      logger.error('Error formatting file sizes in getStorageStats:', {
        error: error.message,
        totalSize,
        gifsSize,
        videosSize,
        imagesSize,
      });
      stats = {
        totalGifs,
        totalVideos,
        totalImages,
        diskUsageBytes: totalSize,
        diskUsageFormatted: '0.00 MB',
        gifsDiskUsageBytes: gifsSize,
        gifsDiskUsageFormatted: '0.00 MB',
        videosDiskUsageBytes: videosSize,
        videosDiskUsageFormatted: '0.00 MB',
        imagesDiskUsageBytes: imagesSize,
        imagesDiskUsageFormatted: '0.00 MB',
      };
    }

    logger.debug(
      `Storage stats: ${stats.totalGifs} GIFs, ${stats.totalVideos} videos, ${stats.totalImages} images, ${stats.diskUsageFormatted}`
    );

    try {
      setCachedStats(storagePath, stats);
    } catch (error) {
      logger.warn('Failed to cache stats, continuing anyway:', error.message);
    }

    return stats;
  } catch (error) {
    logger.error(`Failed to get storage stats:`, {
      error: error.message,
      stack: error.stack,
      storagePath,
      storagePathType: typeof storagePath,
    });

    return {
      totalGifs: 0,
      totalVideos: 0,
      totalImages: 0,
      diskUsageBytes: 0,
      diskUsageFormatted: '0.00 MB',
      gifsDiskUsageBytes: 0,
      gifsDiskUsageFormatted: '0.00 MB',
      videosDiskUsageBytes: 0,
      videosDiskUsageFormatted: '0.00 MB',
      imagesDiskUsageBytes: 0,
      imagesDiskUsageFormatted: '0.00 MB',
    };
  }
}

export function getR2CacheStats() {
  const R2_FREE_LIMIT_GB = 10;
  const R2_FREE_LIMIT_BYTES = R2_FREE_LIMIT_GB * 1024 * 1024 * 1024;

  if (!r2UsageCache) {
    return {
      initialized: false,
      usageBytes: 0,
      usageFormatted: '0.00 MB',
      freeBytes: R2_FREE_LIMIT_BYTES,
      freeFormatted: `${R2_FREE_LIMIT_GB} GB`,
      limitBytes: R2_FREE_LIMIT_BYTES,
      limitFormatted: `${R2_FREE_LIMIT_GB} GB`,
      percentageUsed: 0,
      cacheAge: null,
      cacheAgeFormatted: 'N/A',
    };
  }

  const age = Date.now() - r2UsageCache.timestamp;
  const usageBytes = r2UsageCache.usageBytes;
  const freeBytes = Math.max(0, R2_FREE_LIMIT_BYTES - usageBytes);
  const percentageUsed = (usageBytes / R2_FREE_LIMIT_BYTES) * 100;

  return {
    initialized: true,
    usageBytes,
    usageFormatted: formatFileSize(usageBytes),
    freeBytes,
    freeFormatted: formatFileSize(freeBytes),
    limitBytes: R2_FREE_LIMIT_BYTES,
    limitFormatted: `${R2_FREE_LIMIT_GB} GB`,
    percentageUsed: Math.min(100, percentageUsed.toFixed(2)),
    cacheAge: age,
    cacheAgeFormatted: age < 60000 ? `${Math.round(age / 1000)}s` : `${Math.round(age / 60000)}m`,
  };
}

/**
 * Resolve the tiered retention (in hours) for a file of the given size, reading the steerable
 * `upload_ttl_tiers` setting and falling back to the default curve. Bigger files expire sooner.
 * @param {number} bytes
 * @returns {Promise<number>} whole hours
 */
export async function resolveTtlHoursForSize(bytes) {
  const tiersStr = await getSetting('upload_ttl_tiers', DEFAULT_TTL_TIERS);
  return ttlHoursForSize(bytes, tiersStr);
}

/**
 * Resolve retention hours for an already-recorded upload by looking up its stored file size.
 * Falls back to the flat config TTL when the size can't be read (keeps old behavior safe).
 * @param {string} urlHash
 * @returns {Promise<number>} whole hours
 */
async function resolveTtlHours(urlHash) {
  try {
    const record = await getProcessedUrl(urlHash);
    if (record && typeof record.file_size === 'number' && record.file_size > 0) {
      return await resolveTtlHoursForSize(record.file_size);
    }
  } catch (error) {
    logger.warn(`Could not resolve tiered TTL for ${urlHash.substring(0, 8)}...: ${error.message}`);
  }
  return r2Config.tempUploadTtlHours;
}

/**
 * Track a temporary R2 upload for automatic cleanup
 * This should be called after processed_urls record is created (since FK constraint requires it)
 * @param {string} urlHash - URL hash from processed_urls table (required for FK)
 * @param {string} r2Key - R2 object key (e.g., 'gifs/abc123.gif')
 * @param {number} [uploadedAt] - Unix timestamp in milliseconds (defaults to now)
 * @param {boolean} [isAdmin=false] - Whether the user is an admin (admins have permanent uploads)
 * @returns {Promise<void>}
 */
export async function trackTemporaryUpload(urlHash, r2Key, uploadedAt = null, isAdmin = false) {
  // Admin uploads are permanent unless the admin_uploads_expire setting (webui)
  // opts them into the same TTL cleanup as everyone else. A settings read failure
  // falls back to the old permanent behavior - never surprise-delete admin files.
  if (isAdmin) {
    let adminUploadsExpire = false;
    try {
      adminUploadsExpire = await getBooleanSetting('admin_uploads_expire', false);
    } catch (error) {
      logger.warn(`Could not read admin_uploads_expire setting: ${error.message}`);
    }
    if (!adminUploadsExpire) {
      logger.debug(
        `Skipping temporary upload tracking for admin user: urlHash=${urlHash.substring(0, 8)}..., r2Key=${r2Key}`
      );
      return;
    }
  }

  if (!r2Config.tempUploadsEnabled) {
    return; // Tracking disabled, skip
  }

  if (!urlHash || !r2Key) {
    logger.warn('Cannot track temporary upload: urlHash or r2Key is missing', {
      urlHash: urlHash ? 'present' : 'missing',
      r2Key: r2Key ? 'present' : 'missing',
    });
    return;
  }

  try {
    const now = uploadedAt || Date.now();
    const ttlHours = await resolveTtlHours(urlHash);
    const expiresAt = now + ttlHours * 60 * 60 * 1000;

    await insertTemporaryUpload(urlHash, r2Key, now, expiresAt);
    logger.debug(
      `Tracked temporary R2 upload: urlHash=${urlHash.substring(0, 8)}..., r2_key=${r2Key}, ttlHours=${ttlHours}, expiresAt=${new Date(expiresAt).toISOString()}`
    );
  } catch (error) {
    // Log error but don't throw - tracking failure shouldn't break upload flow
    logger.error(`Failed to track temporary upload: ${error.message}`, error);
  }
}
