import { getDb, getCachedStatement } from './connection.js';

// Query result cache for getUser
const userCache = new Map(); // Map<userId, {data, timestamp}>
const USER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get cached user if available and not expired
 * @param {string} userId - User ID
 * @returns {Object|null} Cached user or null
 */
function getCachedUser(userId) {
  const cached = userCache.get(userId);
  if (!cached) {
    return null;
  }
  const age = Date.now() - cached.timestamp;
  if (age >= USER_CACHE_TTL) {
    userCache.delete(userId);
    return null;
  }
  return cached.data;
}

/**
 * Cache user
 * @param {string} userId - User ID
 * @param {Object|null} user - User object to cache
 */
function setCachedUser(userId, user) {
  userCache.set(userId, {
    data: user,
    timestamp: Date.now(),
  });
}

/**
 * Invalidate user cache
 * @param {string} userId - User ID to invalidate (or null to clear all)
 */
export function invalidateUserCache(userId = null) {
  if (userId) {
    userCache.delete(userId);
  } else {
    userCache.clear();
  }
}

/**
 * Insert or update a user in the database
 * @param {string} userId - Discord user ID
 * @param {string} username - Discord username/tag
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @returns {void}
 */
export function insertOrUpdateUser(userId, username, timestamp) {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return;
  }

  if (!userId || typeof userId !== 'string') {
    return;
  }

  // Check if user exists
  const getUserStmt = getCachedStatement('SELECT first_used FROM users WHERE user_id = ?');
  const existing = getUserStmt.get(userId);

  if (existing) {
    // Update last_used and username (in case username changed)
    const updateStmt = getCachedStatement(
      'UPDATE users SET last_used = ?, username = ? WHERE user_id = ?'
    );
    updateStmt.run(timestamp, username, userId);
    // Invalidate cache for this user
    invalidateUserCache(userId);
  } else {
    // Insert new user
    const insertStmt = getCachedStatement(
      'INSERT INTO users (user_id, username, first_used, last_used) VALUES (?, ?, ?, ?)'
    );
    insertStmt.run(userId, username, timestamp, timestamp);
    // Invalidate cache for this user
    invalidateUserCache(userId);
  }
}

/**
 * Get user information from the database
 * @param {string} userId - Discord user ID
 * @returns {Object|null} User object or null if not found
 */
export function getUser(userId) {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return null;
  }

  // Check cache first
  const cached = getCachedUser(userId);
  if (cached !== null) {
    return cached;
  }

  const stmt = getCachedStatement('SELECT * FROM users WHERE user_id = ?');
  const user = stmt.get(userId) || null;

  // Cache result (even null to avoid repeated queries for non-existent users)
  setCachedUser(userId, user);

  return user;
}

/**
 * Get unique user count
 * @returns {number} Number of unique users
 */
export function getUniqueUserCount() {
  const db = getDb();
  if (!db) {
    console.error('Database not initialized. Call initDatabase() first.');
    return 0;
  }

  const stmt = getCachedStatement('SELECT COUNT(*) as count FROM users');
  const result = stmt.get();
  return result ? result.count : 0;
}
