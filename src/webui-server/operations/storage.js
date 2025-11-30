import { enrichOperationUsername } from './enrichment.js';

const MAX_OPERATIONS = 100;

// In-memory storage for operations (mirror of bot's operations)
export const operations = [];

export { MAX_OPERATIONS };

// Store operation in memory
export function storeOperation(operation) {
  // Enrich operation with username if missing
  enrichOperationUsername(operation);

  const index = operations.findIndex(op => op.id === operation.id);
  if (index !== -1) {
    // Update existing operation
    operations[index] = operation;
  } else {
    // Add new operation at the beginning
    operations.unshift(operation);
    // Keep only last 100 operations
    if (operations.length > MAX_OPERATIONS) {
      operations.pop();
    }
  }
}
