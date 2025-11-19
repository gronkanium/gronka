import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');
const USERS_FILE = path.join(projectRoot, 'data', 'users.json');

// In-memory Set for fast lookups and tracking
let trackedUsers = new Set();

// In-memory Map for recent conversions: userId -> array of URLs (max 10)
let recentConversions = new Map();

// Flag to prevent concurrent writes
let isSaving = false;

/**
 * Ensure data directory exists
 * @returns {Promise<void>}
 */
async function ensureDataDir() {
  try {
    const dataDir = path.dirname(USERS_FILE);
    await fs.mkdir(dataDir, { recursive: true });
  } catch (error) {
    // Directory might already exist, ignore error
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
}

/**
 * Load tracked users from disk
 * @returns {Promise<Set<string>>} Set of user IDs
 */
async function loadUsers() {
  await ensureDataDir();

  try {
    const data = await fs.readFile(USERS_FILE, 'utf-8');
    const userIds = JSON.parse(data);
    if (Array.isArray(userIds)) {
      trackedUsers = new Set(userIds);
    } else {
      trackedUsers = new Set();
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      // File doesn't exist yet, start with empty set
      trackedUsers = new Set();
    } else {
      // Other errors - log and start fresh
      console.error(`Error loading tracked users: ${error.message}`);
      trackedUsers = new Set();
    }
  }

  return trackedUsers;
}

/**
 * Save tracked users to disk
 * @returns {Promise<void>}
 */
async function saveUsers() {
  if (isSaving) {
    return; // Skip if already saving
  }

  isSaving = true;
  try {
    await ensureDataDir();
    const userIds = Array.from(trackedUsers);
    await fs.writeFile(USERS_FILE, JSON.stringify(userIds, null, 2), 'utf-8');
  } catch (error) {
    console.error(`Error saving tracked users: ${error.message}`);
  } finally {
    isSaving = false;
  }
}

/**
 * Track a user (add to set and persist)
 * @param {string} userId - Discord user ID
 * @returns {Promise<void>}
 */
export async function trackUser(userId) {
  if (!userId || typeof userId !== 'string') {
    return;
  }

  // Initialize if not loaded yet
  if (trackedUsers.size === 0 && !isSaving) {
    await loadUsers();
  }

  const wasNew = !trackedUsers.has(userId);
  trackedUsers.add(userId);

  // Only save if this was a new user (avoid unnecessary writes)
  if (wasNew) {
    // Save asynchronously without blocking
    saveUsers().catch(err => {
      console.error(`Failed to save tracked users: ${err.message}`);
    });
  }
}

/**
 * Get count of unique users who have used the bot
 * @returns {Promise<number>} Number of unique users
 */
export async function getUniqueUserCount() {
  // Ensure users are loaded
  if (trackedUsers.size === 0) {
    await loadUsers();
  }

  return trackedUsers.size;
}

/**
 * Initialize user tracking (load existing users)
 * @returns {Promise<void>}
 */
export async function initializeUserTracking() {
  await loadUsers();
}

/**
 * Track a recent conversion for a user
 * @param {string} userId - Discord user ID
 * @param {string} url - GIF URL
 * @returns {void}
 */
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
