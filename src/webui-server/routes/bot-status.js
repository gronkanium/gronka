import axios from 'axios';
import express from 'express';
import { createLogger } from '../../utils/logger.js';
import { serverConfig } from '../../utils/config.js';
import { VALID_PRESENCE_STATUSES as VALID_STATUSES } from '../../utils/presence.js';

const logger = createLogger('webui');
const router = express.Router();

const botRequest = {
  validateStatus: () => true,
  transformResponse: [
    body => {
      try {
        return JSON.parse(body);
      } catch {
        return {};
      }
    },
  ],
};

// The bot process owns the Discord client, so this proxies to its stats server (bot.js).
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

  const url = `http://127.0.0.1:${serverConfig.serverPort}/api/bot/status`;

  try {
    const response = await axios.post(url, JSON.stringify({ status, activity }), {
      ...botRequest,
      headers,
    });
    const data = response.data;

    if (response.status < 200 || response.status >= 300) {
      return res.status(response.status).json(data);
    }

    logger.info(
      `Bot presence updated: status=${status || 'unchanged'} activity=${activity || 'none'}`
    );
    res.json(data);
  } catch (error) {
    logger.error('Failed to reach bot process for status update:', error);
    res.status(502).json({ error: 'failed to reach bot process' });
  }
});

router.get('/api/bot/status', async (req, res) => {
  const url = `http://127.0.0.1:${serverConfig.serverPort}/api/bot/status`;

  try {
    const response = await axios.get(url, botRequest);
    const data = response.data;

    if (response.status < 200 || response.status >= 300) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (error) {
    logger.error('Failed to reach bot process for status fetch:', error);
    res.status(502).json({ error: 'failed to reach bot process' });
  }
});

// Avatars and banners ride inline, past axios's default 10MB request body cap.
async function forward(req, res, route) {
  try {
    const response = await axios({
      ...botRequest,
      method: req.method,
      url: `http://127.0.0.1:${serverConfig.serverPort}${route}`,
      data: req.method === 'GET' ? undefined : (req.body ?? {}),
      timeout: 60_000,
      maxBodyLength: Infinity,
    });
    res.status(response.status).json(response.data);
  } catch (error) {
    logger.error(`Failed to reach bot process for ${route}:`, error);
    res.status(502).json({ error: 'failed to reach bot process' });
  }
}

router.get('/api/bot/profile', (req, res) => forward(req, res, '/api/bot/profile'));
router.patch('/api/bot/profile', express.json({ limit: '25mb' }), (req, res) =>
  forward(req, res, '/api/bot/profile')
);

export default router;
