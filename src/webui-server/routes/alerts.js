import express from 'express';
import { createLogger } from '../../utils/logger.js';
import { getAlerts, getAlertsCount, getAlertComponents } from '../../utils/database.js';

const logger = createLogger('webui');
const router = express.Router();

// Distinct alert components (for the filter dropdown)
router.get('/api/alerts/components', async (req, res) => {
  try {
    const components = await getAlertComponents();
    res.json({ components });
  } catch (error) {
    logger.error('Failed to fetch alert components:', error);
    res.status(500).json({
      error: 'failed to fetch alert components',
      message: error.message,
    });
  }
});

// Alerts endpoint
router.get('/api/alerts', async (req, res) => {
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

    const alerts = await getAlerts(options);
    const total = await getAlertsCount(options);

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
