import path from 'path';

/**
 * Validate URL to prevent SSRF attacks
 * @param {string} url - URL to validate
 * @returns {Object} Validation result with error message if invalid
 */
export function validateUrl(url) {
  try {
    const urlObj = new URL(url);

    // Only allow http and https protocols
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      return {
        valid: false,
        error: 'only http and https protocols are allowed',
      };
    }

    const hostname = urlObj.hostname.toLowerCase();

    // Block localhost and loopback addresses
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '0.0.0.0'
    ) {
      return {
        valid: false,
        error: 'localhost and loopback addresses are not allowed',
      };
    }

    // Block private IP ranges (RFC 1918 and others)
    const privateRanges = [
      /^10\./, // 10.0.0.0/8
      /^172\.(1[6-9]|2[0-9]|3[01])\./, // 172.16.0.0/12
      /^192\.168\./, // 192.168.0.0/16
      /^169\.254\./, // Link-local
      /^127\./, // Loopback (additional check)
      /^0\./, // Invalid
      /^224\./, // Multicast
      /^240\./, // Reserved
    ];

    for (const range of privateRanges) {
      if (range.test(hostname)) {
        return {
          valid: false,
          error: 'private and internal IP addresses are not allowed',
        };
      }
    }

    // Block IPv6 private ranges
    if (hostname.startsWith('fc00:') || hostname.startsWith('fe80:') || hostname.startsWith('::')) {
      return {
        valid: false,
        error: 'private IPv6 addresses are not allowed',
      };
    }

    return { valid: true };
  } catch {
    return {
      valid: false,
      error: 'invalid URL format',
    };
  }
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

/**
 * Sanitize filename to prevent path traversal and other issues
 * @param {string} filename - Filename to sanitize
 * @returns {string} Sanitized filename
 */
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

/**
 * Validate file extension against allowed list
 * @param {string} filename - Filename to check
 * @param {string[]} allowedExtensions - Array of allowed extensions (with or without dot)
 * @returns {boolean} True if extension is allowed
 */
export function validateFileExtension(filename, allowedExtensions) {
  if (!filename) return false;

  const ext = path.extname(filename).toLowerCase();
  const extWithoutDot = ext.startsWith('.') ? ext.substring(1) : ext;

  return allowedExtensions.some(allowed => {
    const allowedExt = allowed.startsWith('.') ? allowed.substring(1) : allowed;
    return extWithoutDot === allowedExt.toLowerCase();
  });
}

/**
 * Validate filename to prevent path traversal attacks
 * @param {string} filename - Filename to validate
 * @param {string} storagePath - Base storage path
 * @returns {Object} Validation result with sanitized filename or error
 */
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
