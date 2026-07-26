import { createLogger } from './logger.js';
import { botConfig } from './config.js';
import { getSetting } from './database.js';

const logger = createLogger('rate-limit');

const { adminUserIds: ADMIN_USER_IDS, rateLimitCooldown: RATE_LIMIT_COOLDOWN } = botConfig;

// Rate limiting: userId -> last use timestamp
const rateLimit = new Map();

// Webui-managed values cached in memory so isAdmin()/checkRateLimit() stay
// synchronous: admin_user_ids (merged with the ADMIN_USER_IDS env list) and
// rate_limit_cooldown (falls back to the RATE_LIMIT env default when unset).
// bot.js refreshes the cache on an interval, so webui changes take up to a
// minute to apply in the bot process.
let dbAdminIds = new Set();
let cooldownMs = RATE_LIMIT_COOLDOWN;

/**
 * Reload the webui-managed admin list and rate-limit cooldown from the database
 * into the cache. Keeps the previous values on failure so a DB hiccup can't
 * demote admins or change limits.
 */
export async function refreshRateLimitSettings() {
  try {
    const raw = await getSetting('admin_user_ids', '[]');
    const parsed = JSON.parse(raw);
    dbAdminIds = new Set(Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : []);
  } catch (error) {
    logger.warn(`Failed to refresh admin cache: ${error.message}`);
  }
  try {
    const cooldownRaw = await getSetting('rate_limit_cooldown', null);
    const seconds = parseInt(cooldownRaw, 10);
    cooldownMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : RATE_LIMIT_COOLDOWN;
  } catch (error) {
    logger.warn(`Failed to refresh rate limit cooldown: ${error.message}`);
  }
}

export function isAdmin(userId) {
  return ADMIN_USER_IDS.includes(userId) || dbAdminIds.has(userId);
}

export function checkRateLimit(userId) {
  const lastUse = rateLimit.get(userId);
  const now = Date.now();

  // Check if user would be rate limited
  const wouldBeRateLimited = lastUse && now - lastUse < cooldownMs;

  // Admins bypass rate limiting
  if (isAdmin(userId)) {
    // Only log if there was an actual rate limit to bypass
    if (wouldBeRateLimited) {
      logger.info(`Rate limit bypassed for admin user ${userId}`);
    }
    return false;
  }

  // If user was recently rate limited, return true
  if (wouldBeRateLimited) {
    return true;
  }

  // User is not rate limited - return false
  // Note: Rate limit is only recorded on successful operations via recordRateLimit()
  return false;
}

export function recordRateLimit(userId) {
  // Admins bypass rate limiting, so don't record for them
  if (isAdmin(userId)) {
    return;
  }

  rateLimit.set(userId, Date.now());
}
