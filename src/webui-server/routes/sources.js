import express from 'express';
import { ENGINES, ROUTES, arrangeChain, isEnabled, routeFor } from '../../core/sources.js';
import { readLink, prepareLink } from '../../core/intake.js';
import { DOWNLOAD_SERVICES, getServiceForUrl } from '../../utils/download-services.js';
import { readSetting } from '../../utils/settings.js';
import { createLogger } from '../../utils/logger.js';
import { SOURCE_EXAMPLES } from '../../core/source-examples.js';
import { isRunning, runAndSave, runSourceChecks } from '../../core/source-checks.js';
import { listSourceChecks } from '../../utils/database/source-checks-pg.js';

const logger = createLogger('webui');
const router = express.Router();

const claimed = new Map(ROUTES.flatMap(route => (route.switchIds ?? []).map(id => [id, route.id])));
const routeOfSwitch = service =>
  claimed.get(service.id) ??
  ROUTES.find(route => route.services?.some(s => s.id === service.id))?.id ??
  routeFor(`https://${service.hosts[0]}/`)?.id ??
  null;

const describeRoute = (route, saved, url = null) => ({
  id: route.id,
  name: route.name,
  steps: arrangeChain(route, saved).map(step => ({
    tool: step.engine,
    on: step.on,
    note: step.note ?? null,
    applies: url && step.when ? step.when(url) : null,
  })),
  defaults: arrangeChain(route, {}).map(({ engine, on }) => ({ tool: engine, on })),
});

// Every site switch with the order of tools its links go through.
router.get('/api/sources', async (req, res) => {
  try {
    const saved = await readSetting('source_routes');
    const disabled = new Set(await readSetting('disabled_services'));
    res.json({
      tools: Object.fromEntries(
        Object.entries(ENGINES).map(([id, engine]) => [
          id,
          { name: engine.name, available: isEnabled(engine) },
        ])
      ),
      routes: Object.fromEntries(ROUTES.map(route => [route.id, describeRoute(route, saved)])),
      sites: DOWNLOAD_SERVICES.map(service => ({
        id: service.id,
        label: service.label.replace(' (gallery-dl)', ''),
        category: service.category,
        on: !disabled.has(service.id),
        route: routeOfSwitch(service),
      })),
    });
  } catch (error) {
    logger.error('Failed to read sources:', error);
    res.status(500).json({ error: 'failed to read sources' });
  }
});

// Where a pasted link goes, after the same intake every command uses.
router.get('/api/sources/test', async (req, res) => {
  try {
    const read = readLink(String(req.query.url ?? '').slice(0, 4096));
    if (read.refusal) return res.json({ error: read.refusal.message });
    const url = await prepareLink(read.url);
    const route = routeFor(url);
    res.json({
      url,
      site: getServiceForUrl(url)?.id ?? null,
      route: route ? describeRoute(route, await readSetting('source_routes'), url) : null,
    });
  } catch (error) {
    logger.error('Failed to test a link:', error);
    res.status(500).json({ error: 'failed to test that link' });
  }
});

router.get('/api/sources/checks', async (req, res) => {
  try {
    const rows = new Map((await listSourceChecks()).map(row => [row.url, row]));
    res.json({
      enabled: await readSetting('source_checks'),
      running: isRunning(),
      checks: SOURCE_EXAMPLES.map(example => ({
        ...example,
        result: rows.get(example.url) ?? null,
      })),
    });
  } catch (error) {
    logger.error('Failed to read source checks:', error);
    res.status(500).json({ error: 'failed to read source checks' });
  }
});

// With a url, checks that one example and answers with its result; without, starts a full run.
router.post('/api/sources/checks/run', express.json(), async (req, res) => {
  // A bodiless POST is a CORS "simple request": any page could start a run cross-origin.
  if (!req.is('application/json')) return res.status(415).json({ error: 'json only' });
  try {
    const url = req.body?.url;
    if (url === undefined) {
      if (isRunning()) return res.status(409).json({ error: 'a run is already going' });
      runSourceChecks().catch(error => logger.error('Source check run failed:', error));
      return res.status(202).json({ running: true });
    }
    const example = SOURCE_EXAMPLES.find(e => e.url === url);
    if (!example) return res.status(404).json({ error: 'not one of the example links' });
    res.json(await runAndSave(example));
  } catch (error) {
    logger.error('Failed to run a source check:', error);
    res.status(500).json({ error: 'failed to run the check' });
  }
});

export default router;
