import {
  insertOrUpdateUser,
  getUniqueUserCount as dbGetUniqueUserCount,
  initDatabase,
} from './database.js';

// Track if database has been initialized
let dbInitialized = false;

export async function initializeUserTracking() {
  if (!dbInitialized) {
    await initDatabase();
    dbInitialized = true;
  }
}

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
  await insertOrUpdateUser(userId, usernameToStore, timestamp);
}

export async function getUniqueUserCount() {
  // Initialize database if not already done
  if (!dbInitialized) {
    await initDatabase();
    dbInitialized = true;
  }

  return await dbGetUniqueUserCount();
}

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

export function getRecentConversions(userId) {
  if (!userId || typeof userId !== 'string') {
    return [];
  }

  return recentConversions.get(userId) || [];
}
