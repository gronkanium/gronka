import express from 'express';
import { createLogger } from '../../utils/logger.js';
import {
  getLogs,
  getLogsCount,
  getLogComponents,
  getLogFacets,
  getLogHistogram,
  LOG_FIELDS,
} from '../../utils/database.js';

const logger = createLogger('webui');
const router = express.Router();

const list = value =>
  [value]
    .flat()
    .filter(v => typeof v === 'string')
    .flatMap(v => v.split(','))
    .map(v => v.trim())
    .filter(Boolean);

const int = value => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
};

// Shared by list, facets and histogram so all three always describe the same set of lines.
function filtersFrom(query) {
  const fields = {};
  for (const key of LOG_FIELDS) {
    const values = list(query[key]);
    if (values.length) fields[key] = values;
  }
  return {
    component: list(query.component),
    level: list(query.level).map(l => l.toUpperCase()),
    excludedComponents: list(query.excludedComponents),
    startTime: int(query.startTime),
    endTime: int(query.endTime),
    search: typeof query.search === 'string' && query.search ? query.search : null,
    fields,
    // webui's own INFO lines are HTTP request noise
    excludeComponentLevels: [{ component: 'webui', level: 'INFO' }],
  };
}

router.get('/api/logs', async (req, res) => {
  try {
    const options = {
      ...filtersFrom(req.query),
      orderDesc: req.query.orderDesc !== 'false',
      limit: Math.min(int(req.query.limit) ?? 100, 1000),
      offset: int(req.query.offset) ?? 0,
    };
    const [logs, total] = await Promise.all([getLogs(options), getLogsCount(options)]);
    res.json({ logs, total, limit: options.limit, offset: options.offset });
  } catch (error) {
    logger.error('Failed to fetch logs:', error);
    res.status(500).json({ error: 'failed to fetch logs' });
  }
});

router.get('/api/logs/facets', async (req, res) => {
  try {
    res.json({ facets: await getLogFacets(filtersFrom(req.query)) });
  } catch (error) {
    logger.error('Failed to fetch log facets:', error);
    res.status(500).json({ error: 'failed to fetch log facets' });
  }
});

router.get('/api/logs/histogram', async (req, res) => {
  try {
    const filters = filtersFrom(req.query);
    filters.startTime ??= Date.now() - 24 * 3600 * 1000;
    const buckets = Math.min(Math.max(int(req.query.buckets) ?? 48, 1), 200);
    res.json(await getLogHistogram(filters, buckets));
  } catch (error) {
    logger.error('Failed to fetch log histogram:', error);
    res.status(500).json({ error: 'failed to fetch log histogram' });
  }
});

router.get('/api/logs/components', async (req, res) => {
  try {
    res.json({ components: await getLogComponents() });
  } catch (error) {
    logger.error('Failed to fetch log components:', error);
    res.status(500).json({ error: 'failed to fetch log components' });
  }
});

export default router;
