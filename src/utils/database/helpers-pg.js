/**
 * Helper functions for PostgreSQL database operations
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

export function convertTimestampsInArray(array, timestampFields = ['timestamp']) {
  if (!Array.isArray(array)) {
    return array;
  }
  return array.map(obj => convertTimestampsToNumbers(obj, timestampFields));
}

// postgres.js returns BIGINT as strings; these fields fit safely in a JS number
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

export function convertBigIntInArray(array, numericFields = []) {
  if (!Array.isArray(array)) {
    return array;
  }
  return array.map(obj => convertBigIntToNumbers(obj, numericFields));
}
