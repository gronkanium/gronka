import http from 'http';
import { createLogger } from '../utils/logger.js';
import { webuiConfig } from '../utils/config.js';
import { ConfigurationError } from '../utils/errors.js';
import { getPostgresConfig } from '../utils/database/connection.js';
import { initDatabase, getRecentOperations } from '../utils/database.js';
import { startMetricsCollection, stopMetricsCollection } from '../utils/system-metrics.js';
import {
  setBroadcastCallback,
  setUserMetricsBroadcastCallback,
} from '../utils/operations-tracker.js';
import { setLogBroadcastCallback } from '../utils/logger.js';
import { setBroadcastCallback as setAlertBroadcastCallback } from '../utils/ntfy-notifier.js';
import { setBroadcastCallback as setSystemMetricsBroadcastCallback } from '../utils/system-metrics.js';
import { createApp } from './app.js';
import {
  createWebSocketServer,
  startPingInterval,
  stopPingInterval,
  clients,
} from './websocket/server.js';
import { setupWebSocketHandlers, pingClients } from './websocket/handlers.js';
import {
  broadcastOperation,
  broadcastLog,
  broadcastSystemMetrics,
  broadcastAlert,
  broadcastUserMetrics,
} from './websocket/broadcast.js';
import { operations, MAX_OPERATIONS } from './operations/storage.js';
import { enrichOperationUsername } from './operations/enrichment.js';

const logger = createLogger('webui');

// Store server and wss references for graceful shutdown
let server = null;
let wss = null;

// Configuration from centralized config
const { webuiPort: WEBUI_PORT, webuiHost: WEBUI_HOST } = webuiConfig;

// Validate configuration
try {
  // Config validation happens during import
  if (!WEBUI_PORT) {
    throw new ConfigurationError('Required WebUI configuration missing');
  }
} catch (error) {
  if (error instanceof ConfigurationError) {
    logger.error('Configuration error:', error.message);
  } else {
    logger.error('Failed to load configuration:', error);
  }
  process.exit(1);
}

// Set up broadcast callbacks with clients
const broadcastOperationWrapper = operation => {
  broadcastOperation(clients, operation);
};
const broadcastLogWrapper = logEntry => {
  broadcastLog(clients, logEntry);
};
const broadcastSystemMetricsWrapper = metrics => {
  broadcastSystemMetrics(clients, metrics);
};
const broadcastAlertWrapper = alert => {
  broadcastAlert(clients, alert);
};
const broadcastUserMetricsWrapper = (userId, metrics) => {
  broadcastUserMetrics(clients, userId, metrics);
};

// Initialize database and start server
(async () => {
  try {
    // Log and validate database configuration before initialization
    const dbConfig = getPostgresConfig();
    // Extract database name or connection string
    const dbInfo = typeof dbConfig === 'string' ? dbConfig : dbConfig.database;
    logger.info(`using database: ${dbInfo}`);

    // Check if database indicates test mode (should not happen in production)
    const isTestDatabase =
      dbInfo && (dbInfo.includes('test') || dbInfo.includes('tmp') || dbInfo.includes('temp'));
    if (isTestDatabase) {
      logger.warn(
        `WARNING: webui-server is using a test database: ${dbInfo}. This may cause test operations to appear in production webUI.`
      );
    }

    await initDatabase();
    logger.info('database initialized');

    // Clear in-memory operations before loading from database to prevent stale test operations
    operations.length = 0;

    // Load recent operations from database
    try {
      const recentOps = await getRecentOperations(MAX_OPERATIONS);
      if (recentOps && Array.isArray(recentOps) && recentOps.length > 0) {
        // Enrich operations with usernames if missing
        let enrichedCount = 0;
        for (const op of recentOps) {
          if (await enrichOperationUsername(op)) {
            enrichedCount++;
          }
        }
        // Add operations to in-memory store (most recent first)
        operations.push(...recentOps);
        logger.info(
          `loaded ${recentOps.length} operations from database${enrichedCount > 0 ? `, enriched ${enrichedCount} usernames` : ''}`
        );
      } else {
        logger.info('no operations found in database or invalid response format');
      }
    } catch (error) {
      logger.error('failed to load operations from database:', error);
      // Continue startup even if loading operations fails
    }
  } catch (error) {
    logger.error('failed to initialize database:', error);
    process.exit(1);
  }

  // Create Express app
  const app = createApp(clients);

  // Create HTTP server from Express app
  server = http.createServer(app);

  // Create WebSocket server
  const wsServer = createWebSocketServer(server);
  wss = wsServer.wss;

  // Set up WebSocket handlers
  setupWebSocketHandlers(wss, clients);

  // Set the broadcast callback in operations tracker (with instance port)
  setBroadcastCallback(broadcastOperationWrapper, WEBUI_PORT);

  // Set the log broadcast callback
  setLogBroadcastCallback(broadcastLogWrapper);

  // Set the system metrics broadcast callback
  setSystemMetricsBroadcastCallback(broadcastSystemMetricsWrapper);

  // Set the alert broadcast callback
  setAlertBroadcastCallback(broadcastAlertWrapper);

  // Set the user metrics broadcast callback (with instance port)
  setUserMetricsBroadcastCallback(broadcastUserMetricsWrapper, WEBUI_PORT);

  // Start server
  server.listen(WEBUI_PORT, WEBUI_HOST, () => {
    logger.info(`webui server running on http://${WEBUI_HOST}:${WEBUI_PORT}`);
    logger.info(`dashboard: http://${WEBUI_HOST}:${WEBUI_PORT}`);
    logger.info(`websocket: ws://${WEBUI_HOST}:${WEBUI_PORT}/api/ws`);

    // Start system metrics collection (every 60 seconds)
    startMetricsCollection(60000);
    logger.info('started system metrics collection');

    // Start ping/pong heartbeat (every 30 seconds)
    startPingInterval(() => pingClients(clients));
  });
})();

// Handle graceful shutdown
function gracefulShutdown() {
  logger.info('Shutdown signal received, shutting down gracefully...');
  // Stop metrics collection
  stopMetricsCollection();
  // Stop ping interval
  stopPingInterval();
  // Close WebSocket server
  if (wss) {
    wss.close(() => {
      logger.info('WebSocket server closed');
    });
  }
  // Close HTTP server
  if (server) {
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
  }
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Export broadcast functions for external use
export { broadcastLogWrapper as broadcastLog };
export { broadcastSystemMetricsWrapper as broadcastSystemMetrics };
export { broadcastAlertWrapper as broadcastAlert };
export { broadcastUserMetricsWrapper as broadcastUserMetrics };
