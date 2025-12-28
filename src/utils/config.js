import dotenv from 'dotenv';
import fs from 'fs';
import { ConfigurationError } from './errors.js';

// Load environment variables
dotenv.config();

/**
 * Check if we're running inside a Docker container
 * @returns {boolean} True if running in Docker
 */
function isRunningInDocker() {
  try {
    if (fs.existsSync('/.dockerenv')) {
      return true;
    }
    try {
      const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
      return cgroup.includes('docker') || cgroup.includes('kubepods');
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * Determine the environment prefix for env vars (PROD_, TEST_, or empty)
 * Priority:
 * 1. Explicit ENV_PREFIX if set
 * 2. PROD_ if running in Docker or NODE_ENV=production
 * 3. TEST_ if NODE_ENV=test
 * 4. Empty string (no prefix) as fallback
 * @returns {string} Environment prefix
 */
function getEnvPrefix() {
  // Allow explicit override
  if (process.env.ENV_PREFIX) {
    const prefix = process.env.ENV_PREFIX.toUpperCase();
    return prefix.endsWith('_') ? prefix : `${prefix}_`;
  }

  // Docker or production mode -> PROD_
  if (isRunningInDocker() || process.env.NODE_ENV === 'production') {
    return 'PROD_';
  }

  // Test mode -> TEST_
  if (process.env.NODE_ENV === 'test') {
    return 'TEST_';
  }

  // Default: no prefix (for backwards compatibility)
  return '';
}

/**
 * Get environment variable with prefix support
 * Tries prefixed version first, then falls back to non-prefixed
 * @param {string} name - Base environment variable name (without prefix)
 * @returns {string|undefined} Environment variable value
 */
function getEnvWithPrefix(name) {
  const prefix = getEnvPrefix();
  // Try prefixed version first
  if (prefix && process.env[`${prefix}${name}`]) {
    return process.env[`${prefix}${name}`];
  }
  // Fall back to non-prefixed
  return process.env[name];
}

/**
 * Validate and parse integer environment variable
 * @param {string} name - Environment variable name
 * @param {number} defaultValue - Default value if not set
 * @param {number} min - Minimum allowed value
 * @param {number} max - Maximum allowed value
 * @returns {number} Parsed integer value
 */
function parseIntEnv(name, defaultValue, min = -Infinity, max = Infinity) {
  const value = process.env[name];
  if (!value) {
    return defaultValue;
  }

  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || !isFinite(parsed)) {
    throw new ConfigurationError(
      `${name} must be a valid integer, got: ${value}`,
      'INVALID_INTEGER'
    );
  }

  if (parsed < min) {
    throw new ConfigurationError(
      `${name} must be at least ${min}, got: ${parsed}`,
      'VALUE_TOO_LOW'
    );
  }

  if (parsed > max) {
    throw new ConfigurationError(
      `${name} must be at most ${max}, got: ${parsed}`,
      'VALUE_TOO_HIGH'
    );
  }

  return parsed;
}

/**
 * Get optional string environment variable with default
 * @param {string} name - Environment variable name
 * @param {string} defaultValue - Default value if not set
 * @returns {string} Environment variable value or default
 */
function getStringEnv(name, defaultValue) {
  const value = process.env[name];
  return value ? value.trim() : defaultValue;
}

/**
 * Parse comma-separated list of IDs from environment variable
 * @param {string} name - Environment variable name
 * @returns {string[]} Array of trimmed IDs
 */
function parseIdList(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    return [];
  }
  return value
    .split(',')
    .map(id => id.trim())
    .filter(id => id.length > 0);
}

/**
 * Validate URL format
 * @param {string} url - URL to validate
 * @returns {boolean} True if URL is valid
 */
function validateUrlFormat(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get and validate GIF quality from environment variable
 * @param {string} name - Environment variable name
 * @param {string} defaultValue - Default value if not set
 * @returns {string} Valid quality value: 'low', 'medium', or 'high'
 */
function getGifQualityEnv(name, defaultValue) {
  const value = process.env[name];
  if (!value) {
    return defaultValue;
  }

  const trimmed = value.trim().toLowerCase();
  const validQualities = ['low', 'medium', 'high'];
  if (!validQualities.includes(trimmed)) {
    throw new ConfigurationError(
      `${name} must be one of: ${validQualities.join(', ')}, got: ${value}`,
      'INVALID_GIF_QUALITY'
    );
  }
  return trimmed;
}

// Bot configuration - lazy loaded to avoid requiring DISCORD_TOKEN for webui
let _botConfig = null;
function getBotConfig() {
  if (_botConfig) return _botConfig;

  // Get environment prefix for logging
  const prefix = getEnvPrefix();
  const tokenVar = prefix ? `${prefix}DISCORD_TOKEN` : 'DISCORD_TOKEN';
  const clientVar = prefix ? `${prefix}CLIENT_ID` : 'CLIENT_ID';

  // Get Discord credentials with prefix support
  const discordToken = getEnvWithPrefix('DISCORD_TOKEN');
  const clientId = getEnvWithPrefix('CLIENT_ID');

  if (!discordToken || discordToken.trim() === '') {
    throw new ConfigurationError(
      `${tokenVar} is required: Discord bot token from https://discord.com/developers/applications`,
      'MISSING_REQUIRED_VAR'
    );
  }

  if (!clientId || clientId.trim() === '') {
    throw new ConfigurationError(
      `${clientVar} is required: Discord application/client ID`,
      'MISSING_REQUIRED_VAR'
    );
  }

  if (prefix) {
    console.log(
      `[Config] Using ${prefix} environment prefix (detected: ${isRunningInDocker() ? 'Docker' : process.env.NODE_ENV || 'default'})`
    );
  }

  _botConfig = {
    discordToken: discordToken.trim(),
    clientId: clientId.trim(),
    adminUserIds: parseIdList('ADMIN_USER_IDS'),
    gifStoragePath: getStringEnv('GIF_STORAGE_PATH', './data-test/gifs'),
    cdnBaseUrl: getStringEnv('CDN_BASE_URL', 'https://cdn.gronka.p1x.dev/gifs'),
    maxGifDuration: parseIntEnv('MAX_GIF_DURATION', 30, 1, 300),
    gifQuality: getGifQualityEnv('GIF_QUALITY', 'medium'),
    maxVideoSize: parseIntEnv('MAX_VIDEO_SIZE', 100 * 1024 * 1024, 1), // 100MB default, configurable via MAX_VIDEO_SIZE env var
    maxImageSize: parseIntEnv('MAX_IMAGE_SIZE', 50 * 1024 * 1024, 1), // 50MB default, configurable via MAX_IMAGE_SIZE env var
    rateLimitCooldown: parseIntEnv('RATE_LIMIT', 10, 1) * 1000, // Default 10 seconds, configurable via RATE_LIMIT env var (in seconds)
    cobaltApiUrl: getStringEnv('COBALT_API_URL', 'http://cobalt:9000'),
    cobaltEnabled: getStringEnv('COBALT_ENABLED', 'true').toLowerCase() === 'true',
    ytdlpEnabled: getStringEnv('YTDLP_ENABLED', 'true').toLowerCase() === 'true',
    ytdlpQuality: getStringEnv(
      'YTDLP_QUALITY',
      'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]'
    ),
    statsCacheTtl: parseIntEnv('STATS_CACHE_TTL', 300000, 0), // 5 minutes default, 0 to disable
    ntfyTopic: getStringEnv('NTFY_TOPIC', ''),
    ntfyEnabled: getStringEnv('NTFY_TOPIC', '') !== '',
    discordSizeLimit: parseIntEnv('DISCORD_SIZE_LIMIT', 8 * 1024 * 1024, 1), // 8MB default, Discord's attachment limit
  };

  // Validate CDN_BASE_URL format
  if (!validateUrlFormat(_botConfig.cdnBaseUrl)) {
    throw new ConfigurationError(
      `CDN_BASE_URL must be a valid URL, got: ${_botConfig.cdnBaseUrl}`,
      'INVALID_URL'
    );
  }

  return _botConfig;
}

// Export as getter property for backward compatibility
export const botConfig = new Proxy(
  {},
  {
    get(target, prop) {
      return getBotConfig()[prop];
    },
    ownKeys() {
      return Object.keys(getBotConfig());
    },
    getOwnPropertyDescriptor() {
      return { enumerable: true, configurable: true };
    },
  }
);

// R2 configuration
export const r2Config = {
  accountId: getStringEnv('R2_ACCOUNT_ID', ''),
  accessKeyId: getStringEnv('R2_ACCESS_KEY_ID', ''),
  secretAccessKey: getStringEnv('R2_SECRET_ACCESS_KEY', ''),
  bucketName: getStringEnv('R2_BUCKET_NAME', ''),
  publicDomain: getStringEnv('R2_PUBLIC_DOMAIN', 'cdn.gronka.p1x.dev'),
  tempUploadsEnabled: getStringEnv('R2_TEMP_UPLOADS_ENABLED', 'false').toLowerCase() === 'true',
  tempUploadTtlHours: parseIntEnv('R2_TEMP_UPLOAD_TTL_HOURS', 72, 1, 8760), // Max 1 year
  cleanupEnabled: getStringEnv('R2_CLEANUP_ENABLED', 'false').toLowerCase() === 'true',
  cleanupIntervalMs: parseIntEnv('R2_CLEANUP_INTERVAL_MS', 3600000, 60000, 86400000), // 1 hour default, min 1 minute, max 1 day
  cleanupLogLevel: getStringEnv('R2_CLEANUP_LOG_LEVEL', 'detailed').toLowerCase(),
};

// Server configuration (minimal - only for stats HTTP endpoint in bot)
// Note: The main server.js has been removed. These settings are now used by the
// minimal HTTP server in bot.js that serves /api/stats/24h for Jekyll integration.
export const serverConfig = {
  serverPort: parseIntEnv('SERVER_PORT', 3000, 1, 65535),
  serverHost: getStringEnv('SERVER_HOST', '0.0.0.0'),
  statsUsername: getStringEnv('STATS_USERNAME', null),
  statsPassword: getStringEnv('STATS_PASSWORD', null),
};

// WebUI configuration
// Note: MAIN_SERVER_URL has been removed - WebUI now calculates stats directly
export const webuiConfig = {
  webuiPort: parseIntEnv('WEBUI_PORT', 3001, 1, 65535),
  webuiHost: getStringEnv('WEBUI_HOST', '127.0.0.1'),
};

// Logger configuration
export const loggerConfig = {
  logDir: getStringEnv('LOG_DIR', './logs'),
  logLevel: getStringEnv('LOG_LEVEL', 'INFO').toUpperCase(),
  logRotation: getStringEnv('LOG_ROTATION', 'daily'),
};

// Validate log level
const validLogLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
if (!validLogLevels.includes(loggerConfig.logLevel)) {
  throw new ConfigurationError(
    `LOG_LEVEL must be one of: ${validLogLevels.join(', ')}, got: ${loggerConfig.logLevel}`,
    'INVALID_LOG_LEVEL'
  );
}

// Validate log rotation
const validRotations = ['daily', 'none'];
if (!validRotations.includes(loggerConfig.logRotation)) {
  throw new ConfigurationError(
    `LOG_ROTATION must be one of: ${validRotations.join(', ')}, got: ${loggerConfig.logRotation}`,
    'INVALID_LOG_ROTATION'
  );
}

// Validate R2 cleanup log level
const validCleanupLogLevels = ['minimal', 'detailed', 'debug'];
if (!validCleanupLogLevels.includes(r2Config.cleanupLogLevel)) {
  throw new ConfigurationError(
    `R2_CLEANUP_LOG_LEVEL must be one of: ${validCleanupLogLevels.join(', ')}, got: ${r2Config.cleanupLogLevel}`,
    'INVALID_CLEANUP_LOG_LEVEL'
  );
}

// Export all config as a single object for convenience
export const config = {
  get bot() {
    return getBotConfig();
  },
  server: serverConfig,
  webui: webuiConfig,
  logger: loggerConfig,
  r2: r2Config,
};
