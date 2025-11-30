import axios from 'axios';
import { createLogger } from '../../utils/logger.js';
import { webuiConfig, botConfig } from '../../utils/config.js';
import { getAuthHeaders } from '../utils/auth.js';

const logger = createLogger('webui');

// Stats cache to reduce load on main server
// Use botConfig.statsCacheTtl (default 5 minutes) but cap at 30 seconds for webui refresh interval
const STATS_CACHE_TTL = Math.min(botConfig.statsCacheTtl || 300000, 30 * 1000);
// Health cache to reduce load on main server
const HEALTH_CACHE_TTL = STATS_CACHE_TTL; // Match stats cache TTL

let statsCache = null;
let statsCacheTimestamp = 0;
let healthCache = null;
let healthCacheTimestamp = 0;

const { mainServerUrl: MAIN_SERVER_URL } = webuiConfig;

export async function getStats() {
  try {
    // Check cache first
    const now = Date.now();
    if (statsCache && now - statsCacheTimestamp < STATS_CACHE_TTL) {
      logger.debug('Returning cached stats');
      return statsCache;
    }

    logger.debug('Fetching stats from main server');
    const response = await axios.get(`${MAIN_SERVER_URL}/api/stats`, {
      timeout: 5000,
      headers: getAuthHeaders(),
    });

    // Cache the response
    statsCache = response.data;
    statsCacheTimestamp = now;

    return response.data;
  } catch (error) {
    // If we have cached data and the request failed, return cached data
    if (statsCache && error.response?.status === 429) {
      logger.warn('Rate limited by main server, returning cached stats');
      return statsCache;
    }

    logger.error('Failed to fetch stats from main server:', error);

    // If we have stale cache, return it anyway as fallback
    if (statsCache) {
      logger.warn('Returning stale cached stats due to error');
      return statsCache;
    }

    throw error;
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

    logger.debug('Fetching health from main server');
    const response = await axios.get(`${MAIN_SERVER_URL}/health`, {
      timeout: 5000,
      headers: getAuthHeaders(),
    });

    // Cache the response
    healthCache = response.data;
    healthCacheTimestamp = now;

    return response.data;
  } catch (error) {
    // If we have cached data and the request failed, return cached data
    if (healthCache && error.response?.status === 429) {
      logger.warn('Rate limited by main server, returning cached health');
      return healthCache;
    }

    logger.error('Failed to fetch health from main server:', error);

    // If we have stale cache, return it anyway as fallback
    if (healthCache) {
      logger.warn('Returning stale cached health due to error');
      return healthCache;
    }

    throw error;
  }
}
