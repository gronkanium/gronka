import express from 'express';
import { createLogger } from '../../utils/logger.js';
import {
  getAlerts,
  getAlertsCount,
  getAlertComponents,
  getAlertCommands,
  getAlertSummary,
} from '../../utils/database.js';

const logger = createLogger('webui');
const router = express.Router();

function filterOptionsFrom(query) {
  const { severity, component, command, reason, startTime, endTime, search } = query;
  const options = { severity, component, command, reason, search };
  if (startTime) options.startTime = parseInt(startTime, 10);
  if (endTime) options.endTime = parseInt(endTime, 10);
  return options;
}

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

// Distinct commands seen in alert metadata (for the filter dropdown)
router.get('/api/alerts/commands', async (req, res) => {
  try {
    const commands = await getAlertCommands();
    res.json({ commands });
  } catch (error) {
    logger.error('Failed to fetch alert commands:', error);
    res.status(500).json({
      error: 'failed to fetch alert commands',
      message: error.message,
    });
  }
});

// Aggregates across the whole filtered window, so the UI never has to infer
// totals from one page of rows
router.get('/api/alerts/summary', async (req, res) => {
  try {
    const options = filterOptionsFrom(req.query);
    if (req.query.reasonLimit) options.reasonLimit = parseInt(req.query.reasonLimit, 10);
    res.json(await getAlertSummary(options));
  } catch (error) {
    logger.error('Failed to fetch alert summary:', error);
    res.status(500).json({
      error: 'failed to fetch alert summary',
      message: error.message,
    });
  }
});

// Alerts endpoint
router.get('/api/alerts', async (req, res) => {
  try {
    const { limit = 100, offset = 0 } = req.query;

    const options = {
      ...filterOptionsFrom(req.query),
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
    };

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
