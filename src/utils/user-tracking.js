import {
  insertOrUpdateUser,
  getUniqueUserCount as dbGetUniqueUserCount,
  initDatabase,
} from './database.js';

// Track if database has been initialized
let dbInitialized = false;

/**
 * Initialize user tracking (load existing users from database)
 * @returns {Promise<void>}
 */
export async function initializeUserTracking() {
  if (!dbInitialized) {
    await initDatabase();
    dbInitialized = true;
  }
}

/**
 * Track a user (add to database or update last_used timestamp)
 * @param {string} userId - Discord user ID
 * @param {string} username - Discord username/tag
 * @returns {Promise<void>}
 */
export async function trackUser(userId, username = null) {
  if (!userId || typeof userId !== 'string') {
    return;
  }

  // Initialize database if not already done
  if (!dbInitialized) {
    await initDatabase();
    dbInitialized = true;
  }

  // If username not provided, use a default
  const usernameToStore = username || 'unknown';

  const timestamp = Date.now();
  insertOrUpdateUser(userId, usernameToStore, timestamp);
}

/**
 * Get count of unique users who have used the bot
 * @returns {Promise<number>} Number of unique users
 */
export async function getUniqueUserCount() {
  // Initialize database if not already done
  if (!dbInitialized) {
    await initDatabase();
    dbInitialized = true;
  }

  return dbGetUniqueUserCount();
}

/**
 * Track a recent conversion for a user (in-memory only, for backwards compatibility)
 * @param {string} userId - Discord user ID
 * @param {string} url - GIF URL
 * @returns {void}
 */
let recentConversions = new Map();

export function trackRecentConversion(userId, url) {
  if (!userId || typeof userId !== 'string' || !url || typeof url !== 'string') {
    return;
  }

  if (!recentConversions.has(userId)) {
    recentConversions.set(userId, []);
  }

  const conversions = recentConversions.get(userId);

  // Remove if already exists (to move to front)
  const index = conversions.indexOf(url);
  if (index !== -1) {
    conversions.splice(index, 1);
  }

  // Add to front
  conversions.unshift(url);

  // Keep only last 10
  if (conversions.length > 10) {
    conversions.pop();
  }
}

/**
 * Get recent conversions for a user
 * @param {string} userId - Discord user ID
 * @returns {string[]} Array of recent conversion URLs (up to 10)
 */
export function getRecentConversions(userId) {
  if (!userId || typeof userId !== 'string') {
    return [];
  }

  return recentConversions.get(userId) || [];
}
