import express from 'express';
import { createLogger } from '../../utils/logger.js';
import {
  getAllUsersMetrics,
  getUserMetricsCount,
  getUserMetrics,
  getUserMedia,
  getUserMediaCount,
  searchOperations,
} from '../../utils/database.js';

const logger = createLogger('webui');
const router = express.Router();

// Users list endpoint
router.get('/api/users', async (req, res) => {
  try {
    const {
      search,
      sortBy = 'total_commands',
      sortDesc = 'true',
      limit = 50,
      offset = 0,
    } = req.query;

    const options = {
      search,
      sortBy,
      sortDesc: sortDesc === 'true',
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
    };

    const [users, total] = await Promise.all([
      getAllUsersMetrics(options),
      getUserMetricsCount({ search }),
    ]);
    res.json({ users, total, limit: options.limit, offset: options.offset });
  } catch (error) {
    logger.error('Failed to fetch users:', error);
    res.status(500).json({
      error: 'failed to fetch users',
      message: error.message,
    });
  }
});

// User profile endpoint
router.get('/api/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const userMetrics = await getUserMetrics(userId);
    if (!userMetrics) {
      return res.status(404).json({ error: 'user not found' });
    }
    res.json({ metrics: userMetrics });
  } catch (error) {
    logger.error('Failed to fetch user profile:', error);
    res.status(500).json({
      error: 'failed to fetch user profile',
      message: error.message,
    });
  }
});

router.get('/api/users/:userId/operations', async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 50, offset = 0 } = req.query;
    const { operations, total } = await searchOperations(
      { userId },
      { limit: parseInt(limit, 10), offset: parseInt(offset, 10) }
    );
    res.json({ operations, total });
  } catch (error) {
    logger.error('Failed to fetch user operations:', error);
    res.status(500).json({
      error: 'failed to fetch user operations',
      message: error.message,
    });
  }
});

router.get('/api/users/:userId/media', async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 25, offset = 0 } = req.query;

    const [media, total] = await Promise.all([
      getUserMedia(userId, { limit: parseInt(limit, 10), offset: parseInt(offset, 10) }),
      getUserMediaCount(userId),
    ]);

    res.json({
      media,
      total,
    });
  } catch (error) {
    logger.error(`Failed to fetch user media for user ${req.params.userId}:`, error);
    res.status(500).json({
      error: 'failed to fetch user media',
      message: error.message,
    });
  }
});

export default router;
