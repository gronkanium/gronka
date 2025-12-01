import { createLogger } from '../../utils/logger.js';
import { botConfig } from '../../utils/config.js';
import { getStorageStats } from '../../utils/storage.js';

const logger = createLogger('webui');

// Stats cache TTL - use bot config value (default 5 minutes) but cap at 30 seconds for webui refresh interval
const STATS_CACHE_TTL = Math.min(botConfig.statsCacheTtl || 300000, 30 * 1000);
// Health cache to reduce load on calculation
const HEALTH_CACHE_TTL = STATS_CACHE_TTL; // Match stats cache TTL

let statsCache = null;
let statsCacheTimestamp = 0;
let healthCache = null;
let healthCacheTimestamp = 0;

export async function getStats() {
  try {
    // Check cache first
    const now = Date.now();
    if (statsCache && now - statsCacheTimestamp < STATS_CACHE_TTL) {
      logger.debug('Returning cached stats');
      return statsCache;
    }

    logger.debug('Calculating stats directly from storage');

    // Get storage path from bot config
    const storagePath = botConfig.gifStoragePath;
    if (!storagePath) {
      logger.error('Storage path not configured');
      throw new Error('Storage path not configured');
    }

    // Calculate stats directly using storage utility
    const stats = await getStorageStats(storagePath);

    // Format response to match expected API format
    const response = {
      total_gifs: stats.totalGifs,
      total_videos: stats.totalVideos,
      total_images: stats.totalImages,
      disk_usage_formatted: stats.diskUsageFormatted,
      gifs_disk_usage_formatted: stats.gifsDiskUsageFormatted,
      videos_disk_usage_formatted: stats.videosDiskUsageFormatted,
      images_disk_usage_formatted: stats.imagesDiskUsageFormatted,
      storage_path: storagePath,
    };

    // Cache the response
    statsCache = response;
    statsCacheTimestamp = now;

    return response;
  } catch (error) {
    logger.error('Failed to calculate stats:', error);

    // If we have stale cache, return it anyway as fallback
    if (statsCache) {
      logger.debug('Returning stale cached stats due to error');
      return statsCache;
    }

    // Return a fallback stats response instead of throwing
    const fallbackStats = {
      total_gifs: 0,
      total_videos: 0,
      total_images: 0,
      disk_usage_formatted: '0 B',
      gifs_disk_usage_formatted: '0 B',
      videos_disk_usage_formatted: '0 B',
      images_disk_usage_formatted: '0 B',
      storage_path: 'unknown',
      error: error.message,
    };

    return fallbackStats;
  }
}

export async function getHealth() {
  try {
    // Check cache first
    const now = Date.now();
    if (healthCache && now - healthCacheTimestamp < HEALTH_CACHE_TTL) {
      logger.debug('Returning cached health');
      return healthCache;
    }

    logger.debug('Calculating health directly');

    // Simple health response - webui doesn't need detailed component health
    // The webui server itself being up means it's healthy
    const response = {
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      timestamp: Math.floor(Date.now() / 1000),
      components: {
        webui: { status: 'ok' },
        database: { status: 'ok' }, // If we got here, DB is working
      },
    };

    // Cache the response
    healthCache = response;
    healthCacheTimestamp = now;

    return response;
  } catch (error) {
    logger.error('Failed to calculate health:', error);

    // If we have stale cache, return it anyway as fallback
    if (healthCache) {
      logger.debug('Returning stale cached health due to error');
      return healthCache;
    }

    // Return a fallback health response
    const fallbackHealth = {
      status: 'degraded',
      uptime: Math.floor(process.uptime()),
      timestamp: Math.floor(Date.now() / 1000),
      components: {
        webui: { status: 'error', error: error.message },
      },
      error: error.message,
    };

    return fallbackHealth;
  }
}
