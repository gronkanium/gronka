import express from 'express';
import { createLogger } from '../../utils/logger.js';
import {
  getUsageAnalytics,
  getPerformanceAnalytics,
  getUserAnalytics,
} from '../../utils/database.js';

const logger = createLogger('webui');
const router = express.Router();

// Usage analytics endpoint
router.get('/api/analytics/usage', async (req, res) => {
  try {
    const { interval = 'daily', startTime, endTime } = req.query;

    const options = {
      interval,
      startTime: startTime ? parseInt(startTime, 10) : Date.now() - 7 * 24 * 60 * 60 * 1000,
      endTime: endTime ? parseInt(endTime, 10) : Date.now(),
    };

    const data = await getUsageAnalytics(options);
    res.json(data);
  } catch (error) {
    logger.error('Failed to fetch usage analytics:', error);
    res.status(500).json({
      error: 'failed to fetch usage analytics',
      message: error.message,
    });
  }
});

// Performance analytics endpoint
router.get('/api/analytics/performance', async (req, res) => {
  try {
    const { startTime, endTime } = req.query;

    const options = {
      startTime: startTime ? parseInt(startTime, 10) : Date.now() - 7 * 24 * 60 * 60 * 1000,
      endTime: endTime ? parseInt(endTime, 10) : Date.now(),
    };

    const data = await getPerformanceAnalytics(options);
    res.json(data);
  } catch (error) {
    logger.error('Failed to fetch performance analytics:', error);
    res.status(500).json({
      error: 'failed to fetch performance analytics',
      message: error.message,
    });
  }
});

// User analytics endpoint
router.get('/api/analytics/users', async (req, res) => {
  try {
    const { startTime, endTime, limit = 10 } = req.query;

    const options = {
      startTime: startTime ? parseInt(startTime, 10) : Date.now() - 7 * 24 * 60 * 60 * 1000,
      endTime: endTime ? parseInt(endTime, 10) : Date.now(),
      limit: parseInt(limit, 10),
    };

    const data = await getUserAnalytics(options);
    res.json(data);
  } catch (error) {
    logger.error('Failed to fetch user analytics:', error);
    res.status(500).json({
      error: 'failed to fetch user analytics',
      message: error.message,
    });
  }
});

export default router;
