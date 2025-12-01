import express from 'express';
import { createLogger } from '../../utils/logger.js';
import { getLogMetrics } from '../../utils/database.js';
import { getSystemMetrics } from '../../utils/database.js';
import { collectSystemMetrics } from '../../utils/system-metrics.js';

const logger = createLogger('webui');
const router = express.Router();

// Error metrics endpoint
router.get('/api/metrics/errors', async (req, res) => {
  try {
    const { timeRange } = req.query;
    const options = {
      // Don't exclude webui from error/warning counts - we want to see those!
      // Only exclude webui INFO logs from totals/aggregations to reduce noise
      excludedComponents: null,
    };

    if (timeRange) {
      options.timeRange = parseInt(timeRange, 10);
    }

    let metrics;
    try {
      metrics = await getLogMetrics(options);
      if (metrics === undefined || metrics === null) {
        logger.warn('getLogMetrics returned undefined or null, defaulting to empty object');
        metrics = {};
      }
    } catch (error) {
      logger.error('Error calling getLogMetrics:', error);
      logger.error('Error stack:', error.stack);
      metrics = {};
    }

    res.json(metrics);
  } catch (error) {
    logger.error('Failed to fetch error metrics:', error);
    res.status(500).json({
      error: 'failed to fetch error metrics',
      message: error.message,
    });
  }
});

// System metrics endpoint
router.get('/api/metrics/system', async (req, res) => {
  try {
    const { limit = 100, startTime, endTime } = req.query;

    const options = {
      limit: parseInt(limit, 10),
    };

    if (startTime) options.startTime = parseInt(startTime, 10);
    if (endTime) options.endTime = parseInt(endTime, 10);

    let metrics, current;
    try {
      metrics = await getSystemMetrics(options);
      if (metrics === undefined || metrics === null) {
        logger.warn('getSystemMetrics returned undefined or null, defaulting to empty array');
        metrics = [];
      }
      if (!Array.isArray(metrics)) {
        logger.warn(
          `getSystemMetrics returned non-array: ${typeof metrics}, defaulting to empty array`
        );
        metrics = [];
      }
    } catch (error) {
      logger.error('Error calling getSystemMetrics:', error);
      logger.error('Error stack:', error.stack);
      metrics = [];
    }

    try {
      current = await collectSystemMetrics();
      if (current === undefined || current === null) {
        logger.warn('collectSystemMetrics returned undefined or null, defaulting to empty object');
        current = {};
      }
    } catch (error) {
      logger.error('Error calling collectSystemMetrics:', error);
      logger.error('Error stack:', error.stack);
      current = {};
    }

    res.json({
      current: current || {},
      history: Array.isArray(metrics) ? metrics : [],
    });
  } catch (error) {
    logger.error('Failed to fetch system metrics:', error);
    res.status(500).json({
      error: 'failed to fetch system metrics',
      message: error.message,
    });
  }
});

// System metrics current endpoint
router.get('/api/metrics/system/current', async (req, res) => {
  try {
    const metrics = await collectSystemMetrics();

    res.json(metrics);
  } catch (error) {
    logger.error('Failed to fetch current system metrics:', error);
    res.status(500).json({
      error: 'failed to fetch current system metrics',
      message: error.message,
    });
  }
});

export default router;
