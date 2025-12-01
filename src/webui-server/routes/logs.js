import express from 'express';
import { createLogger } from '../../utils/logger.js';
import { getLogs, getLogsCount, getLogComponents, getLogMetrics } from '../../utils/database.js';

const logger = createLogger('webui');
const router = express.Router();

// Logs endpoint with filtering and pagination
router.get('/api/logs', async (req, res) => {
  try {
    const {
      component,
      level,
      startTime,
      endTime,
      search,
      limit = 100,
      offset = 0,
      orderDesc = 'true',
      excludedComponents,
    } = req.query;

    // Parse query parameters
    const options = {
      orderDesc: orderDesc === 'true',
      limit: parseInt(limit, 10) || 100,
      offset: parseInt(offset, 10) || 0,
    };

    if (component) options.component = component;
    if (search) options.search = search;
    if (startTime) options.startTime = parseInt(startTime, 10);
    if (endTime) options.endTime = parseInt(endTime, 10);

    // Handle multiple levels (comma-separated)
    if (level) {
      if (Array.isArray(level)) {
        // Multiple level parameters: flatten and trim all values
        options.level = level.flatMap(l =>
          typeof l === 'string' ? l.split(',').map(sub => sub.trim()) : []
        );
      } else if (typeof level === 'string') {
        if (level.includes(',')) {
          options.level = level.split(',').map(l => l.trim());
        } else {
          options.level = level.trim();
        }
      } else {
        // Unexpected type, ignore or reject (here we ignore)
      }
    }

    // Handle excluded components (comma-separated)
    if (excludedComponents) {
      if (Array.isArray(excludedComponents)) {
        // Multiple excluded component parameters: flatten and trim all values
        options.excludedComponents = excludedComponents.flatMap(c =>
          typeof c === 'string' ? c.split(',').map(sub => sub.trim()) : []
        );
      } else if (typeof excludedComponents === 'string') {
        if (excludedComponents.includes(',')) {
          options.excludedComponents = excludedComponents.split(',').map(c => c.trim());
        } else {
          options.excludedComponents = [excludedComponents.trim()];
        }
      }
    }

    // Always exclude webui INFO logs from the logs list (to mute HTTP request noise)
    // But keep ERROR/WARN logs from webui visible
    options.excludeComponentLevels = [{ component: 'webui', level: 'INFO' }];

    // Get logs and total count
    let logs, total;
    try {
      logs = await getLogs(options);
      if (logs === undefined || logs === null) {
        logger.warn('getLogs returned undefined or null, defaulting to empty array');
        logs = [];
      }
      if (!Array.isArray(logs)) {
        logger.warn(`getLogs returned non-array: ${typeof logs}, defaulting to empty array`);
        logs = [];
      }
    } catch (error) {
      logger.error('Error calling getLogs:', error);
      logger.error('Error stack:', error.stack);
      logs = [];
    }

    try {
      total = await getLogsCount(options);
      if (total === undefined || total === null) {
        logger.warn('getLogsCount returned undefined or null, defaulting to 0');
        total = 0;
      }
      if (typeof total !== 'number') {
        logger.warn(`getLogsCount returned non-number: ${typeof total}, defaulting to 0`);
        total = 0;
      }
    } catch (error) {
      logger.error('Error calling getLogsCount:', error);
      logger.error('Error stack:', error.stack);
      total = 0;
    }

    res.json({
      logs: Array.isArray(logs) ? logs : [],
      total: typeof total === 'number' ? total : 0,
      limit: options.limit,
      offset: options.offset,
    });
  } catch (error) {
    logger.error('Failed to fetch logs:', error);
    res.status(500).json({
      error: 'failed to fetch logs',
      message: error.message,
    });
  }
});

// Log metrics endpoint
router.get('/api/logs/metrics', async (req, res) => {
  try {
    const { timeRange } = req.query;
    const options = {};

    if (timeRange) {
      options.timeRange = parseInt(timeRange, 10);
    }

    const metrics = await getLogMetrics(options);
    res.json(metrics);
  } catch (error) {
    logger.error('Failed to fetch log metrics:', error);
    res.status(500).json({
      error: 'failed to fetch log metrics',
      message: error.message,
    });
  }
});

// Log components endpoint
router.get('/api/logs/components', async (req, res) => {
  try {
    const components = await getLogComponents();
    res.json({ components });
  } catch (error) {
    logger.error('Failed to fetch log components:', error);
    res.status(500).json({
      error: 'failed to fetch log components',
      message: error.message,
    });
  }
});

export default router;
