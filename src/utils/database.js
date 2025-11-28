// Barrel export file - re-exports all functions from submodules for backward compatibility
// This file maintains the same API as before the refactoring

// Database initialization
export { initDatabase, closeDatabase, ensureDbInitialized } from './database/init.js';

// Logs operations
export {
  insertLog,
  getLogs,
  getLogsCount,
  getLogComponents,
  getLogMetrics,
} from './database/logs.js';

// Users operations
export { insertOrUpdateUser, getUser, getUniqueUserCount } from './database/users.js';

// Processed URLs operations
export {
  getProcessedUrl,
  insertProcessedUrl,
  getUserMedia,
  getUserMediaCount,
  getUserR2Media,
  getUserR2MediaCount,
  deleteProcessedUrl,
  deleteUserR2Media,
} from './database/processed-urls.js';

// Operations tracking
export {
  insertOperationLog,
  getOperationLogs,
  getOperationTrace,
  getFailedOperationsByUser,
  searchOperationsByUrl,
  getRecentOperations,
  getStuckOperations,
  markOperationAsFailed,
} from './database/operations.js';

// Metrics operations
export {
  insertOrUpdateUserMetrics,
  getUserMetrics,
  getAllUsersMetrics,
  getUserMetricsCount,
  insertSystemMetrics,
  getSystemMetrics,
  getLatestSystemMetrics,
} from './database/metrics.js';

// Alerts operations
export { insertAlert, getAlerts, getAlertsCount } from './database/alerts.js';
