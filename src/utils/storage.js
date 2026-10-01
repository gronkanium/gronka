import fs from 'fs/promises';
import path from 'path';
import { createLogger } from './logger.js';
import { r2Config, botConfig } from './config.js';
import { uploadMediaToR2, mediaExistsInR2, isR2Configured, listObjectsInR2 } from './r2-storage.js';
import {
  insertTemporaryUpload,
  getBooleanSetting,
  getProcessedUrl,
  getSetting,
} from './database.js';
import { ttlHoursForSize, DEFAULT_TTL_TIERS } from './upload-tiers.js';

const logger = createLogger('storage');

// The caller owns the limit: it comes from interaction.attachmentSizeLimit via
// shared/attachment-limit.js, so this file must not keep a second copy of it.
function pickUploadMethod(size, discordLimit) {
  return size <= discordLimit ? 'discord' : 'r2';
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
  if (!isR2Configured(r2Config)) {
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
  }
}

function getStoragePath(storagePath) {
  if (typeof storagePath !== 'string' || !storagePath.trim()) {
    throw new Error('Storage path must be a non-empty string');
  }
  return path.resolve(storagePath.trim());
}

// GIF_STORAGE_PATH points at data-*/gifs, so every kind lives beside it, not inside it.
function mediaRoot(storagePath) {
  const basePath = getStoragePath(storagePath);
  return basePath.replace(/\\/g, '/').endsWith('/gifs') ? path.dirname(basePath) : basePath;
}

/**
 * Detect file type from extension and content type
 * @param {string} extension - File extension (e.g., '.mp4', '.png', '.gif')
 * @param {string} [contentType] - Optional content type (e.g., 'video/mp4', 'image/png')
 * @param {Buffer} [buffer] - File contents; when passed, its magic bytes override both signals
 * @returns {'gif'|'video'|'image'} File type
 */
export function detectFileType(extension, contentType = '', head = null) {
  const ext = extension.toLowerCase();

  // Magic bytes beat both other signals: they describe the file we actually have, whereas the
  // extension and the content-type are both claims by the source. Some sources serve real GIFs
  // under a video/* content-type, and trusting that put genuine gifs behind the videos/ prefix.
  if (head && head.length >= 6) {
    const magic = head.subarray(0, 6).toString('latin1');
    if (magic === 'GIF87a' || magic === 'GIF89a') {
      return 'gif';
    }
    // ISO-BMFF ('ftyp' at offset 4) covers mp4/mov/m4v, an mp4 named .gif lands here.
    if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
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

const MEDIA_DIRS = { gif: 'gifs', video: 'videos', image: 'images' };

function safeExtension(type, extension) {
  if (type === 'gif') return '.gif';
  const safe = extension.replace(/[^a-zA-Z0-9.]/gi, '');
  return safe.startsWith('.') ? safe : `.${safe}`;
}

export function mediaPath(type, hash, extension, storagePath) {
  const root = mediaRoot(storagePath);
  const safeHash = hash.replace(/[^a-f0-9]/gi, '');
  return path.join(root, MEDIA_DIRS[type], `${safeHash}${safeExtension(type, extension)}`);
}

export const isRemote = location => /^https?:\/\//i.test(location);

// saveMedia hands back an R2 URL or a local path; both become the URL a user can open.
export function mediaPublicUrl(location, type) {
  if (isRemote(location)) return location;
  return `${botConfig.cdnBaseUrl.replace('/gifs', `/${MEDIA_DIRS[type]}`)}/${path.basename(location)}`;
}

export async function storedSize(location, fallback) {
  if (isRemote(location)) return fallback;
  try {
    return (await fs.stat(location)).size;
  } catch {
    return fallback;
  }
}

export async function mediaExists(type, hash, extension, storagePath) {
  if (isR2Configured(r2Config)) {
    return await mediaExistsInR2(type, hash, extension, r2Config);
  }
  try {
    await fs.access(mediaPath(type, hash, extension, storagePath));
    return true;
  } catch {
    return false;
  }
}

// Returns {url, method}: url is an R2 URL when uploaded there, else the local path.
export async function saveMedia(
  type,
  file,
  hash,
  extension,
  storagePath,
  metadata = {},
  discordLimit = botConfig.discordSizeLimit
) {
  const method = pickUploadMethod(file.size, discordLimit);
  const sizeMb = (file.size / (1024 * 1024)).toFixed(2);

  if (method === 'r2' && isR2Configured(r2Config)) {
    try {
      logger.debug(`Uploading ${type} to R2 (hash: ${hash.substring(0, 8)}..., size: ${sizeMb}MB)`);
      const publicUrl = await uploadMediaToR2(type, file, hash, extension, r2Config, metadata);
      logger.debug(`Saved ${type} to R2: ${publicUrl} (size: ${sizeMb}MB)`);
      incrementR2UsageCache(file.size);
      invalidateStatsCache(storagePath);
      return { url: publicUrl, method };
    } catch (error) {
      logger.error(`Failed to upload ${type} to R2, falling back to local storage:`, error);
    }
  }

  const filePath = mediaPath(type, hash, extension, storagePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.copyFile(file.path, filePath);
  logger.debug(`Saved ${type}: ${filePath} (size: ${sizeMb}MB)`);
  invalidateStatsCache(storagePath);
  return { url: filePath, method };
}

export function formatFileSize(bytes) {
  const mb = Math.max(0, Number(bytes) || 0) / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(2)} MB`;
}

const STORED_KINDS = {
  gif: { dir: 'gifs', exts: ['.gif'] },
  video: { dir: 'videos', exts: ['.mp4', '.webm', '.mov', '.avi', '.mkv'] },
  image: { dir: 'images', exts: ['.png', '.jpg', '.jpeg', '.webp'] },
};
const kindOf = (dir, name) =>
  Object.keys(STORED_KINDS).find(
    k =>
      STORED_KINDS[k].dir === dir && STORED_KINDS[k].exts.includes(path.extname(name).toLowerCase())
  );

// Every stored file as {kind, size}, from R2 when it is configured, else from local disk.
async function listStored(storagePath) {
  if (isR2Configured(r2Config)) {
    const objects = await listObjectsInR2('', r2Config);
    return objects.flatMap(o => {
      const [dir, ...rest] = o.key.split('/');
      const kind = rest.length && kindOf(dir, o.key);
      return kind ? [{ kind, size: o.size }] : [];
    });
  }
  const root = mediaRoot(storagePath);
  const lists = await Promise.all(
    Object.values(STORED_KINDS).map(async ({ dir }) => {
      const entries = await fs
        .readdir(path.join(root, dir), { withFileTypes: true })
        .catch(error => {
          if (error.code === 'ENOENT') return [];
          throw error;
        });
      const files = entries.filter(e => e.isFile() && kindOf(dir, e.name));
      return Promise.all(
        files.map(async e => ({
          kind: kindOf(dir, e.name),
          size: (await fs.stat(path.join(root, dir, e.name))).size,
        }))
      );
    })
  );
  return lists.flat();
}

async function calculateStorageStats(storagePath) {
  const sums = { gif: [0, 0], video: [0, 0], image: [0, 0] };
  for (const { kind, size } of await listStored(storagePath)) {
    sums[kind][0] += 1;
    sums[kind][1] += size;
  }
  const total = sums.gif[1] + sums.video[1] + sums.image[1];
  const stats = {
    totalGifs: sums.gif[0],
    totalVideos: sums.video[0],
    totalImages: sums.image[0],
    diskUsageBytes: total,
    diskUsageFormatted: formatFileSize(total),
    gifsDiskUsageBytes: sums.gif[1],
    gifsDiskUsageFormatted: formatFileSize(sums.gif[1]),
    videosDiskUsageBytes: sums.video[1],
    videosDiskUsageFormatted: formatFileSize(sums.video[1]),
    imagesDiskUsageBytes: sums.image[1],
    imagesDiskUsageFormatted: formatFileSize(sums.image[1]),
  };
  setCachedStats(storagePath, stats);
  return stats;
}

// One scan per path at a time; a failure throws rather than reporting an empty store.
export async function getStorageStats(storagePath) {
  const cached = getCachedStats(storagePath);
  if (cached) return cached;
  if (!statsCalculationPromises.has(storagePath)) {
    statsCalculationPromises.set(
      storagePath,
      calculateStorageStats(storagePath).finally(() => statsCalculationPromises.delete(storagePath))
    );
  }
  return statsCalculationPromises.get(storagePath);
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
