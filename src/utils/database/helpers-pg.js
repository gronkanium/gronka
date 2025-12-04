/**
 * Helper functions for PostgreSQL database operations
 */

/**
 * Convert timestamp fields from strings to numbers in a single object
 * @param {Object} obj - Object to convert
 * @param {string[]} timestampFields - Array of field names that contain timestamps
 * @returns {Object} Object with timestamp fields converted to numbers
 */
export function convertTimestampsToNumbers(obj, timestampFields = ['timestamp']) {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  const converted = { ...obj };
  for (const field of timestampFields) {
    if (converted[field] !== null && converted[field] !== undefined) {
      const value = converted[field];
      // Convert string to number if it's a string representation of a number
      if (typeof value === 'string' && /^\d+$/.test(value)) {
        converted[field] = parseInt(value, 10);
      } else if (typeof value === 'string' && /^\d+\.\d+$/.test(value)) {
        // Handle decimal numbers (though timestamps should be integers)
        converted[field] = parseFloat(value);
      }
    }
  }
  return converted;
}

/**
 * Convert timestamp fields from strings to numbers in an array of objects
 * @param {Array} array - Array of objects to convert
 * @param {string[]} timestampFields - Array of field names that contain timestamps
 * @returns {Array} Array with timestamp fields converted to numbers
 */
export function convertTimestampsInArray(array, timestampFields = ['timestamp']) {
  if (!Array.isArray(array)) {
    return array;
  }
  return array.map(obj => convertTimestampsToNumbers(obj, timestampFields));
}

/**
 * Convert numeric BIGINT fields from strings to numbers in a single object
 * PostgreSQL BIGINT values are returned as strings by postgres.js to avoid precision issues.
 * This function converts them back to JavaScript numbers for fields where we know they fit safely.
 * @param {Object} obj - Object to convert
 * @param {string[]} numericFields - Array of field names that contain numeric BIGINT values
 * @returns {Object} Object with numeric fields converted to numbers
 */
export function convertBigIntToNumbers(obj, numericFields = []) {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  const converted = { ...obj };
  for (const field of numericFields) {
    if (converted[field] !== null && converted[field] !== undefined) {
      const value = converted[field];
      // Convert string to number if it's a string representation of a number
      if (typeof value === 'string' && /^-?\d+$/.test(value)) {
        converted[field] = parseInt(value, 10);
      } else if (typeof value === 'string' && /^-?\d+\.\d+$/.test(value)) {
        // Handle decimal numbers
        converted[field] = parseFloat(value);
      }
    }
  }
  return converted;
}

/**
 * Convert numeric BIGINT fields from strings to numbers in an array of objects
 * @param {Array} array - Array of objects to convert
 * @param {string[]} numericFields - Array of field names that contain numeric BIGINT values
 * @returns {Array} Array with numeric fields converted to numbers
 */
export function convertBigIntInArray(array, numericFields = []) {
  if (!Array.isArray(array)) {
    return array;
  }
  return array.map(obj => convertBigIntToNumbers(obj, numericFields));
}
