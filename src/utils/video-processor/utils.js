import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

/**
 * Validate numeric parameter to prevent command injection
 * @param {*} value - Value to validate
 * @param {string} name - Parameter name for error messages
 * @param {number} min - Minimum allowed value
 * @param {number} max - Maximum allowed value
 * @param {boolean} allowNull - Whether null is allowed
 * @returns {number|null} Validated number or null
 * @throws {Error} If validation fails
 */
export function validateNumericParameter(value, name, min = 0, max = Infinity, allowNull = false) {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    throw new Error(`${name} cannot be null or undefined`);
  }

  const num = Number(value);

  if (isNaN(num) || !isFinite(num)) {
    throw new Error(`${name} must be a valid number`);
  }

  if (num < min) {
    throw new Error(`${name} must be at least ${min}`);
  }

  if (num > max) {
    throw new Error(`${name} must be at most ${max}`);
  }

  return num;
}

/**
 * Check if FFmpeg is installed and available
 * @returns {Promise<boolean>} True if FFmpeg is available
 */
export async function checkFFmpegInstalled() {
  try {
    await execAsync('ffmpeg -version');
    return true;
  } catch {
    return false;
  }
}

/**
 * Sanitize FFmpeg stderr output before logging to prevent binary data in database
 * FFmpeg stderr can contain binary fragments when processing corrupted media files
 * @param {string} stderr - Raw stderr output from FFmpeg
 * @param {number} maxLength - Maximum length of sanitized output (default: 2000)
 * @returns {string} Sanitized stderr safe for logging
 */
export function sanitizeFFmpegStderr(stderr, maxLength = 2000) {
  if (!stderr || typeof stderr !== 'string') {
    return '[no stderr output]';
  }

  // Keep only printable ASCII characters (0x20-0x7E) and common whitespace
  // This removes binary data and non-ASCII characters that FFmpeg may output
  const sanitized = stderr
    .replace(/[^\x20-\x7E\n\r\t]/g, '') // Remove non-printable/binary chars
    .replace(/\r\n/g, '\n') // Normalize line endings
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n') // Collapse multiple newlines
    .replace(/\n/g, ' | ') // Replace newlines with separator for single-line logging
    .replace(/\s{2,}/g, ' ') // Collapse multiple spaces
    .trim();

  if (!sanitized) {
    return '[stderr contained only binary/non-printable data]';
  }

  // Truncate if too long
  if (sanitized.length > maxLength) {
    return sanitized.substring(0, maxLength) + '... [truncated]';
  }

  return sanitized;
}
