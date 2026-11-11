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
