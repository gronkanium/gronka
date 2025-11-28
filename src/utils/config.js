import dotenv from 'dotenv';
import { ConfigurationError } from './errors.js';

// Load environment variables
dotenv.config();

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
 * Validate required string environment variable
 * @param {string} name - Environment variable name
 * @param {string} description - Description for error message
 * @returns {string} Environment variable value
 * @throws {ConfigurationError} If variable is not set
 */
function requireStringEnv(name, description) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new ConfigurationError(`${name} is required: ${description}`, 'MISSING_REQUIRED_VAR');
  }
  return value.trim();
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
 * Get CORS origin from CDN_BASE_URL or explicit CORS_ORIGIN
 * @returns {string} CORS origin value
 */
function getCorsOrigin() {
  const explicitOrigin = process.env.CORS_ORIGIN;
  if (explicitOrigin) {
    return explicitOrigin.trim();
  }

  const cdnBaseUrl = getStringEnv('CDN_BASE_URL', 'https://cdn.gronka.p1x.dev/gifs');
  try {
    const url = new URL(cdnBaseUrl);
    // If localhost, allow all origins
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return '*';
    }
    // Extract origin (protocol + hostname + port if not default)
    const origin = `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
    return origin;
  } catch {
    // If URL parsing fails, default to '*' for safety
    return '*';
  }
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

  _botConfig = {
    discordToken: requireStringEnv(
      'DISCORD_TOKEN',
      'Discord bot token from https://discord.com/developers/applications'
    ),
    clientId: requireStringEnv('CLIENT_ID', 'Discord application/client ID'),
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
    statsCacheTtl: parseIntEnv('STATS_CACHE_TTL', 300000, 0), // 5 minutes default, 0 to disable
    ntfyTopic: getStringEnv('NTFY_TOPIC', ''),
    ntfyEnabled: getStringEnv('NTFY_TOPIC', '') !== '',
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
};

// Server configuration
// Note: serverConfig.gifStoragePath defaults to './data-test' (base path without 'gifs' subdirectory)
// while botConfig.gifStoragePath defaults to './data-test/gifs' (includes 'gifs' subdirectory).
// This difference is intentional - the server uses a base path that getGifPath() will append 'gifs' to,
// while the bot uses a path that already includes 'gifs'. The getGifPath() function handles both cases.
// Both default to 'data-test' to prevent accidental writes to production data.
export const serverConfig = {
  gifStoragePath: getStringEnv('GIF_STORAGE_PATH', './data-test'),
  serverPort: parseIntEnv('SERVER_PORT', 3000, 1, 65535),
  serverHost: getStringEnv('SERVER_HOST', '0.0.0.0'),
  statsUsername: getStringEnv('STATS_USERNAME', null),
  statsPassword: getStringEnv('STATS_PASSWORD', null),
  corsOrigin: getCorsOrigin(),
  cdnBaseUrl: getStringEnv('CDN_BASE_URL', 'https://cdn.gronka.p1x.dev/gifs'),
};

// Validate CDN_BASE_URL format for server
if (!validateUrlFormat(serverConfig.cdnBaseUrl)) {
  throw new ConfigurationError(
    `CDN_BASE_URL must be a valid URL, got: ${serverConfig.cdnBaseUrl}`,
    'INVALID_URL'
  );
}

// WebUI configuration
export const webuiConfig = {
  webuiPort: parseIntEnv('WEBUI_PORT', 3001, 1, 65535),
  webuiHost: getStringEnv('WEBUI_HOST', '127.0.0.1'),
  mainServerUrl: getStringEnv('MAIN_SERVER_URL', 'http://localhost:3000'),
};

// Validate MAIN_SERVER_URL format
if (!validateUrlFormat(webuiConfig.mainServerUrl)) {
  throw new ConfigurationError(
    `MAIN_SERVER_URL must be a valid URL, got: ${webuiConfig.mainServerUrl}`,
    'INVALID_URL'
  );
}

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
