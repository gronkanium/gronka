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
  const lastUse = rateLimit.get(userId);
  const now = Date.now();

  // Check if user would be rate limited
  const wouldBeRateLimited = lastUse && now - lastUse < RATE_LIMIT_COOLDOWN;

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
