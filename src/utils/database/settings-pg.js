import { getPostgresConnection } from './connection.js';
import { ensurePostgresInitialized } from './init.js';

// Short-lived cache so per-command reads don't hit the database every time,
// while webui changes still propagate to the bot process within seconds
const settingsCache = new Map(); // Map<key, {value, timestamp}>
const SETTINGS_CACHE_TTL = 10 * 1000; // 10 seconds

/**
 * Invalidate settings cache
 * @param {string|null} key - Setting key to invalidate (or null to clear all)
 */
export function invalidateSettingsCache(key = null) {
  if (key) {
    settingsCache.delete(key);
  } else {
    settingsCache.clear();
  }
}

/**
 * Get a bot setting value
 * @param {string} key - Setting key
 * @param {string|null} defaultValue - Value to return if the setting is not set
 * @returns {Promise<string|null>} Setting value or defaultValue
 */
export async function getSetting(key, defaultValue = null) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return defaultValue;
  }

  const cached = settingsCache.get(key);
  if (cached && Date.now() - cached.timestamp < SETTINGS_CACHE_TTL) {
    return cached.value ?? defaultValue;
  }

  const result = await sql`SELECT value FROM bot_settings WHERE key = ${key}`;
  const value = result.length > 0 ? result[0].value : null;

  settingsCache.set(key, { value, timestamp: Date.now() });

  return value ?? defaultValue;
}

/**
 * Get a boolean bot setting
 * @param {string} key - Setting key
 * @param {boolean} defaultValue - Value to return if the setting is not set
 * @returns {Promise<boolean>} Setting value as boolean
 */
export async function getBooleanSetting(key, defaultValue = false) {
  const value = await getSetting(key, null);
  if (value === null) {
    return defaultValue;
  }
  return value === 'true';
}

/**
 * Set a bot setting value (upsert)
 * @param {string} key - Setting key
 * @param {string|boolean|number} value - Setting value (stored as text)
 * @returns {Promise<void>}
 */
export async function setSetting(key, value) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return;
  }

  const textValue = String(value);
  const now = Date.now();

  await sql`
    INSERT INTO bot_settings (key, value, updated_at)
    VALUES (${key}, ${textValue}, ${now})
    ON CONFLICT (key) DO UPDATE SET value = ${textValue}, updated_at = ${now}
  `;

  invalidateSettingsCache(key);
}

/**
 * Get all bot settings
 * @returns {Promise<Object>} Map of key -> value
 */
export async function getAllSettings() {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return {};
  }

  const result = await sql`SELECT key, value FROM bot_settings`;
  const settings = {};
  for (const row of result) {
    settings[row.key] = row.value;
  }
  return settings;
}
