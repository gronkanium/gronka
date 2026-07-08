import express from 'express';
import { createLogger } from '../../utils/logger.js';
import { getAllSettings, setSetting } from '../../utils/database.js';
import { parseTiers } from '../../utils/upload-tiers.js';

const MB = 1024 * 1024;

const logger = createLogger('webui');
const router = express.Router();

// Settings exposed to the webui; add new keys here as features grow
const KNOWN_SETTINGS = {
  url_only_mode: {
    type: 'boolean',
    default: 'false',
    description: 'Reply with the direct media URL from cobalt instead of downloading/uploading',
  },
  twitter_direct_url_fallback: {
    type: 'boolean',
    default: 'true',
    description:
      'When an X/Twitter download fails (e.g. over the size or duration limit), reply with the direct media URL instead of an error',
  },
  twitter_delivery: {
    type: 'select',
    default: 'hybrid',
    options: ['hybrid', 'always_url', 'always_download'],
    description:
      'How /download serves X/Twitter videos: hybrid replies with the direct URL only when the video is too big for a Discord attachment (saves bandwidth and R2 storage), always_url skips downloading whenever a direct URL exists, always_download keeps the old rehost-everything behavior',
  },
  admin_uploads_expire: {
    type: 'boolean',
    default: 'false',
    description:
      'Apply the temporary-upload TTL cleanup to admin R2 uploads too (off = admin uploads are permanent)',
  },
  maintenance_mode: {
    type: 'boolean',
    default: 'false',
    description: 'Disable all commands for non-admins with a maintenance message',
  },
  rate_limit_cooldown: {
    type: 'number',
    default: process.env.RATE_LIMIT || '10',
    description:
      'Seconds a non-admin must wait between commands (bot picks up changes within a minute)',
    min: 1,
    max: 3600,
  },
  ntfy_topic: {
    type: 'string',
    // Read directly from env rather than botConfig: botConfig bundles in DISCORD_TOKEN
    // validation, which webui-only dev/test runs shouldn't need just for this default.
    default: process.env.NTFY_TOPIC || '',
    description: 'ntfy.sh topic to push command/alert notifications to (blank disables ntfy)',
    pattern: /^[A-Za-z0-9_-]{0,64}$/,
  },
  ntfy_server: {
    type: 'string',
    default: 'ntfy.sh',
    description: 'ntfy server hostname (use your own if self-hosting ntfy)',
    pattern: /^[A-Za-z0-9.-]{1,253}$/,
  },
  moderation_enabled: {
    type: 'boolean',
    default: 'false',
    description: 'Enforce user bans (blocks every command for banned users when on)',
  },
  max_video_duration: {
    type: 'number',
    default: '300',
    description: 'Maximum video length in seconds for non-admin downloads (admins are unlimited)',
    min: 30,
    max: 7200,
  },
  upload_ttl_tiers: {
    type: 'tiers',
    default: '100:72,250:24,500:8,1024:2',
    description:
      'Size-based R2 retention: a file is kept for the hours of the first tier whose MB ceiling it fits under, so bigger files are deleted sooner. Bot picks up changes within a minute',
  },
  r2_soft_limit_gb: {
    type: 'number',
    default: '9',
    description:
      'Soft cap (GB) on total live temporary R2 storage. New uploads that would exceed it are rejected with a "storage full" message until files expire. 0 disables the guard',
    min: 0,
    max: 1000,
  },
  admin_user_ids: {
    type: 'list',
    default: '[]',
    description:
      'Admin Discord user IDs (bypass rate limits and size/duration caps). Merged with the ADMIN_USER_IDS env list; bot picks up changes within a minute',
    itemPattern: /^\d{17,20}$/,
    // Env-provided admins are shown read-only next to the editable DB list.
    // Read from env directly (botConfig would require DISCORD_TOKEN in webui-only runs).
    envValues: () =>
      (process.env.ADMIN_USER_IDS || '')
        .split(',')
        .map(id => id.trim())
        .filter(id => id.length > 0),
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
      if (meta.min !== undefined) {
        settings[key].min = meta.min;
        settings[key].max = meta.max;
      }
      if (meta.envValues) {
        settings[key].envValues = meta.envValues();
      }
      if (meta.options) {
        settings[key].options = meta.options;
      }
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
    // Object.hasOwn guards against prototype-chain lookups (e.g. "__proto__", "constructor")
    const meta = Object.hasOwn(KNOWN_SETTINGS, key) ? KNOWN_SETTINGS[key] : undefined;

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
    } else if (meta.type === 'number') {
      const num = Number(value);
      if (
        !Number.isInteger(num) ||
        (meta.min !== undefined && num < meta.min) ||
        (meta.max !== undefined && num > meta.max)
      ) {
        return res.status(400).json({
          error: 'invalid value',
          message: `"${key}" expects an integer between ${meta.min} and ${meta.max}`,
        });
      }
      textValue = String(num);
    } else if (meta.type === 'tiers') {
      // Accept the same MB:hours comma-string the bot consumes, then normalize it through the
      // bot's own parser so validation can never drift from what actually gets applied.
      const tiers = parseTiers(typeof value === 'string' ? value : '');
      if (!tiers || tiers.length === 0) {
        return res.status(400).json({
          error: 'invalid value',
          message: `"${key}" expects comma-separated MB:hours pairs (e.g. 100:72,500:8)`,
        });
      }
      // Re-serialize from the parsed (ascending-sorted) tiers so stored order is canonical.
      textValue = tiers.map(t => `${Math.round(t.maxBytes / MB)}:${t.hours}`).join(',');
    } else if (meta.type === 'select') {
      if (!meta.options.includes(value)) {
        return res.status(400).json({
          error: 'invalid value',
          message: `"${key}" must be one of: ${meta.options.join(', ')}`,
        });
      }
      textValue = value;
    } else if (meta.type === 'list') {
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        return res.status(400).json({
          error: 'invalid value',
          message: `"${key}" expects an array of strings`,
        });
      }
      const items = [...new Set(value.map(item => item.trim()))];
      if (meta.itemPattern && items.some(item => !meta.itemPattern.test(item))) {
        return res.status(400).json({
          error: 'invalid value',
          message: `"${key}" contains an entry with an invalid format`,
        });
      }
      textValue = JSON.stringify(items);
    } else {
      textValue = String(value).trim();
      if (meta.pattern && !meta.pattern.test(textValue)) {
        return res.status(400).json({
          error: 'invalid value',
          message: `"${key}" has an invalid format`,
        });
      }
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
