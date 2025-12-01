// Barrel export file - re-exports all functions from submodules for backward compatibility
// This file maintains the same API as before the refactoring
// Routes to SQLite or PostgreSQL implementations based on DATABASE_TYPE at runtime

import { isPostgres } from './database/connection.js';

// Database initialization (routes to SQLite or PostgreSQL)
export { initDatabase, closeDatabase, ensureDbInitialized } from './database/init.js';

// Import both implementations
import * as logsSqlite from './database/logs.js';
import * as logsPg from './database/logs-pg.js';
import * as usersSqlite from './database/users.js';
import * as usersPg from './database/users-pg.js';
import * as processedUrlsSqlite from './database/processed-urls.js';
import * as processedUrlsPg from './database/processed-urls-pg.js';
import * as operationsSqlite from './database/operations.js';
import * as operationsPg from './database/operations-pg.js';
import * as metricsSqlite from './database/metrics.js';
import * as metricsPg from './database/metrics-pg.js';
import * as alertsSqlite from './database/alerts.js';
import * as alertsPg from './database/alerts-pg.js';
import * as temporaryUploadsSqlite from './database/temporary-uploads.js';
import * as temporaryUploadsPg from './database/temporary-uploads-pg.js';

// Helper to get the right implementation module
function getImpl(sqliteModule, pgModule) {
  return isPostgres() ? pgModule : sqliteModule;
}

// Helper to call function and handle both sync (SQLite) and async (PostgreSQL) cases
async function callImpl(impl, fnName, ...args) {
  const result = impl[fnName](...args);
  // If it's a Promise, return it; otherwise wrap in Promise.resolve for SQLite sync functions
  return result instanceof Promise ? result : Promise.resolve(result);
}

// Logs operations
export const insertLog = (...args) => callImpl(getImpl(logsSqlite, logsPg), 'insertLog', ...args);
export const getLogs = (...args) => callImpl(getImpl(logsSqlite, logsPg), 'getLogs', ...args);
export const getLogsCount = (...args) =>
  callImpl(getImpl(logsSqlite, logsPg), 'getLogsCount', ...args);
export const getLogComponents = (...args) =>
  callImpl(getImpl(logsSqlite, logsPg), 'getLogComponents', ...args);
export const getLogMetrics = (...args) =>
  callImpl(getImpl(logsSqlite, logsPg), 'getLogMetrics', ...args);

// Users operations
export const insertOrUpdateUser = (...args) =>
  callImpl(getImpl(usersSqlite, usersPg), 'insertOrUpdateUser', ...args);
export const getUser = (...args) => callImpl(getImpl(usersSqlite, usersPg), 'getUser', ...args);
export const getUniqueUserCount = (...args) =>
  callImpl(getImpl(usersSqlite, usersPg), 'getUniqueUserCount', ...args);

// Processed URLs operations
export const getProcessedUrl = (...args) =>
  callImpl(getImpl(processedUrlsSqlite, processedUrlsPg), 'getProcessedUrl', ...args);
export const insertProcessedUrl = (...args) =>
  callImpl(getImpl(processedUrlsSqlite, processedUrlsPg), 'insertProcessedUrl', ...args);
export const getUserMedia = (...args) =>
  callImpl(getImpl(processedUrlsSqlite, processedUrlsPg), 'getUserMedia', ...args);
export const getUserMediaCount = (...args) =>
  callImpl(getImpl(processedUrlsSqlite, processedUrlsPg), 'getUserMediaCount', ...args);
export const getUserR2Media = (...args) =>
  callImpl(getImpl(processedUrlsSqlite, processedUrlsPg), 'getUserR2Media', ...args);
export const getUserR2MediaCount = (...args) =>
  callImpl(getImpl(processedUrlsSqlite, processedUrlsPg), 'getUserR2MediaCount', ...args);
export const deleteProcessedUrl = (...args) =>
  callImpl(getImpl(processedUrlsSqlite, processedUrlsPg), 'deleteProcessedUrl', ...args);
export const deleteUserR2Media = (...args) =>
  callImpl(getImpl(processedUrlsSqlite, processedUrlsPg), 'deleteUserR2Media', ...args);

// Operations tracking
export const insertOperationLog = (...args) =>
  callImpl(getImpl(operationsSqlite, operationsPg), 'insertOperationLog', ...args);
export const getOperationLogs = (...args) =>
  callImpl(getImpl(operationsSqlite, operationsPg), 'getOperationLogs', ...args);
export const getOperationTrace = (...args) =>
  callImpl(getImpl(operationsSqlite, operationsPg), 'getOperationTrace', ...args);
export const getFailedOperationsByUser = (...args) =>
  callImpl(getImpl(operationsSqlite, operationsPg), 'getFailedOperationsByUser', ...args);
export const searchOperationsByUrl = (...args) =>
  callImpl(getImpl(operationsSqlite, operationsPg), 'searchOperationsByUrl', ...args);
export const getRecentOperations = (...args) =>
  callImpl(getImpl(operationsSqlite, operationsPg), 'getRecentOperations', ...args);
export const getStuckOperations = (...args) =>
  callImpl(getImpl(operationsSqlite, operationsPg), 'getStuckOperations', ...args);
export const markOperationAsFailed = (...args) =>
  callImpl(getImpl(operationsSqlite, operationsPg), 'markOperationAsFailed', ...args);
export const updateOperationLogMetadata = (...args) =>
  callImpl(getImpl(operationsSqlite, operationsPg), 'updateOperationLogMetadata', ...args);

// Metrics operations
export const insertOrUpdateUserMetrics = (...args) =>
  callImpl(getImpl(metricsSqlite, metricsPg), 'insertOrUpdateUserMetrics', ...args);
export const getUserMetrics = (...args) =>
  callImpl(getImpl(metricsSqlite, metricsPg), 'getUserMetrics', ...args);
export const getAllUsersMetrics = (...args) =>
  callImpl(getImpl(metricsSqlite, metricsPg), 'getAllUsersMetrics', ...args);
export const getUserMetricsCount = (...args) =>
  callImpl(getImpl(metricsSqlite, metricsPg), 'getUserMetricsCount', ...args);
export const insertSystemMetrics = (...args) =>
  callImpl(getImpl(metricsSqlite, metricsPg), 'insertSystemMetrics', ...args);
export const getSystemMetrics = (...args) =>
  callImpl(getImpl(metricsSqlite, metricsPg), 'getSystemMetrics', ...args);
export const getLatestSystemMetrics = (...args) =>
  callImpl(getImpl(metricsSqlite, metricsPg), 'getLatestSystemMetrics', ...args);

// Alerts operations
export const insertAlert = (...args) =>
  callImpl(getImpl(alertsSqlite, alertsPg), 'insertAlert', ...args);
export const getAlerts = (...args) =>
  callImpl(getImpl(alertsSqlite, alertsPg), 'getAlerts', ...args);
export const getAlertsCount = (...args) =>
  callImpl(getImpl(alertsSqlite, alertsPg), 'getAlertsCount', ...args);

// Temporary uploads operations
export const insertTemporaryUpload = (...args) =>
  callImpl(getImpl(temporaryUploadsSqlite, temporaryUploadsPg), 'insertTemporaryUpload', ...args);
export const getExpiredTemporaryUploads = (...args) =>
  callImpl(
    getImpl(temporaryUploadsSqlite, temporaryUploadsPg),
    'getExpiredTemporaryUploads',
    ...args
  );
export const getTemporaryUploadsByR2Key = (...args) =>
  callImpl(
    getImpl(temporaryUploadsSqlite, temporaryUploadsPg),
    'getTemporaryUploadsByR2Key',
    ...args
  );
export const markTemporaryUploadDeleted = (...args) =>
  callImpl(
    getImpl(temporaryUploadsSqlite, temporaryUploadsPg),
    'markTemporaryUploadDeleted',
    ...args
  );
export const markTemporaryUploadDeletionFailed = (...args) =>
  callImpl(
    getImpl(temporaryUploadsSqlite, temporaryUploadsPg),
    'markTemporaryUploadDeletionFailed',
    ...args
  );
export const getFailedDeletions = (...args) =>
  callImpl(getImpl(temporaryUploadsSqlite, temporaryUploadsPg), 'getFailedDeletions', ...args);
export const deleteTemporaryUpload = (...args) =>
  callImpl(getImpl(temporaryUploadsSqlite, temporaryUploadsPg), 'deleteTemporaryUpload', ...args);
export const deleteTemporaryUploadsByR2Key = (...args) =>
  callImpl(
    getImpl(temporaryUploadsSqlite, temporaryUploadsPg),
    'deleteTemporaryUploadsByR2Key',
    ...args
  );
export const getExpiredR2Keys = (...args) =>
  callImpl(getImpl(temporaryUploadsSqlite, temporaryUploadsPg), 'getExpiredR2Keys', ...args);
