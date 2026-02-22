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
    // Strip brackets that Node's URL parser may leave on IPv6 literals
    const ipv6Host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
    if (
      ipv6Host.startsWith('fc') || // fc00::/7 unique-local (fc00:: – fbff::)
      ipv6Host.startsWith('fd') || // fc00::/7 unique-local (fd00:: – fdff::)
      ipv6Host.startsWith('fe80:') || // fe80::/10 link-local
      ipv6Host.startsWith('::') // loopback (::1), unspecified (::), IPv4-mapped (::ffff:...)
    ) {
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
