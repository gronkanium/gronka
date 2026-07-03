import express from 'express';
import { createLogger } from '../../utils/logger.js';
import { listBans, getBan, banUser, unbanUser } from '../../utils/database.js';

const logger = createLogger('webui');
const router = express.Router();

// List all bans
router.get('/api/bans', async (req, res) => {
  try {
    const bans = await listBans();
    res.json({ bans });
  } catch (error) {
    logger.error('Failed to fetch bans:', error);
    res.status(500).json({ error: 'failed to fetch bans', message: error.message });
  }
});

// Ban a user (upsert - re-banning updates the reason/appeal)
router.post('/api/bans', express.json(), async (req, res) => {
  try {
    const { userId, reason, appealAllowed = true } = req.body ?? {};

    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      return res.status(400).json({ error: 'invalid request', message: 'userId is required' });
    }
    if (!reason || typeof reason !== 'string' || reason.trim() === '') {
      return res.status(400).json({ error: 'invalid request', message: 'reason is required' });
    }

    await banUser(userId.trim(), reason.trim(), appealAllowed !== false);

    logger.info(`User ${userId} banned via webui`);

    const ban = await getBan(userId.trim());
    res.json({ success: true, ban });
  } catch (error) {
    logger.error('Failed to ban user:', error);
    res.status(500).json({ error: 'failed to ban user', message: error.message });
  }
});

// Unban a user
router.delete('/api/bans/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const deleted = await unbanUser(userId);

    if (!deleted) {
      return res.status(404).json({ error: 'not found', message: 'User is not banned' });
    }

    logger.info(`User ${userId} unbanned via webui`);

    res.json({ success: true });
  } catch (error) {
    logger.error(`Failed to unban user ${req.params.userId}:`, error);
    res.status(500).json({ error: 'failed to unban user', message: error.message });
  }
});

export default router;
