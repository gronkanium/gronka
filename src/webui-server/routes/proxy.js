import express from 'express';
import { createLogger } from '../../utils/logger.js';
import { getStats, getHealth } from '../cache/stats-cache.js';
import { getCryptoPrices } from '../cache/crypto-cache.js';

const logger = createLogger('webui');
const router = express.Router();

// Proxy endpoint to fetch stats from main server
router.get('/api/stats', async (req, res) => {
  try {
    const stats = await getStats();
    res.json(stats);
  } catch (error) {
    logger.error('Failed to fetch stats from main server:', error);
    res.status(500).json({
      error: 'failed to fetch stats',
      message: error.message,
    });
  }
});

// Proxy endpoint to fetch health from main server
router.get('/api/health', async (req, res) => {
  try {
    const health = await getHealth();
    res.json(health);
  } catch (error) {
    logger.error('Failed to fetch health from main server:', error);
    res.status(500).json({
      error: 'failed to fetch health',
      message: error.message,
    });
  }
});

// Crypto prices endpoint with caching
router.get('/api/crypto-prices', async (req, res) => {
  try {
    const prices = await getCryptoPrices();
    res.json(prices);
  } catch (error) {
    logger.error('Failed to fetch crypto prices:', error);
    res.status(500).json({
      error: 'failed to fetch crypto prices',
      message: error.message,
    });
  }
});

export default router;
