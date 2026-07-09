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
 * Detect an animated WebP from its header bytes.
 * WebP is a RIFF container; only the extended "VP8X" form can be animated, and
 * the animation flag is bit 0x02 of the VP8X flags byte at offset 20. Static
 * WebP (VP8/VP8L) and animated WebP share the same `image/webp` MIME type, so
 * this byte sniff is the only reliable way to tell them apart for routing.
 * @param {Buffer} buffer - File contents (only the first 21 bytes are read)
 * @returns {boolean} True if the buffer is an animated WebP
 */
export function isAnimatedWebp(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 21) return false;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return false;
  if (buffer.toString('ascii', 8, 12) !== 'WEBP') return false;
  if (buffer.toString('ascii', 12, 16) !== 'VP8X') return false;
  return (buffer[20] & 0x02) !== 0;
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
