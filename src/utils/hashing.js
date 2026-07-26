import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export function hashBytesHex(bytes) {
  return bytesToHex(blake3(bytes));
}

export function hashStringHex(value) {
  return hashBytesHex(Buffer.from(String(value), 'utf8'));
}

/**
 * Hash multiple parts (strings/bytes) in-order to lowercase hex.
 * This avoids concatenating large buffers.
 * @param {Array<string|Uint8Array|null|undefined>} parts
 * @returns {string}
 */
export function hashPartsHex(parts) {
  const hasher = blake3.create();
  for (const part of parts) {
    if (part === null || part === undefined) continue;
    if (typeof part === 'string') {
      hasher.update(Buffer.from(part, 'utf8'));
    } else {
      hasher.update(part);
    }
  }
  return bytesToHex(hasher.digest());
}

export function hashUrl(url) {
  return hashStringHex(url);
}

/**
 * Normalize conversion options to include only explicitly provided parameters
 * Filters out undefined and null values for consistent hashing
 * @param {Object} options - Conversion options object
 * @returns {Object} Normalized options object with only explicitly provided parameters
 */
function normalizeConversionOptions(options) {
  if (!options || typeof options !== 'object') {
    return {};
  }

  const normalized = {};

  // Only include explicitly provided parameters (non-undefined, non-null)
  // Parameters that affect output quality/size:
  if (options.quality !== undefined && options.quality !== null) {
    normalized.quality = String(options.quality);
  }
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

/**
 * Generate composite hash for URL with conversion parameters
 * Creates a cache key that includes both URL and explicitly provided conversion parameters
 * @param {string} url - URL to hash
 * @param {Object} [options] - Conversion options object (quality, optimize, lossy, startTime, duration, width, fps)
 * @returns {string} Composite hash combining URL and parameters
 */
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
