import path from 'path';
import { createLogger } from './logger.js';
import { r2Config, botConfig } from './config.js';
import { isR2Configured, listMediaInR2, getR2Usage, setR2Usage } from './r2-storage.js';
import { getSetting } from './database.js';
import { ttlHoursForSize, DEFAULT_TTL_TIERS } from './upload-tiers.js';

const logger = createLogger('storage');

// R2 LIST results for /info and the webui; TTL from STATS_CACHE_TTL (0 disables).
let statsCache = null;
let statsCalculation = null;

// One LIST at startup so the soft limit and /info have a number before the first cleanup run.
export async function initializeR2UsageCache() {
  if (!isR2Configured(r2Config)) return;
  try {
    const objects = await listMediaInR2(r2Config);
    setR2Usage(objects.reduce((sum, o) => sum + o.size, 0));
    logger.info(`R2 usage: ${formatFileSize(getR2Usage().bytes)}`);
  } catch (error) {
    logger.error(`Failed to read R2 usage: ${error.message}`);
  }
}

export function detectFileType(extension, contentType = '', head = null) {
  const ext = extension.toLowerCase();
  if (ext === '.zip') return 'archive';

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

async function calculateStorageStats() {
  const sums = { gif: [0, 0], video: [0, 0], image: [0, 0] };
  const objects = isR2Configured(r2Config) ? await listMediaInR2(r2Config) : [];
  for (const o of objects) {
    const kind = kindOf(o.key.split('/')[0], o.key);
    if (!kind) continue;
    sums[kind][0] += 1;
    sums[kind][1] += o.size;
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
  if (botConfig.statsCacheTtl > 0) statsCache = { stats, timestamp: Date.now() };
  return stats;
}

// One R2 scan at a time; a failure throws rather than reporting an empty store.
export async function getStorageStats() {
  if (statsCache && Date.now() - statsCache.timestamp < botConfig.statsCacheTtl) {
    return statsCache.stats;
  }
  statsCalculation ??= calculateStorageStats().finally(() => {
    statsCalculation = null;
  });
  return statsCalculation;
}

export function getR2CacheStats() {
  const R2_FREE_LIMIT_GB = 10;
  const limitBytes = R2_FREE_LIMIT_GB * 1024 * 1024 * 1024;
  const usage = getR2Usage();
  const usageBytes = usage?.bytes ?? 0;
  const age = usage ? Date.now() - usage.at : null;
  return {
    initialized: Boolean(usage),
    usageBytes,
    usageFormatted: formatFileSize(usageBytes),
    freeBytes: Math.max(0, limitBytes - usageBytes),
    freeFormatted: formatFileSize(Math.max(0, limitBytes - usageBytes)),
    limitBytes,
    limitFormatted: `${R2_FREE_LIMIT_GB} GB`,
    percentageUsed: Math.min(100, ((usageBytes / limitBytes) * 100).toFixed(2)),
    cacheAge: age,
    cacheAgeFormatted:
      age === null
        ? 'N/A'
        : age < 60000
          ? `${Math.round(age / 1000)}s`
          : `${Math.round(age / 60000)}m`,
  };
}

// Resolve the tiered retention (in hours) for a file of the given size, reading the steerable `upload_ttl_tiers` setting and falling back to the default curve
export async function resolveTtlHoursForSize(bytes) {
  const tiersStr = await getSetting('upload_ttl_tiers', DEFAULT_TTL_TIERS);
  return ttlHoursForSize(bytes, tiersStr);
}
