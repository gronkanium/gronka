import { createLogger } from '../../utils/logger.js';
import { getUser } from '../../utils/database.js';

const logger = createLogger('webui');

// Helper function to enrich operation with username from database
export function enrichOperationUsername(operation) {
  // Always try to enrich if we have a userId, even if username is already set
  // This ensures we get the latest username from the database
  if (operation.userId) {
    // Only enrich if username is missing or unknown
    if (!operation.username || operation.username === 'unknown') {
      try {
        const user = getUser(operation.userId);
        if (user && user.username) {
          operation.username = user.username;
          return true; // Username was enriched
        } else {
          // User not found in database - this is expected for some operations
          // The username will remain as null/unknown
        }
      } catch (error) {
        // Silently fail - operation will keep original username
        logger.debug(`Failed to enrich username for operation ${operation.id}: ${error.message}`);
      }
    }
  }
  return false; // Username was not enriched
}
