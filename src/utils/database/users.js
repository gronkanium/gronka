import { getDb } from './connection.js';

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
  const getUserStmt = db.prepare('SELECT first_used FROM users WHERE user_id = ?');
  const existing = getUserStmt.get(userId);

  if (existing) {
    // Update last_used and username (in case username changed)
    const updateStmt = db.prepare('UPDATE users SET last_used = ?, username = ? WHERE user_id = ?');
    updateStmt.run(timestamp, username, userId);
  } else {
    // Insert new user
    const insertStmt = db.prepare(
      'INSERT INTO users (user_id, username, first_used, last_used) VALUES (?, ?, ?, ?)'
    );
    insertStmt.run(userId, username, timestamp, timestamp);
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

  const stmt = db.prepare('SELECT * FROM users WHERE user_id = ?');
  return stmt.get(userId) || null;
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

  const stmt = db.prepare('SELECT COUNT(*) as count FROM users');
  const result = stmt.get();
  return result ? result.count : 0;
}
