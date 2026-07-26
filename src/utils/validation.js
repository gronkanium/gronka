import path from 'path';
import net from 'net';

export const LOOPBACK_ERROR = 'localhost and loopback addresses are not allowed';
export const PRIVATE_ADDRESS_ERROR = 'private and internal IP addresses are not allowed';

// Hostnames that reach the local host no matter what DNS says
const LOOPBACK_HOSTNAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback']);

/**
 * Normalize a URL hostname for comparison: lowercase, IPv6 brackets stripped, and the
 * root-zone trailing dot dropped ("localhost." is the same host as "localhost").
 * @param {string} hostname - Hostname from a parsed URL
 * @returns {{host: string, bracketed: boolean}} Normalized host and whether it was bracketed
 */
function normalizeHostname(hostname) {
  let host = hostname.toLowerCase();
  const bracketed = host.startsWith('[') && host.endsWith(']');
  if (bracketed) {
    host = host.slice(1, -1);
  }
  return { host: host.replace(/\.+$/, ''), bracketed };
}

/**
 * Parse an IPv6 literal into its eight 16-bit groups, handling `::` compression and a
 * trailing dotted-quad (`::ffff:127.0.0.1`).
 * @param {string} address - IPv6 literal, no brackets
 * @returns {number[]|null} Eight groups, or null if unparseable
 */
function ipv6Groups(address) {
  const halves = address.split('::');
  if (halves.length > 2) return null;

  const parseSide = side => {
    if (!side) return [];
    const parts = side.split(':');
    const groups = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.includes('.')) {
        // A dotted-quad is only legal as the final component
        if (i !== parts.length - 1) return null;
        const octets = part.split('.').map(Number);
        if (octets.length !== 4 || octets.some(o => !Number.isInteger(o) || o < 0 || o > 255)) {
          return null;
        }
        groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      groups.push(parseInt(part, 16));
    }
    return groups;
  };

  const left = parseSide(halves[0]);
  if (!left) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;

  const right = parseSide(halves[1]);
  if (!right) return null;
  const zeros = 8 - left.length - right.length;
  if (zeros < 0) return null;
  return [...left, ...Array(zeros).fill(0), ...right];
}

/**
 * Extract the IPv4 address embedded in a transition-mechanism IPv6 address, so the v4
 * rules below judge it: IPv4-mapped/compatible (::ffff:a.b.c.d, ::a.b.c.d), NAT64
 * (64:ff9b::/96), and 6to4 (2002::/16) all carry a reachable v4 destination.
 * @param {number[]} groups - Eight 16-bit groups
 * @returns {string|null} Dotted-quad IPv4 address, or null when none is embedded
 */
function embeddedIpv4(groups) {
  const toDotted = (high, low) =>
    `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;

  const leadingZeros = groups.slice(0, 5).every(g => g === 0);
  if (leadingZeros && groups[5] === 0xffff) return toDotted(groups[6], groups[7]);
  // ::a.b.c.d — but not :: or ::1, which are handled as loopback
  if (leadingZeros && groups[5] === 0 && (groups[6] !== 0 || groups[7] > 1)) {
    return toDotted(groups[6], groups[7]);
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b) return toDotted(groups[6], groups[7]);
  if (groups[0] === 0x2002) return toDotted(groups[1], groups[2]);
  return null;
}

/**
 * Classify an IPv4 literal.
 * @param {string} address - Dotted-quad IPv4 address
 * @returns {string|null} Error message when the address must not be reached, else null
 */
function blockedIpv4Reason(address) {
  const [a, b] = address.split('.').map(Number);

  if (a === 127) return LOOPBACK_ERROR; // 127.0.0.0/8 loopback
  if (a === 0) return LOOPBACK_ERROR; // 0.0.0.0/8 — "this host"
  if (a === 10) return PRIVATE_ADDRESS_ERROR; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return PRIVATE_ADDRESS_ERROR; // 172.16.0.0/12
  if (a === 192 && b === 168) return PRIVATE_ADDRESS_ERROR; // 192.168.0.0/16
  if (a === 169 && b === 254) return PRIVATE_ADDRESS_ERROR; // link-local + cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return PRIVATE_ADDRESS_ERROR; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0) return PRIVATE_ADDRESS_ERROR; // 192.0.0.0/24 protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return PRIVATE_ADDRESS_ERROR; // 198.18.0.0/15
  if (a >= 224) return PRIVATE_ADDRESS_ERROR; // multicast, reserved, broadcast
  return null;
}

/**
 * Classify an IPv6 literal.
 * @param {string} address - IPv6 literal, no brackets
 * @returns {string|null} Error message when the address must not be reached, else null
 */
function blockedIpv6Reason(address) {
  const groups = ipv6Groups(address);
  // net.isIP already said this is IPv6; if we cannot decompose it, refuse rather than guess
  if (!groups) return PRIVATE_ADDRESS_ERROR;

  const embedded = embeddedIpv4(groups);
  if (embedded) return blockedIpv4Reason(embedded);

  const isZeroPrefix = groups.slice(0, 7).every(g => g === 0);
  if (isZeroPrefix && groups[7] === 0) return LOOPBACK_ERROR; // :: unspecified
  if (isZeroPrefix && groups[7] === 1) return LOOPBACK_ERROR; // ::1 loopback

  if ((groups[0] & 0xfe00) === 0xfc00) return PRIVATE_ADDRESS_ERROR; // fc00::/7 unique-local
  if ((groups[0] & 0xffc0) === 0xfe80) return PRIVATE_ADDRESS_ERROR; // fe80::/10 link-local
  if ((groups[0] & 0xff00) === 0xff00) return PRIVATE_ADDRESS_ERROR; // ff00::/8 multicast
  return null;
}

/**
 * Decide whether an IP address is safe for the bot to connect to. Used both by
 * validateUrl (on the literal in the URL) and by the DNS guard in ssrf-guard.js (on
 * every address a hostname actually resolves to).
 * @param {string} address - IPv4 or IPv6 literal, no brackets
 * @returns {string|null} Error message when the address must not be reached, else null
 */
export function blockedAddressReason(address) {
  const family = net.isIP(address);
  if (family === 4) return blockedIpv4Reason(address);
  if (family === 6) return blockedIpv6Reason(address);
  return null; // not an IP literal — a hostname, resolved by the DNS guard instead
}

/**
 * Validate URL to prevent SSRF attacks.
 *
 * This is a string-level check on the URL the user handed us. It cannot see where a
 * hostname resolves or where a redirect leads, so every request built from a
 * user-supplied URL must also carry the DNS/redirect guard from ssrf-guard.js.
 * @param {string} url - URL to validate
 * @returns {Object} Validation result with error message if invalid
 */
export function validateUrl(url) {
  let urlObj;
  try {
    urlObj = new URL(url);
  } catch {
    return {
      valid: false,
      error: 'invalid URL format',
    };
  }

  // Only allow http and https protocols
  if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
    return {
      valid: false,
      error: 'only http and https protocols are allowed',
    };
  }

  const { host: hostname, bracketed } = normalizeHostname(urlObj.hostname);
  if (!hostname) {
    return {
      valid: false,
      error: 'invalid URL format',
    };
  }

  // A bracketed host must be a plain IPv6 literal. Anything else (a zone id such as
  // "[fe80::1%25eth0]") would slip past the address rules below unclassified.
  if (bracketed && net.isIP(hostname) !== 6) {
    return {
      valid: false,
      error: 'invalid URL format',
    };
  }

  // Hostnames that are loopback by definition, whatever the resolver returns
  if (LOOPBACK_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    return {
      valid: false,
      error: LOOPBACK_ERROR,
    };
  }

  const blocked = blockedAddressReason(hostname);
  if (blocked) {
    return {
      valid: false,
      error: blocked,
    };
  }

  return { valid: true };
}

/**
 * Parse a timestamp string into seconds
 * Accepts plain seconds ("90", "12.5"), MM:SS ("3:10"), and HH:MM:SS ("1:02:30").
 * Fractional seconds are allowed in the last segment ("1:02.5").
 * @param {string} input - Timestamp string to parse
 * @returns {Object} { valid: true, seconds } or { valid: false, error }
 */
export function parseTimestamp(input) {
  if (input === null || input === undefined || typeof input !== 'string') {
    return { valid: false, error: 'timestamp must be a string' };
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return { valid: false, error: 'timestamp is empty' };
  }

  const invalidFormat = {
    valid: false,
    error: `invalid timestamp "${trimmed}". use seconds (e.g. 90) or a timestamp (e.g. 1:30 or 1:02:30)`,
  };

  const parts = trimmed.split(':');
  if (parts.length > 3) {
    return invalidFormat;
  }

  // Plain seconds: "90" or "12.5"
  if (parts.length === 1) {
    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
      return invalidFormat;
    }
    return { valid: true, seconds: parseFloat(trimmed) };
  }

  // MM:SS or HH:MM:SS — every segment before the last must be whole digits,
  // the last segment may have a fractional part
  const last = parts[parts.length - 1];
  if (!/^\d{1,2}(\.\d+)?$/.test(last) || parseFloat(last) >= 60) {
    return invalidFormat;
  }

  for (let i = 0; i < parts.length - 1; i++) {
    if (!/^\d+$/.test(parts[i])) {
      return invalidFormat;
    }
    // Minutes must be under 60 when hours are present
    if (parts.length === 3 && i === 1 && parseInt(parts[i], 10) >= 60) {
      return invalidFormat;
    }
  }

  let seconds = 0;
  for (const part of parts) {
    seconds = seconds * 60 + parseFloat(part);
  }

  return { valid: true, seconds };
}

export function sanitizeFilename(filename) {
  if (!filename || typeof filename !== 'string') {
    return 'file';
  }

  // Remove path separators and dangerous characters
  // eslint-disable-next-line no-control-regex
  let sanitized = filename.replace(/[/\\\x00-\x1f\x7f-\x9f]/g, '');

  // Remove leading dots and spaces
  sanitized = sanitized.replace(/^[.\s]+/, '');

  // Limit length
  if (sanitized.length > 255) {
    const ext = path.extname(sanitized);
    sanitized = sanitized.substring(0, 255 - ext.length) + ext;
  }

  // If empty after sanitization, use default
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    return 'file';
  }

  return sanitized;
}

export function validateFileExtension(filename, allowedExtensions) {
  if (!filename) return false;

  const ext = path.extname(filename).toLowerCase();
  const extWithoutDot = ext.startsWith('.') ? ext.substring(1) : ext;

  return allowedExtensions.some(allowed => {
    const allowedExt = allowed.startsWith('.') ? allowed.substring(1) : allowed;
    return extWithoutDot === allowedExt.toLowerCase();
  });
}

export function validateFilename(filename, storagePath) {
  if (!filename || typeof filename !== 'string') {
    return {
      valid: false,
      error: 'invalid filename',
    };
  }

  // Remove path separators and dangerous characters
  // eslint-disable-next-line no-control-regex
  let sanitized = filename.replace(/[/\\\x00-\x1f\x7f-\x9f]/g, '');

  // Remove leading dots and spaces
  sanitized = sanitized.replace(/^[.\s]+/, '');

  // Check for path traversal attempts
  if (sanitized.includes('..') || sanitized.includes('./') || sanitized.includes('.\\')) {
    return {
      valid: false,
      error: 'path traversal detected',
    };
  }

  // Limit length
  if (sanitized.length > 255) {
    sanitized = sanitized.substring(0, 255);
  }

  // If empty after sanitization, invalid
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    return {
      valid: false,
      error: 'invalid filename',
    };
  }

  // Normalize path to ensure it stays within storage directory
  const normalizedPath = path.normalize(path.join(storagePath, sanitized));
  const resolvedPath = path.resolve(normalizedPath);
  const resolvedStorage = path.resolve(storagePath);

  // Ensure resolved path is within storage directory
  if (!resolvedPath.startsWith(resolvedStorage)) {
    return {
      valid: false,
      error: 'path traversal detected',
    };
  }

  return {
    valid: true,
    filename: sanitized,
    filePath: resolvedPath,
  };
}
