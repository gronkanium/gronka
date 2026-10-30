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

const clamp = (value, fallback, min, max) => {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : Math.min(Math.max(n, min), max);
};

function filterOptionsFrom(query) {
  const { severity, component, command, reason, cause, startTime, endTime, search } = query;
  const options = { severity, component, command, reason, cause, search };
  if (startTime) options.startTime = clamp(startTime, 0, 0, Number.MAX_SAFE_INTEGER);
  if (endTime) options.endTime = clamp(endTime, 0, 0, Number.MAX_SAFE_INTEGER);
  return options;
}

// Distinct alert components (for the filter dropdown)
router.get('/api/alerts/components', async (req, res) => {
  try {
    const components = await getAlertComponents();
    res.json({ components });
  } catch (error) {
    logger.error('Failed to fetch alert components:', error);
    res.status(500).json({ error: 'failed to fetch alert components' });
  }
});

// Distinct commands seen in alert metadata (for the filter dropdown)
router.get('/api/alerts/commands', async (req, res) => {
  try {
    const commands = await getAlertCommands();
    res.json({ commands });
  } catch (error) {
    logger.error('Failed to fetch alert commands:', error);
    res.status(500).json({ error: 'failed to fetch alert commands' });
  }
});

// Aggregates across the whole filtered window, so the UI never has to infer
// totals from one page of rows
router.get('/api/alerts/summary', async (req, res) => {
  try {
    const options = filterOptionsFrom(req.query);
    if (req.query.reasonLimit) options.reasonLimit = clamp(req.query.reasonLimit, 25, 1, 200);
    res.json(await getAlertSummary(options));
  } catch (error) {
    logger.error('Failed to fetch alert summary:', error);
    res.status(500).json({ error: 'failed to fetch alert summary' });
  }
});

// Alerts endpoint
router.get('/api/alerts', async (req, res) => {
  try {
    const options = {
      ...filterOptionsFrom(req.query),
      limit: clamp(req.query.limit, 100, 1, 1000),
      offset: clamp(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
    };

    const [alerts, total] = await Promise.all([getAlerts(options), getAlertsCount(options)]);

    res.json({
      alerts,
      total,
      limit: options.limit,
      offset: options.offset,
    });
  } catch (error) {
    logger.error('Failed to fetch alerts:', error);
    res.status(500).json({ error: 'failed to fetch alerts' });
  }
});

export default router;
