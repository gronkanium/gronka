import express from 'express';
import { createLogger } from '../../utils/logger.js';
import { serverConfig } from '../../utils/config.js';

const logger = createLogger('webui');
const router = express.Router();

const VALID_STATUSES = ['online', 'idle', 'dnd', 'invisible'];

// Proxies to the bot process's internal stats server (bot.js), which holds the
// live Discord client and actually owns setPresence(). webui-server and the bot
// run as separate processes in the same container - see scripts/docker-entrypoint.sh.
router.post('/api/bot/status', express.json(), async (req, res) => {
  const { status, activity } = req.body ?? {};

  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({
      error: `invalid status "${status}". Must be one of: ${VALID_STATUSES.join(', ')}`,
    });
  }

  if (!status && !activity) {
    return res.status(400).json({ error: 'status or activity is required' });
  }

  const headers = { 'Content-Type': 'application/json' };
  if (serverConfig.statsUsername && serverConfig.statsPassword) {
    const credentials = Buffer.from(
      `${serverConfig.statsUsername}:${serverConfig.statsPassword}`
    ).toString('base64');
    headers['Authorization'] = `Basic ${credentials}`;
  }

  const url = `http://127.0.0.1:${serverConfig.serverPort}/api/bot/status`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ status, activity }),
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    logger.info(
      `Bot presence updated: status=${status || 'unchanged'} activity=${activity || 'none'}`
    );
    res.json(data);
  } catch (error) {
    logger.error('Failed to reach bot process for status update:', error);
    res.status(502).json({ error: 'failed to reach bot process', message: error.message });
  }
});

router.get('/api/bot/status', async (req, res) => {
  const headers = {};
  if (serverConfig.statsUsername && serverConfig.statsPassword) {
    const credentials = Buffer.from(
      `${serverConfig.statsUsername}:${serverConfig.statsPassword}`
    ).toString('base64');
    headers['Authorization'] = `Basic ${credentials}`;
  }

  const url = `http://127.0.0.1:${serverConfig.serverPort}/api/bot/status`;

  try {
    const response = await fetch(url, { headers });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (error) {
    logger.error('Failed to reach bot process for status fetch:', error);
    res.status(502).json({ error: 'failed to reach bot process', message: error.message });
  }
});

export default router;
