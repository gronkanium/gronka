import { getPostgresConnection } from './connection.js';
import { ensurePostgresInitialized } from './init.js';
import { convertTimestampsToNumbers } from './helpers-pg.js';

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
 * @returns {Promise<void>}
 */
export async function insertOrUpdateUser(userId, username, timestamp) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return;
  }

  if (!userId || typeof userId !== 'string') {
    return;
  }

  // Check if user exists
  const existing = await sql`SELECT first_used FROM users WHERE user_id = ${userId}`;

  if (existing.length > 0) {
    // Update last_used and username (in case username changed)
    await sql`
      UPDATE users
      SET last_used = ${timestamp}, username = ${username}
      WHERE user_id = ${userId}
    `;
    // Invalidate cache for this user
    invalidateUserCache(userId);
  } else {
    // Insert new user
    await sql`
      INSERT INTO users (user_id, username, first_used, last_used)
      VALUES (${userId}, ${username}, ${timestamp}, ${timestamp})
    `;
    // Invalidate cache for this user
    invalidateUserCache(userId);
  }
}

/**
 * Get user information from the database
 * @param {string} userId - Discord user ID
 * @returns {Promise<Object|null>} User object or null if not found
 */
export async function getUser(userId) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return null;
  }

  // Check cache first
  const cached = getCachedUser(userId);
  if (cached !== null) {
    return cached;
  }

  const result = await sql`SELECT * FROM users WHERE user_id = ${userId}`;
  const user = result.length > 0 ? result[0] : null;

  // Convert timestamp fields from strings to numbers
  const convertedUser = user ? convertTimestampsToNumbers(user, ['first_used', 'last_used']) : null;

  // Cache result (even null to avoid repeated queries for non-existent users)
  setCachedUser(userId, convertedUser);

  return convertedUser;
}

/**
 * Get unique user count
 * @returns {Promise<number>} Number of unique users
 */
export async function getUniqueUserCount() {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return 0;
  }

  const result = await sql`SELECT COUNT(*) as count FROM users`;
  return parseInt(result[0]?.count || 0, 10);
}
