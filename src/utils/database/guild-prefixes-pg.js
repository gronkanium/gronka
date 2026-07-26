import { getPostgresConnection } from './connection.js';
import { ensurePostgresInitialized } from './init.js';

// Per-guild prefix cache. The bot process is the only writer (webui doesn't touch
// guild prefixes), and setGuildPrefix/clearGuildPrefix invalidate in-process, so a
// longer TTL than settings is safe. This runs on the messageCreate hot path - the
// cache is what keeps it from being a query per message.
const prefixCache = new Map(); // Map<guildId, {value, timestamp}>
const PREFIX_CACHE_TTL = 60 * 1000; // 60 seconds

/**
 * Invalidate the guild prefix cache
 * @param {string|null} guildId - Guild to invalidate (or null to clear all)
 */
export function invalidateGuildPrefixCache(guildId = null) {
  if (guildId) {
    prefixCache.delete(guildId);
  } else {
    prefixCache.clear();
  }
}

/**
 * Get a guild's custom command prefix
 * @param {string} guildId - Discord guild ID
 * @returns {Promise<string|null>} Custom prefix, or null when the guild uses the default
 */
export async function getGuildPrefix(guildId) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return null;
  }

  const cached = prefixCache.get(guildId);
  if (cached && Date.now() - cached.timestamp < PREFIX_CACHE_TTL) {
    return cached.value;
  }

  const result = await sql`SELECT prefix FROM guild_prefixes WHERE guild_id = ${guildId}`;
  const value = result.length > 0 ? result[0].prefix : null;

  prefixCache.set(guildId, { value, timestamp: Date.now() });

  return value;
}

export async function setGuildPrefix(guildId, prefix) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return;
  }

  const now = Date.now();

  await sql`
    INSERT INTO guild_prefixes (guild_id, prefix, updated_at)
    VALUES (${guildId}, ${prefix}, ${now})
    ON CONFLICT (guild_id) DO UPDATE SET prefix = ${prefix}, updated_at = ${now}
  `;

  invalidateGuildPrefixCache(guildId);
}

export async function clearGuildPrefix(guildId) {
  await ensurePostgresInitialized();

  const sql = getPostgresConnection();
  if (!sql) {
    console.error('PostgreSQL not initialized. Call initPostgresDatabase() first.');
    return;
  }

  await sql`DELETE FROM guild_prefixes WHERE guild_id = ${guildId}`;

  invalidateGuildPrefixCache(guildId);
}
