import express from 'express';
import { createLogger } from '../../utils/logger.js';
import { getPostgresConfig } from '../../utils/database/connection.js';
import { getOperationTrace, searchOperations } from '../../utils/database.js';
import { operations, storeOperation } from '../operations/storage.js';
import { reconstructOperationFromTrace } from '../operations/reconstruction.js';
import { broadcastOperation, broadcastUserMetrics } from '../sse/broadcast.js';

const logger = createLogger('webui');
const router = express.Router();

// Need clients Set - will be passed via dependency injection
let clients = null;

export function setSseClients(clientsSet) {
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
    // 2. Checking if database indicates test mode
    const dbConfig = getPostgresConfig();
    // Extract database name or connection string
    const dbInfo = typeof dbConfig === 'string' ? dbConfig : dbConfig.database;
    const isTestDatabase =
      dbInfo && (dbInfo.includes('test') || dbInfo.includes('tmp') || dbInfo.includes('temp'));

    // User 86 is a known test user, reject operations from it
    if (operation.userId === '86' || String(operation.userId) === '86') {
      logger.debug(`Rejecting operation ${operation.id} from test user 86`);
      return res.status(400).json({ error: 'test operations not allowed in production' });
    }

    // If database path indicates test mode, reject operations to prevent cross-contamination
    if (isTestDatabase) {
      logger.warn(
        `Rejecting operation ${operation.id} - webui-server is using test database: ${dbInfo}`
      );
      return res.status(400).json({ error: 'test database detected - operations rejected' });
    }

    // Broadcast the operation update to all connected SSE clients
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
    // Broadcast the user metrics update to all connected SSE clients
    if (clients) {
      broadcastUserMetrics(clients, userId, metrics);
    }
    res.json({ success: true });
  } catch (error) {
    logger.error('Error handling user metrics update:', error);
    res.status(500).json({ error: 'failed to process user metrics update' });
  }
});

// Requests endpoint - shows all user requests including early failures
router.get('/api/requests', async (req, res) => {
  try {
    const {
      operationId,
      userId,
      username,
      urlPattern,
      status,
      type,
      earlyFailureOnly,
      failedOnly,
      dateFrom,
      dateTo,
      minDuration,
      maxDuration,
      minFileSize,
      maxFileSize,
      sort,
      limit = 100,
      offset = 0,
    } = req.query;

    const filters = {
      operationId: operationId || undefined,
      userId: userId || undefined,
      username: username || undefined,
      urlPattern: urlPattern || undefined,
      types: type ? (Array.isArray(type) ? type : [type]) : undefined,
      statuses: status ? (Array.isArray(status) ? status : [status]) : undefined,
      failedOnly: failedOnly === 'true',
      earlyFailureOnly: earlyFailureOnly === 'true',
      dateFrom: dateFrom ? parseInt(dateFrom, 10) : undefined,
      dateTo: dateTo ? parseInt(dateTo, 10) : undefined,
      minDuration: minDuration ? parseInt(minDuration, 10) : undefined,
      maxDuration: maxDuration ? parseInt(maxDuration, 10) : undefined,
      minFileSize: minFileSize ? parseInt(minFileSize, 10) : undefined,
      maxFileSize: maxFileSize ? parseInt(maxFileSize, 10) : undefined,
    };

    // Filters query the full operation history in SQL (not just the most
    // recent N operations), so search reliably finds older matches.
    const { operations: paginated, total } = await searchOperations(filters, {
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
      sort,
    });

    res.json({
      requests: paginated,
      total,
    });
  } catch (error) {
    logger.error('Failed to fetch requests:', error);
    res.status(500).json({
      error: 'failed to fetch requests',
      message: error.message,
    });
  }
});

// Operation details endpoint
router.get('/api/operations/:operationId', async (req, res) => {
  try {
    const { operationId } = req.params;

    // Get operation from in-memory store
    let operation = operations.find(op => op.id === operationId);
    if (operation) {
      // Live operations track their own steps in real time, unlike DB
      // reconstructions where step-level logs were never persisted.
      operation = { ...operation, stepsAvailable: true };
    }

    // If not in memory, try to reconstruct from database
    if (!operation) {
      const trace = await getOperationTrace(operationId);
      if (trace) {
        operation = await reconstructOperationFromTrace(trace);
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

export default router;
