import express from 'express';
import { createLogger } from '../../utils/logger.js';
import { getAllSettings, setSetting } from '../../utils/database.js';

const logger = createLogger('webui');
const router = express.Router();

// Settings exposed to the webui; add new keys here as features grow
const KNOWN_SETTINGS = {
  url_only_mode: {
    type: 'boolean',
    default: 'false',
    description: 'Reply with the direct media URL from cobalt instead of downloading/uploading',
  },
};

// Get all bot settings (known settings filled with defaults)
router.get('/api/settings', async (req, res) => {
  try {
    const stored = await getAllSettings();
    const settings = {};
    for (const [key, meta] of Object.entries(KNOWN_SETTINGS)) {
      settings[key] = {
        value: stored[key] ?? meta.default,
        type: meta.type,
        description: meta.description,
      };
    }
    res.json({ settings });
  } catch (error) {
    logger.error('Failed to fetch settings:', error);
    res.status(500).json({ error: 'failed to fetch settings', message: error.message });
  }
});

// Update a single setting
router.put('/api/settings/:key', express.json(), async (req, res) => {
  try {
    const { key } = req.params;
    const meta = KNOWN_SETTINGS[key];

    if (!meta) {
      return res.status(404).json({
        error: 'unknown setting',
        message: `"${key}" is not a recognized setting`,
      });
    }

    const { value } = req.body ?? {};
    if (value === undefined) {
      return res.status(400).json({
        error: 'invalid request',
        message: 'value is required in request body',
      });
    }

    let textValue;
    if (meta.type === 'boolean') {
      if (typeof value !== 'boolean' && value !== 'true' && value !== 'false') {
        return res.status(400).json({
          error: 'invalid value',
          message: `"${key}" expects a boolean value`,
        });
      }
      textValue = String(value === true || value === 'true');
    } else {
      textValue = String(value);
    }

    await setSetting(key, textValue);
    logger.info(`Setting updated: ${key} = ${textValue}`);

    res.json({ success: true, key, value: textValue });
  } catch (error) {
    logger.error(`Failed to update setting ${req.params.key}:`, error);
    res.status(500).json({ error: 'failed to update setting', message: error.message });
  }
});

export default router;
