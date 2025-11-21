import { createLogger } from './logger.js';
import { botConfig } from './config.js';

const logger = createLogger('rate-limit');

const { adminUserIds: ADMIN_USER_IDS, rateLimitCooldown: RATE_LIMIT_COOLDOWN } = botConfig;

// Rate limiting: userId -> last use timestamp
const rateLimit = new Map();

/**
 * Check if user is an admin
 * @param {string} userId - Discord user ID
 * @returns {boolean} True if user is admin
 */
export function isAdmin(userId) {
  return ADMIN_USER_IDS.includes(userId);
}

/**
 * Check if user is rate limited
 * @param {string} userId - Discord user ID
 * @returns {boolean} True if user should wait
 */
export function checkRateLimit(userId) {
  // Admins bypass rate limiting
  if (isAdmin(userId)) {
    logger.info(`Rate limit bypassed for admin user ${userId}`);
    return false;
  }

  const lastUse = rateLimit.get(userId);
  const now = Date.now();

  // If user was recently rate limited, return true
  if (lastUse && now - lastUse < RATE_LIMIT_COOLDOWN) {
    return true;
  }

  // Record this check as the new last use timestamp
  rateLimit.set(userId, now);
  return false;
}

/**
 * Record that a user has successfully completed an operation (for rate limiting)
 * @param {string} userId - Discord user ID
 */
export function recordRateLimit(userId) {
  // Admins bypass rate limiting, so don't record for them
  if (isAdmin(userId)) {
    return;
  }

  rateLimit.set(userId, Date.now());
}
