import { createHash } from 'crypto';

// Native only: pure-JS hashing of a 500MB video allocated ~1GB of garbage and OOM-killed the bot.
export function hashBytesHex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function hashStringHex(value) {
  return hashBytesHex(Buffer.from(String(value), 'utf8'));
}

// Hash multiple parts (strings/bytes) in-order to lowercase hex
export function hashPartsHex(parts) {
  const hasher = createHash('sha256');
  for (const part of parts) {
    if (part === null || part === undefined) continue;
    if (typeof part === 'string') {
      hasher.update(Buffer.from(part, 'utf8'));
    } else {
      hasher.update(part);
    }
  }
  return hasher.digest('hex');
}

export function hashUrl(url) {
  return hashStringHex(url);
}

// Only explicitly given options take part in the cache key, so unset and default hash the same
function normalizeConversionOptions(options) {
  if (!options || typeof options !== 'object') {
    return {};
  }

  const normalized = {};

  // Only include explicitly provided parameters (non-undefined, non-null)
  // Parameters that affect output quality/size:
  if (options.optimize !== undefined && options.optimize !== null) {
    normalized.optimize = Boolean(options.optimize);
  }
  if (options.lossy !== undefined && options.lossy !== null) {
    normalized.lossy = Number(options.lossy);
  }
  if (options.startTime !== undefined && options.startTime !== null) {
    normalized.startTime = Number(options.startTime);
  }
  if (options.duration !== undefined && options.duration !== null) {
    normalized.duration = Number(options.duration);
  }
  if (options.width !== undefined && options.width !== null) {
    normalized.width = Number(options.width);
  }
  if (options.fps !== undefined && options.fps !== null) {
    normalized.fps = Number(options.fps);
  }

  return normalized;
}

// Cache key for a URL plus the conversion options that change the output
export function hashUrlWithParams(url, options = {}) {
  const normalized = normalizeConversionOptions(options);

  // If no parameters provided, use URL-only hash for backward compatibility
  if (Object.keys(normalized).length === 0) {
    return hashUrl(url);
  }

  // Sort parameter keys for consistent hashing regardless of object key order
  const sortedKeys = Object.keys(normalized).sort();
  const paramsString = sortedKeys.map(key => `${key}:${normalized[key]}`).join('|');

  // Create composite hash: URL + parameters
  const compositeString = `${url}|${paramsString}`;
  return hashStringHex(compositeString);
}
