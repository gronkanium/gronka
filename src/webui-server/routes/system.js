import express from 'express';
import { createLogger } from '../../utils/logger.js';
import { jobsOverview, jobsForOperation } from '../../jobs/queue.js';

const logger = createLogger('webui');
const router = express.Router();

router.get('/api/system', async (req, res) => {
  try {
    res.json({ jobs: await jobsOverview(), mediaWorkers: process.env.MEDIA_WORKERS !== 'false' });
  } catch (error) {
    logger.error('Failed to read job queue:', error);
    res.status(500).json({ error: 'failed to read job queue' });
  }
});

router.get('/api/system/jobs/:operationId', async (req, res) => {
  try {
    res.json({ jobs: await jobsForOperation(req.params.operationId) });
  } catch (error) {
    logger.error('Failed to read jobs for operation:', error);
    res.status(500).json({ error: 'failed to read jobs' });
  }
});

export default router;
