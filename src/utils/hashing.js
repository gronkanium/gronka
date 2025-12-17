import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export const HASH_ALGORITHM = 'blake3';

/**
 * Hash arbitrary bytes to lowercase hex.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function hashBytesHex(bytes) {
  return bytesToHex(blake3(bytes));
}

/**
 * Hash a UTF-8 string to lowercase hex.
 * @param {string} value
 * @returns {string}
 */
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
