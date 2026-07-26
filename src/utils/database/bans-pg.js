import { getPostgresConnection } from './connection.js';
import { ensurePostgresInitialized } from './init.js';
import { convertTimestampsToNumbers } from './helpers-pg.js';

// Short-lived cache so the per-interaction ban check doesn't hit the database on every command
const banCache = new Map(); // Map<userId, {banned: Object|null, timestamp}>
const BAN_CACHE_TTL = 10 * 1000; // 10 seconds

/**
 * Invalidate the ban check cache
 * @param {string|null} userId - User ID to invalidate (or null to clear all)
 */
export function invalidateBanCache(userId = null) {
  if (userId) {
    banCache.delete(userId);
  } else {
    banCache.clear();
  }
}

/**
 * Get a user's ban record, if any
 * @param {string} userId - Discord user ID
 * @returns {Promise<Object|null>} Ban record or null if not banned
 */
export async function getBan(userId) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return null;
  }

  const cached = banCache.get(userId);
  if (cached && Date.now() - cached.timestamp < BAN_CACHE_TTL) {
    return cached.banned;
  }

  const result = await sql`SELECT * FROM banned_users WHERE user_id = ${userId}`;
  const ban = result.length > 0 ? convertTimestampsToNumbers(result[0], ['banned_at']) : null;

  banCache.set(userId, { banned: ban, timestamp: Date.now() });

  return ban;
}

export async function banUser(userId, reason, appealAllowed = true) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return;
  }

  const now = Date.now();

  await sql`
    INSERT INTO banned_users (user_id, reason, banned_at, appeal_allowed)
    VALUES (${userId}, ${reason}, ${now}, ${appealAllowed})
    ON CONFLICT (user_id) DO UPDATE SET
      reason = ${reason},
      banned_at = ${now},
      appeal_allowed = ${appealAllowed}
  `;

  invalidateBanCache(userId);
}

export async function unbanUser(userId) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return false;
  }

  const result = await sql`DELETE FROM banned_users WHERE user_id = ${userId} RETURNING user_id`;

  invalidateBanCache(userId);

  return result.length > 0;
}

export async function listBans() {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return [];
  }

  const result = await sql`SELECT * FROM banned_users ORDER BY banned_at DESC`;

  return result.map(row => convertTimestampsToNumbers(row, ['banned_at']));
}
