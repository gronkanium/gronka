import express from 'express';
import { createLogger } from '../../utils/logger.js';
import { getDbPath } from '../../utils/database/connection.js';
import {
  getOperationTrace,
  getRecentOperations,
  searchOperationsByUrl,
} from '../../utils/database.js';
import { operations, storeOperation } from '../operations/storage.js';
import { reconstructOperationFromTrace } from '../operations/reconstruction.js';
import { broadcastOperation, broadcastUserMetrics } from '../websocket/broadcast.js';
import { restrictToInternal } from '../utils/validation.js';

const logger = createLogger('webui');
const router = express.Router();

// Need clients Set - will be passed via dependency injection
let clients = null;

export function setWebSocketClients(clientsSet) {
  clients = clientsSet;
}

// Endpoint for bot to send operation updates
router.post('/api/operations', express.json(), (req, res) => {
  try {
    const operation = req.body;
    if (!operation || !operation.id) {
      return res.status(400).json({ error: 'invalid operation data' });
    }

    // Filter out test operations to prevent them from appearing in production webUI
    // Check if this is a test operation by:
    // 1. Checking if userId matches known test user patterns (e.g., user 86, or test-like IDs)
    // 2. Checking if database path indicates test mode
    const dbPath = getDbPath();
    const isTestDatabase =
      dbPath && (dbPath.includes('test') || dbPath.includes('tmp') || dbPath.includes('temp'));

    // User 86 is a known test user, reject operations from it
    if (operation.userId === '86' || String(operation.userId) === '86') {
      logger.debug(`Rejecting operation ${operation.id} from test user 86`);
      return res.status(400).json({ error: 'test operations not allowed in production' });
    }

    // If database path indicates test mode, reject operations to prevent cross-contamination
    if (isTestDatabase) {
      logger.warn(
        `Rejecting operation ${operation.id} - webui-server is using test database: ${dbPath}`
      );
      return res.status(400).json({ error: 'test database detected - operations rejected' });
    }

    // Broadcast the operation update to all connected websocket clients
    if (clients) {
      storeOperation(operation);
      broadcastOperation(clients, operation);
    }
    res.json({ success: true });
  } catch (error) {
    logger.error('Error handling operation update:', error);
    res.status(500).json({ error: 'failed to process operation update' });
  }
});

// Endpoint for bot to send user metrics updates
router.post('/api/user-metrics', express.json(), (req, res) => {
  try {
    const { userId, metrics } = req.body;
    if (!userId || !metrics) {
      return res.status(400).json({ error: 'invalid user metrics data' });
    }
    // Broadcast the user metrics update to all connected websocket clients
    if (clients) {
      broadcastUserMetrics(clients, userId, metrics);
    }
    res.json({ success: true });
  } catch (error) {
    logger.error('Error handling user metrics update:', error);
    res.status(500).json({ error: 'failed to process user metrics update' });
  }
});

// Admin endpoint to clear test operations from memory (non-destructive)
// Only accessible from localhost/internal network
router.post('/api/admin/operations/clear', restrictToInternal, express.json(), (req, res) => {
  try {
    const { userId, clearAll } = req.body;

    let removedCount = 0;

    if (clearAll === true) {
      // Clear all operations from memory
      removedCount = operations.length;
      operations.length = 0;
      logger.info(`Cleared all ${removedCount} operations from memory (admin request)`);
    } else if (userId) {
      // Remove operations from specific user ID (e.g., test user 86)
      const initialLength = operations.length;
      const filtered = operations.filter(op => String(op.userId) !== String(userId));
      removedCount = initialLength - filtered.length;
      operations.length = 0;
      operations.push(...filtered);
      logger.info(`Removed ${removedCount} operations from user ${userId} (admin request)`);
    } else {
      // Default: remove known test users (user 86)
      const testUserIds = ['86'];
      const initialLength = operations.length;
      const filtered = operations.filter(op => !testUserIds.includes(String(op.userId)));
      removedCount = initialLength - filtered.length;
      operations.length = 0;
      operations.push(...filtered);
      logger.info(`Removed ${removedCount} test operations (default: user 86) (admin request)`);
    }

    // Broadcast empty operations list to all connected clients to refresh their view
    if (clients) {
      const message = JSON.stringify({ type: 'operations', data: [...operations] });
      clients.forEach(client => {
        if (client.readyState === 1) {
          try {
            client.send(message);
          } catch (error) {
            logger.error('Error sending operations update to client:', error);
          }
        }
      });
    }

    res.json({
      success: true,
      removedCount,
      remainingCount: operations.length,
      message: `Removed ${removedCount} operation(s) from memory`,
    });
  } catch (error) {
    logger.error('Error clearing operations:', error);
    res.status(500).json({ error: 'failed to clear operations', message: error.message });
  }
});

// Operations search endpoint - MUST come before /api/operations/:operationId
// Otherwise Express will match "search" as an operationId parameter
router.get('/api/operations/search', async (req, res) => {
  try {
    const {
      operationId,
      status,
      type,
      userId,
      username,
      urlPattern,
      dateFrom,
      dateTo,
      minDuration,
      maxDuration,
      minFileSize,
      maxFileSize,
      failedOnly,
      limit = 100,
      offset = 0,
    } = req.query;

    // Start with WebSocket operations (real-time)
    let allOperations = [...operations];

    // Get operations from database (historical)
    try {
      const dbLimit = parseInt(limit, 10) + parseInt(offset, 10) + 100; // Get extra for filtering
      const dbOps = await getRecentOperations(dbLimit);

      // Merge with in-memory operations, avoiding duplicates
      const existingIds = new Set(allOperations.map(op => op.id));
      const newOps = dbOps.filter(op => !existingIds.has(op.id));
      allOperations = [...allOperations, ...newOps];
    } catch (error) {
      logger.error('Failed to fetch operations from database:', error);
      // Continue with in-memory operations only
    }

    // Apply filters
    let filtered = allOperations;

    // Operation ID search (exact match)
    if (operationId) {
      filtered = filtered.filter(op => op.id === operationId);
    }

    // Status filter
    if (status) {
      const statusArray = Array.isArray(status) ? status : [status];
      filtered = filtered.filter(op => statusArray.includes(op.status));
    }

    // Type filter
    if (type) {
      const typeArray = Array.isArray(type) ? type : [type];
      filtered = filtered.filter(op => typeArray.includes(op.type));
    }

    // User ID filter
    if (userId) {
      filtered = filtered.filter(op => op.userId === userId);
    }

    // Username filter
    if (username) {
      const usernameLower = username.toLowerCase();
      filtered = filtered.filter(
        op => op.username && op.username.toLowerCase().includes(usernameLower)
      );
    }

    // URL pattern search (requires getting traces from database)
    if (urlPattern) {
      try {
        const urlTraces = await searchOperationsByUrl(urlPattern, 1000);
        const urlOperationIds = new Set(urlTraces.map(trace => trace.operationId));
        filtered = filtered.filter(op => urlOperationIds.has(op.id));
      } catch (error) {
        logger.error('Failed to search operations by URL:', error);
        // Continue without URL filter if search fails
      }
    }

    // Failed only filter
    if (failedOnly === 'true') {
      filtered = filtered.filter(op => op.status === 'error');
    }

    // Date range filter
    if (dateFrom) {
      const fromTimestamp = parseInt(dateFrom, 10);
      filtered = filtered.filter(op => op.timestamp >= fromTimestamp);
    }
    if (dateTo) {
      const toTimestamp = parseInt(dateTo, 10);
      filtered = filtered.filter(op => op.timestamp <= toTimestamp);
    }

    // Duration filter
    if (minDuration) {
      const minDur = parseInt(minDuration, 10);
      filtered = filtered.filter(
        op => op.performanceMetrics?.duration && op.performanceMetrics.duration >= minDur
      );
    }
    if (maxDuration) {
      const maxDur = parseInt(maxDuration, 10);
      filtered = filtered.filter(
        op => op.performanceMetrics?.duration && op.performanceMetrics.duration <= maxDur
      );
    }

    // File size filter
    if (minFileSize) {
      const minSize = parseInt(minFileSize, 10);
      filtered = filtered.filter(op => op.fileSize && op.fileSize >= minSize);
    }
    if (maxFileSize) {
      const maxSize = parseInt(maxFileSize, 10);
      filtered = filtered.filter(op => op.fileSize && op.fileSize <= maxSize);
    }

    // Sort by timestamp (most recent first)
    filtered.sort((a, b) => b.timestamp - a.timestamp);

    // Apply pagination
    const limitNum = parseInt(limit, 10);
    const offsetNum = parseInt(offset, 10);
    const paginated = filtered.slice(offsetNum, offsetNum + limitNum);

    res.json({
      operations: paginated,
      total: filtered.length,
    });
  } catch (error) {
    logger.error('Failed to search operations:', error);
    res.status(500).json({
      error: 'failed to search operations',
      message: error.message,
    });
  }
});

// Requests endpoint - shows all user requests including early failures
router.get('/api/requests', async (req, res) => {
  try {
    const {
      operationId,
      userId,
      username,
      status,
      type,
      errorType,
      earlyFailure,
      earlyFailureOnly,
      failedOnly,
      dateFrom,
      dateTo,
      minDuration,
      maxDuration,
      minFileSize,
      maxFileSize,
      limit = 100,
      offset = 0,
    } = req.query;

    // Start with WebSocket operations (real-time)
    let allOperations = [...operations];

    // Get operations from database (historical)
    try {
      const dbLimit = parseInt(limit, 10) + parseInt(offset, 10) + 100; // Get extra for filtering
      const dbOps = await getRecentOperations(dbLimit);

      // Merge with in-memory operations, avoiding duplicates
      const existingIds = new Set(allOperations.map(op => op.id));
      const newOps = dbOps.filter(op => !existingIds.has(op.id));
      allOperations = [...allOperations, ...newOps];
    } catch (error) {
      logger.error('Failed to fetch operations from database:', error);
      // Continue with in-memory operations only
    }

    // Apply filters
    let filtered = allOperations;

    // Operation ID filter
    if (operationId) {
      filtered = filtered.filter(op => op.id === operationId);
    }

    // User ID filter
    if (userId) {
      filtered = filtered.filter(op => op.userId === userId);
    }

    // Username filter
    if (username) {
      const usernameLower = username.toLowerCase();
      filtered = filtered.filter(
        op => op.username && op.username.toLowerCase().includes(usernameLower)
      );
    }

    // Status filter
    if (status) {
      const statusArray = Array.isArray(status) ? status : [status];
      filtered = filtered.filter(op => statusArray.includes(op.status));
    }

    // Type filter
    if (type) {
      const typeArray = Array.isArray(type) ? type : [type];
      filtered = filtered.filter(op => typeArray.includes(op.type));
    }

    // Failed only filter
    if (failedOnly === 'true') {
      filtered = filtered.filter(op => op.status === 'error');
    }

    // Early failure only filter
    if (earlyFailureOnly === 'true') {
      filtered = filtered.filter(op => op.earlyFailure === true);
    }

    // Error type filter (for early failures)
    if (errorType) {
      // First check if errorType is directly on the operation object (from in-memory)
      // Then check database traces for historical operations
      const directMatches = filtered.filter(op => op.errorType === errorType);
      const needsDbCheck = filtered.filter(op => !op.errorType && op.status === 'error');

      if (needsDbCheck.length > 0) {
        try {
          const traces = await Promise.all(
            needsDbCheck.map(async op => {
              try {
                return await getOperationTrace(op.id);
              } catch {
                return null;
              }
            })
          );
          const validTraces = traces.filter(Boolean);

          const dbMatchingIds = new Set();
          validTraces.forEach(trace => {
            const createdLog = trace.logs.find(log => log.step === 'created');
            if (createdLog?.metadata?.errorType === errorType) {
              dbMatchingIds.add(trace.operationId);
            }
          });

          // Combine direct matches with database matches
          const dbMatches = needsDbCheck.filter(op => dbMatchingIds.has(op.id));
          filtered = [...directMatches, ...dbMatches];
        } catch (error) {
          logger.error('Failed to filter by error type:', error);
          // Fall back to direct matches only
          filtered = directMatches;
        }
      } else {
        filtered = directMatches;
      }
    }

    // Early failure filter (legacy support)
    if (earlyFailure === 'true') {
      filtered = filtered.filter(op => op.earlyFailure === true || op.status === 'error');
    }

    // Date range filter
    if (dateFrom) {
      const fromTimestamp = parseInt(dateFrom, 10);
      filtered = filtered.filter(op => op.timestamp >= fromTimestamp);
    }
    if (dateTo) {
      const toTimestamp = parseInt(dateTo, 10);
      filtered = filtered.filter(op => op.timestamp <= toTimestamp);
    }

    // Duration filters
    if (minDuration) {
      const minDur = parseInt(minDuration, 10);
      filtered = filtered.filter(
        op => op.performanceMetrics?.duration && op.performanceMetrics.duration >= minDur
      );
    }
    if (maxDuration) {
      const maxDur = parseInt(maxDuration, 10);
      filtered = filtered.filter(
        op => op.performanceMetrics?.duration && op.performanceMetrics.duration <= maxDur
      );
    }

    // File size filters
    if (minFileSize) {
      const minSize = parseInt(minFileSize, 10);
      filtered = filtered.filter(op => op.fileSize && op.fileSize >= minSize);
    }
    if (maxFileSize) {
      const maxSize = parseInt(maxFileSize, 10);
      filtered = filtered.filter(op => op.fileSize && op.fileSize <= maxSize);
    }

    // Sort by timestamp (most recent first)
    filtered.sort((a, b) => b.timestamp - a.timestamp);

    // Apply pagination
    const limitNum = parseInt(limit, 10);
    const offsetNum = parseInt(offset, 10);
    const paginated = filtered.slice(offsetNum, offsetNum + limitNum);

    res.json({
      requests: paginated,
      total: filtered.length,
    });
  } catch (error) {
    logger.error('Failed to fetch requests:', error);
    res.status(500).json({
      error: 'failed to fetch requests',
      message: error.message,
    });
  }
});

// Operation details endpoint - MUST come after /api/operations/search
router.get('/api/operations/:operationId', async (req, res) => {
  try {
    const { operationId } = req.params;

    // Get operation from in-memory store
    let operation = operations.find(op => op.id === operationId);

    // If not in memory, try to reconstruct from database
    if (!operation) {
      const trace = await getOperationTrace(operationId);
      if (trace) {
        operation = reconstructOperationFromTrace(trace);
      }
    }

    // Get detailed trace from database with parsed metadata
    const trace = await getOperationTrace(operationId);

    // Debug logging
    if (trace) {
      const executionStepsCount = trace.logs.filter(
        log => log.step !== 'created' && log.step !== 'status_update' && log.step !== 'error'
      ).length;
      logger.debug(
        `Trace retrieved for operation ${operationId}: ${trace.logs.length} total logs, ${executionStepsCount} execution steps`
      );
    } else {
      logger.debug(`No trace found for operation ${operationId}`);
    }

    if (!operation && !trace) {
      return res.status(404).json({ error: 'operation not found' });
    }

    res.json({
      operation: operation || null,
      trace: trace || null,
    });
  } catch (error) {
    logger.error('Failed to fetch operation details:', error);
    res.status(500).json({
      error: 'failed to fetch operation details',
      message: error.message,
    });
  }
});

// Operation trace endpoint
router.get('/api/operations/:operationId/trace', async (req, res) => {
  try {
    const { operationId } = req.params;
    const trace = await getOperationTrace(operationId);

    if (!trace) {
      return res.status(404).json({ error: 'operation trace not found' });
    }

    res.json({ trace });
  } catch (error) {
    logger.error('Failed to fetch operation trace:', error);
    res.status(500).json({
      error: 'failed to fetch operation trace',
      message: error.message,
    });
  }
});

// Related operations endpoint
router.get('/api/operations/:operationId/related', async (req, res) => {
  try {
    const { operationId } = req.params;
    const trace = await getOperationTrace(operationId);

    if (!trace) {
      return res.status(404).json({ error: 'operation not found' });
    }

    const context = trace.context || {};
    const userId = context.userId;
    const originalUrl = context.originalUrl;

    // Get all operations
    let allOperations = [...operations];
    try {
      const dbOps = await getRecentOperations(1000);
      const existingIds = new Set(allOperations.map(op => op.id));
      const newOps = dbOps.filter(op => !existingIds.has(op.id));
      allOperations = [...allOperations, ...newOps];
    } catch (error) {
      logger.error('Failed to fetch operations from database:', error);
    }

    // Find related operations (same user or same URL)
    const related = [];
    const seenIds = new Set([operationId]);

    for (const op of allOperations) {
      if (seenIds.has(op.id)) continue;

      let isRelated = false;

      // Match by user ID
      if (userId && op.userId === userId) {
        isRelated = true;
      }

      // Match by URL - get trace to check originalUrl
      if (originalUrl && !isRelated) {
        try {
          const opTrace = await getOperationTrace(op.id);
          if (opTrace && opTrace.context && opTrace.context.originalUrl === originalUrl) {
            isRelated = true;
          }
        } catch (_error) {
          // Skip if trace lookup fails
        }
      }

      if (isRelated) {
        related.push(op);
        seenIds.add(op.id);
        if (related.length >= 10) break; // Limit to 10
      }
    }

    // Sort by timestamp
    related.sort((a, b) => b.timestamp - a.timestamp);

    res.json({ operations: related });
  } catch (error) {
    logger.error('Failed to fetch related operations:', error);
    res.status(500).json({
      error: 'failed to fetch related operations',
      message: error.message,
    });
  }
});

// Error analysis endpoint
router.get('/api/operations/errors/analysis', async (req, res) => {
  try {
    // Get all operations with errors
    let allOperations = [...operations];
    try {
      const dbOps = await getRecentOperations(1000);
      const existingIds = new Set(allOperations.map(op => op.id));
      const newOps = dbOps.filter(op => !existingIds.has(op.id));
      allOperations = [...allOperations, ...newOps];
    } catch (error) {
      logger.error('Failed to fetch operations from database:', error);
    }

    // Filter to only error operations
    const errorOps = allOperations.filter(op => op.status === 'error' && op.error);

    // Group by error message pattern (normalize for grouping)
    const errorGroups = new Map();

    errorOps.forEach(op => {
      const errorMsg = op.error || 'unknown error';
      // Normalize error message for grouping (remove specific details like IDs, timestamps)
      const normalized = errorMsg
        .replace(/\d+/g, 'N')
        .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, 'UUID')
        .substring(0, 200); // Limit length

      if (!errorGroups.has(normalized)) {
        errorGroups.set(normalized, {
          pattern: errorMsg.substring(0, 150), // Use first 150 chars of original as pattern
          count: 0,
        });
      }
      errorGroups.get(normalized).count++;
    });

    // Convert to array and sort by count
    const groups = Array.from(errorGroups.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 20); // Top 20 error patterns

    res.json({ groups });
  } catch (error) {
    logger.error('Failed to analyze errors:', error);
    res.status(500).json({
      error: 'failed to analyze errors',
      message: error.message,
    });
  }
});

export default router;
