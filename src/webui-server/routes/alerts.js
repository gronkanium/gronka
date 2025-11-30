import express from 'express';
import { createLogger } from '../../utils/logger.js';
import { getAlerts, getAlertsCount } from '../../utils/database.js';

const logger = createLogger('webui');
const router = express.Router();

// Alerts endpoint
router.get('/api/alerts', (req, res) => {
  try {
    const { severity, component, startTime, endTime, search, limit = 100, offset = 0 } = req.query;

    const options = {
      severity,
      component,
      search,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
    };

    if (startTime) options.startTime = parseInt(startTime, 10);
    if (endTime) options.endTime = parseInt(endTime, 10);

    const alerts = getAlerts(options);
    const total = getAlertsCount(options);

    res.json({
      alerts,
      total,
      limit: options.limit,
      offset: options.offset,
    });
  } catch (error) {
    logger.error('Failed to fetch alerts:', error);
    res.status(500).json({
      error: 'failed to fetch alerts',
      message: error.message,
    });
  }
});

export default router;
