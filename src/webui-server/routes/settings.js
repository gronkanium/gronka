import express from 'express';
import { createLogger } from '../../utils/logger.js';
import { getAllSettings, setSetting } from '../../utils/database.js';
import { parseTiers } from '../../utils/upload-tiers.js';
import { SETTINGS } from '../../utils/settings.js';
import { ROUTES, arrangeChain } from '../../core/sources.js';
import { DOWNLOAD_SERVICES, DOWNLOAD_SERVICE_IDS } from '../../utils/download-services.js';

const MB = 1024 * 1024;

const logger = createLogger('webui');
const router = express.Router();

// { [issueKey]: { state: 'muted', until } | { state: 'resolved', at } }
function parseIssueStates(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 500) return null;
  const states = entries.map(([key, s]) => {
    if (key.length > 300 || !s || typeof s !== 'object') return null;
    if (s.state === 'muted' && Number.isFinite(s.until))
      return [key, { state: 'muted', until: s.until }];
    if (s.state === 'resolved' && Number.isFinite(s.at))
      return [key, { state: 'resolved', at: s.at }];
    return null;
  });
  return states.includes(null) ? null : Object.fromEntries(states);
}

// Get all bot settings (known settings filled with defaults)
router.get('/api/settings', async (req, res) => {
  try {
    const stored = await getAllSettings();
    const settings = {};
    for (const [key, meta] of Object.entries(SETTINGS)) {
      settings[key] = {
        value: stored[key] ?? meta.default,
        type: meta.type,
        label: meta.label,
        section: meta.section,
        description: meta.description,
      };
      if (meta.min !== undefined) {
        settings[key].min = meta.min;
        settings[key].max = meta.max;
      }
      if (meta.options) {
        settings[key].options = meta.options;
      }
      if (meta.type === 'services') {
        // Ship the full catalog so the UI can render grouped toggles without a 2nd request.
        settings[key].catalog = DOWNLOAD_SERVICES.map(({ id, label, category }) => ({
          id,
          label,
          category,
        }));
      }
    }
    res.json({ settings });
  } catch (error) {
    logger.error('Failed to fetch settings:', error);
    res.status(500).json({ error: 'failed to fetch settings' });
  }
});

// Update a single setting
router.put('/api/settings/:key', express.json(), async (req, res) => {
  try {
    const { key } = req.params;
    // Object.hasOwn guards against prototype-chain lookups (e.g. "__proto__", "constructor")
    const meta = Object.hasOwn(SETTINGS, key) ? SETTINGS[key] : undefined;

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
      const num =
        typeof value === 'number' || (typeof value === 'string' && value.trim())
          ? Number(value)
          : NaN;
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
    } else if (meta.type === 'services') {
      // Array of disabled service ids. Silently drop unknown ids (a service removed from
      // the registry shouldn't wedge the whole save) and store a canonical sorted set.
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        return res.status(400).json({
          error: 'invalid value',
          message: `"${key}" expects an array of service ids`,
        });
      }
      const ids = [...new Set(value)].filter(id => DOWNLOAD_SERVICE_IDS.has(id)).sort();
      textValue = JSON.stringify(ids);
    } else if (meta.type === 'routes') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return res.status(400).json({
          error: 'invalid value',
          message: `"${key}" expects { route: [{ engine, on }] }`,
        });
      }
      const saved = {};
      for (const route of ROUTES) {
        if (!Array.isArray(value[route.id])) continue;
        const steps = arrangeChain(route, value).map(({ engine, on }) => ({ engine, on }));
        const defaults = arrangeChain(route, {}).map(({ engine, on }) => ({ engine, on }));
        if (JSON.stringify(steps) !== JSON.stringify(defaults)) saved[route.id] = steps;
      }
      textValue = JSON.stringify(saved);
    } else if (meta.type === 'issuestates') {
      const states = parseIssueStates(value);
      if (!states) {
        return res.status(400).json({
          error: 'invalid value',
          message: `"${key}" expects { key: { state: 'muted', until } | { state: 'resolved', at } }`,
        });
      }
      textValue = JSON.stringify(states);
    } else {
      return res.status(400).json({ error: 'invalid value', message: `"${key}" is read-only` });
    }

    await setSetting(key, textValue);
    logger.info(`Setting updated: ${key} = ${textValue}`);

    res.json({ success: true, key, value: textValue });
  } catch (error) {
    logger.error(`Failed to update setting ${req.params.key}:`, error);
    res.status(500).json({ error: 'failed to update setting' });
  }
});

export default router;
