import express from 'express';
import { createLogger } from '../../utils/logger.js';
import {
  getAllUsersMetrics,
  getUserMetricsCount,
  getUserMetrics,
  getUser,
  getUserMedia,
  getUserMediaCount,
  getRecentOperations,
} from '../../utils/database.js';
import { getLogs, getLogsCount } from '../../utils/database.js';
import { operations } from '../operations/storage.js';

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

    let users, total;
    try {
      users = await getAllUsersMetrics(options);
      logger.info(
        `getAllUsersMetrics returned: type=${typeof users}, isArray=${Array.isArray(users)}, length=${users?.length}, value=${JSON.stringify(users).substring(0, 200)}`
      );
    } catch (error) {
      logger.error('Error calling getAllUsersMetrics:', error);
      users = [];
    }

    try {
      total = await getUserMetricsCount({ search });
      logger.info(`getUserMetricsCount returned: type=${typeof total}, value=${total}`);
    } catch (error) {
      logger.error('Error calling getUserMetricsCount:', error);
      total = 0;
    }

    // Ensure users is always an array
    const usersArray = Array.isArray(users) ? users : [];
    const totalCount = typeof total === 'number' ? total : 0;

    logger.info(`Sending response: users.length=${usersArray.length}, total=${totalCount}`);

    res.json({
      users: usersArray,
      total: totalCount,
      limit: options.limit,
      offset: options.offset,
    });
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
    const userInfo = await getUser(userId);

    if (!userMetrics && !userInfo) {
      return res.status(404).json({ error: 'user not found' });
    }

    res.json({
      user: userInfo,
      metrics: userMetrics,
    });
  } catch (error) {
    logger.error('Failed to fetch user profile:', error);
    res.status(500).json({
      error: 'failed to fetch user profile',
      message: error.message,
    });
  }
});

// User operations endpoint (from recent operations in memory and database)
router.get('/api/users/:userId/operations', async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 50, offset = 0 } = req.query;
    const limitNum = parseInt(limit, 10);
    const offsetNum = parseInt(offset, 10);

    // Filter operations by user from in-memory store
    let userOps = operations.filter(op => op.userId === userId);

    // Get operations from database to ensure we have all of them for counting
    try {
      // Get a large number of operations from database to account for filtering
      const dbOps = (await getRecentOperations(1000)) // Get enough to account for filtering
        .filter(op => op.userId === userId);

      // Merge with in-memory operations, avoiding duplicates
      const existingIds = new Set(userOps.map(op => op.id));
      const newOps = dbOps.filter(op => !existingIds.has(op.id));
      userOps = [...userOps, ...newOps].sort((a, b) => b.timestamp - a.timestamp); // Sort by most recent
    } catch (error) {
      logger.error('Failed to fetch user operations from database:', error);
      // Continue with in-memory operations only
      userOps = userOps.sort((a, b) => b.timestamp - a.timestamp);
    }

    // Get total count before applying pagination
    const total = userOps.length;

    // Apply pagination (offset and limit)
    const paginatedOps = userOps.slice(offsetNum, offsetNum + limitNum);

    res.json({
      operations: paginatedOps,
      total: total,
    });
  } catch (error) {
    logger.error('Failed to fetch user operations:', error);
    res.status(500).json({
      error: 'failed to fetch user operations',
      message: error.message,
    });
  }
});

// User activity timeline (from logs)
router.get('/api/users/:userId/activity', async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 100, offset = 0 } = req.query;

    // Get logs related to this user, only from bot component (user actions)
    const logs = await getLogs({
      search: userId,
      component: 'bot', // Only show bot component logs (user commands and actions)
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
      orderDesc: true,
    });

    const total = await getLogsCount({
      search: userId,
      component: 'bot', // Only count bot component logs
    });

    res.json({
      activity: logs,
      total,
    });
  } catch (error) {
    logger.error('Failed to fetch user activity:', error);
    res.status(500).json({
      error: 'failed to fetch user activity',
      message: error.message,
    });
  }
});

// User media endpoint (from processed_urls)
router.get('/api/users/:userId/media', async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 25, offset = 0 } = req.query;

    logger.debug(`Fetching media for user ${userId} (limit: ${limit}, offset: ${offset})`);

    // Get media files for this user
    const media = await getUserMedia(userId, {
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
    });

    const total = await getUserMediaCount(userId);

    logger.debug(`Found ${media.length} media items (total: ${total}) for user ${userId}`);

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
