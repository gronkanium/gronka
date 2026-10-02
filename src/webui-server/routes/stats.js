import express from 'express';
import { createLogger } from '../../utils/logger.js';
import { getStorageStats } from '../../utils/storage.js';
import { getCommandTotals, getHourlyCounts } from '../../utils/database.js';

const logger = createLogger('webui');
const router = express.Router();

// Anonymous totals only: command runs by outcome, hourly for a day, and what R2 holds right now.
router.get('/api/stats', async (req, res) => {
  try {
    const day = Date.now() - 24 * 3600e3;
    const [storage, allTime, lastDay, hourly] = await Promise.all([
      getStorageStats(),
      getCommandTotals(),
      getCommandTotals(day),
      getHourlyCounts(24),
    ]);
    res.json({ storage, commands: { allTime, lastDay }, hourly });
  } catch (error) {
    logger.error('Failed to read stats:', error);
    res.status(500).json({ error: 'failed to read stats' });
  }
});

export default router;
