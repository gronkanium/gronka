import http from 'http';
import { createLogger } from '../utils/logger.js';
import { webuiConfig } from '../utils/config.js';
import { ConfigurationError } from '../utils/errors.js';
import { getPostgresConfig } from '../utils/database/connection.js';
import { initDatabase } from '../utils/database.js';
import { createApp } from './app.js';

const logger = createLogger('webui');

// Store server reference for graceful shutdown
let server = null;

const { webuiPort: WEBUI_PORT, webuiHost: WEBUI_HOST } = webuiConfig;

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

(async () => {
  try {
    const dbConfig = getPostgresConfig();
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
  } catch (error) {
    logger.error('failed to initialize database:', error);
    process.exit(1);
  }

  server = http.createServer(createApp());

  server.listen(WEBUI_PORT, WEBUI_HOST, () => {
    logger.info(`webui server running on http://${WEBUI_HOST}:${WEBUI_PORT}`);
    logger.info(`dashboard: http://${WEBUI_HOST}:${WEBUI_PORT}`);
  });
})();

function gracefulShutdown() {
  logger.info('Shutdown signal received, shutting down gracefully...');
  if (server) {
    server.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
  }
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
