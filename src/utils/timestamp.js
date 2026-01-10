/**
 * Timestamp parsing utilities
 * Supports formats: plain seconds (43), MM:SS (1:43), HH:MM:SS (1:05:30)
 */

/**
 * Parse a timestamp string or number to seconds
 * @param {string|number|null|undefined} value - The timestamp value
 * @returns {{seconds: number|null, error: string|null}} Result object
 *
 * @example
 * parseTimestamp('43')       // { seconds: 43, error: null }
 * parseTimestamp('1:43')     // { seconds: 103, error: null }
 * parseTimestamp('1:05:30')  // { seconds: 3930, error: null }
 * parseTimestamp('1:43.5')   // { seconds: 103.5, error: null }
 * parseTimestamp(null)       // { seconds: null, error: null }
 * parseTimestamp('abc')      // { seconds: null, error: 'invalid format...' }
 */
export function parseTimestamp(value) {
  // Handle null/undefined/empty
  if (value === null || value === undefined || value === '') {
    return { seconds: null, error: null };
  }

  // Already a number
  if (typeof value === 'number') {
    if (value < 0) {
      return { seconds: null, error: 'timestamp cannot be negative' };
    }
    return { seconds: value, error: null };
  }

  const trimmed = String(value).trim();

  // Empty after trim
  if (trimmed === '') {
    return { seconds: null, error: null };
  }

  // Plain number (e.g., "43" or "43.5")
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return { seconds: parseFloat(trimmed), error: null };
  }

  // MM:SS format (e.g., "1:43", "90:30", "1:43.5")
  // Minutes can exceed 59 (no hours component means total minutes)
  const mmssMatch = trimmed.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (mmssMatch) {
    const mins = parseInt(mmssMatch[1], 10);
    const secs = parseFloat(mmssMatch[2]);
    if (secs >= 60) {
      return { seconds: null, error: 'seconds must be 0-59 in MM:SS format' };
    }
    return { seconds: mins * 60 + secs, error: null };
  }

  // HH:MM:SS format (e.g., "1:05:30", "1:05:30.5")
  const hhmmssMatch = trimmed.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (hhmmssMatch) {
    const hours = parseInt(hhmmssMatch[1], 10);
    const mins = parseInt(hhmmssMatch[2], 10);
    const secs = parseFloat(hhmmssMatch[3]);
    if (mins >= 60) {
      return { seconds: null, error: 'minutes must be 0-59 in HH:MM:SS format' };
    }
    if (secs >= 60) {
      return { seconds: null, error: 'seconds must be 0-59 in HH:MM:SS format' };
    }
    return { seconds: hours * 3600 + mins * 60 + secs, error: null };
  }

  return {
    seconds: null,
    error: 'invalid timestamp format. use seconds (43), MM:SS (1:43), or HH:MM:SS (1:05:30)',
  };
}

/**
 * Parse and validate a timestamp, returning just the seconds value
 * Throws an error if the format is invalid
 * @param {string|number|null|undefined} value - The timestamp value
 * @param {string} fieldName - Field name for error messages (e.g., 'start_time')
 * @returns {number|null} Seconds, or null if not provided
 * @throws {Error} If format is invalid
 */
export function parseTimestampOrThrow(value, fieldName = 'timestamp') {
  const result = parseTimestamp(value);
  if (result.error) {
    throw new Error(`invalid ${fieldName}: ${result.error}`);
  }
  return result.seconds;
}
