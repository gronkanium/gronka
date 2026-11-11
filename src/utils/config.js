import dotenv from 'dotenv';
import { ConfigurationError } from './errors.js';

dotenv.config({ quiet: true });

// Height, then width cap (`height<=?1080` alone drops every portrait video); bare `best` means a filter never fails a download.
export const DEFAULT_YTDLP_FORMAT =
  'bestvideo[height<=?1080][ext=mp4]+bestaudio[ext=m4a]/' +
  'bestvideo[width<=?1080][ext=mp4]+bestaudio[ext=m4a]/' +
  'best[height<=?1080][ext=mp4]/best[width<=?1080][ext=mp4]/' +
  'bestvideo[height<=?1080]+bestaudio/best';

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

function requireStringEnv(name, description) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new ConfigurationError(`${name} is required: ${description}`, 'MISSING_REQUIRED_VAR');
  }
  return value.trim();
}

function getStringEnv(name, defaultValue) {
  const value = process.env[name];
  return value ? value.trim() : defaultValue;
}

function validateUrlFormat(url) {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

let _botConfig = null;
function getBotConfig() {
  if (_botConfig) return _botConfig;

  // gronka-web shares the download settings below but never talks to Discord.
  const web = process.env.GRONKA_WEB === 'true';
  _botConfig = {
    discordToken: web
      ? ''
      : requireStringEnv(
          'DISCORD_TOKEN',
          'Discord bot token from https://discord.com/developers/applications'
        ),
    clientId: web ? '' : requireStringEnv('CLIENT_ID', 'Discord application/client ID'),
    // On by default, and at least a day so a typo cannot wipe live history.
    retentionEnabled: getStringEnv('RETENTION_ENABLED', 'true').toLowerCase() === 'true',
    retentionDays: parseIntEnv('RETENTION_DAYS', 7, 1, 3650),
    retentionIntervalMs: parseIntEnv('RETENTION_INTERVAL_MS', 21600000, 60000, 604800000),
    // Default for the webui's max size; read it through size-limit.js, never directly.
    maxVideoSize: parseIntEnv('MAX_VIDEO_SIZE', 1024 * 1024 * 1024, 1),
    cobaltApiUrl: getStringEnv('COBALT_API_URL', 'http://cobalt:9000'),
    cobaltEnabled: getStringEnv('COBALT_ENABLED', 'true').toLowerCase() === 'true',
    ytdlpEnabled: getStringEnv('YTDLP_ENABLED', 'true').toLowerCase() === 'true',
    ytdlpQuality: getStringEnv('YTDLP_QUALITY', DEFAULT_YTDLP_FORMAT),
    galleryDlEnabled: getStringEnv('GALLERY_DL_ENABLED', 'true').toLowerCase() === 'true',
    // Off for a bare bot process, which has no workers; docker-compose.yml turns it on.
    mediaWorkers: getStringEnv('MEDIA_WORKERS', 'false').toLowerCase() === 'true',
    statsCacheTtl: parseIntEnv('STATS_CACHE_TTL', 300000, 0),
  };

  return _botConfig;
}

// Lazy, so a module can import this without DISCORD_TOKEN until it reads a property.
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

// Empty by default: a self-hosted bot must not send its users to the upstream server.
export const supportConfig = {
  get inviteUrl() {
    return getStringEnv('SUPPORT_INVITE_URL', '');
  },
};

if (supportConfig.inviteUrl && !validateUrlFormat(supportConfig.inviteUrl)) {
  throw new ConfigurationError(
    `SUPPORT_INVITE_URL must be a valid URL, got: ${supportConfig.inviteUrl}`,
    'INVALID_URL'
  );
}

export const r2Config = {
  accountId: getStringEnv('R2_ACCOUNT_ID', ''),
  accessKeyId: getStringEnv('R2_ACCESS_KEY_ID', ''),
  secretAccessKey: getStringEnv('R2_SECRET_ACCESS_KEY', ''),
  bucketName: getStringEnv('R2_BUCKET_NAME', ''),
  // No default: an unset domain must not mint links on a CDN this deployment doesn't own.
  publicDomain: getStringEnv('R2_PUBLIC_DOMAIN', ''),
  cleanupEnabled: getStringEnv('R2_CLEANUP_ENABLED', 'false').toLowerCase() === 'true',
  cleanupIntervalMs: parseIntEnv('R2_CLEANUP_INTERVAL_MS', 3600000, 60000, 86400000),
};

export const serverConfig = {
  serverPort: parseIntEnv('SERVER_PORT', 3000, 1, 65535),
  serverHost: getStringEnv('SERVER_HOST', '0.0.0.0'),
};

export const webuiConfig = {
  webuiPort: parseIntEnv('WEBUI_PORT', 3001, 1, 65535),
  webuiHost: getStringEnv('WEBUI_HOST', '127.0.0.1'),
};
