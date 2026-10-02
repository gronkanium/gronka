import { createLogger } from './logger.js';
import { pruneTimeSeriesRows } from './database/retention-pg.js';

const logger = createLogger('retention');

// Nothing is kept indefinitely: logs, operation records and alerts go after RETENTION_DAYS.
// No media and no per-user history is stored, so there is nothing else to prune.

export async function runRetention({ days }) {
  const started = Date.now();
  const rows = await pruneTimeSeriesRows(Date.now() - days * 24 * 60 * 60 * 1000);
  const summary = Object.entries(rows)
    .map(([table, count]) => `${table} ${count}`)
    .join(', ');
  logger.info(`Retention: removed ${summary} in ${Date.now() - started}ms`);
  return { rows };
}

export function startRetentionJob({ days, intervalMs }) {
  const run = () =>
    runRetention({ days }).catch(error => {
      logger.error(`Retention job failed: ${error.message}`, error);
    });
  run();
  return setInterval(run, intervalMs);
}

export function stopRetentionJob(intervalId) {
  if (intervalId) clearInterval(intervalId);
}
