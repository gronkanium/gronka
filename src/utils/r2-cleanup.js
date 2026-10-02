import { createLogger } from './logger.js';
import { listMediaInR2, deleteManyFromR2, setR2Usage } from './r2-storage.js';
import { getSetting, insertAlert } from './database.js';
import { ttlHoursForSize, DEFAULT_TTL_TIERS } from './upload-tiers.js';

const logger = createLogger('r2-cleanup');

// An object's own size and upload time decide when it goes; nothing about it is recorded.
export function expiredKeys(objects, tiers, now = Date.now()) {
  return objects
    .filter(o => o.lastModified.getTime() + ttlHoursForSize(o.size, tiers) * 3600_000 <= now)
    .map(o => o.key);
}

export async function deleteExpiredR2Files(config) {
  const tiers = await getSetting('upload_ttl_tiers', DEFAULT_TTL_TIERS);
  const objects = await listMediaInR2(config);
  const expired = expiredKeys(objects, tiers);
  const failed = new Set(await deleteManyFromR2(expired, config));
  const gone = new Set(expired.filter(key => !failed.has(key)));
  setR2Usage(objects.filter(o => !gone.has(o.key)).reduce((sum, o) => sum + o.size, 0));
  if (failed.size) {
    logger.error(`R2 cleanup could not delete ${failed.size} object(s)`);
    await insertAlert({
      timestamp: Date.now(),
      severity: 'warning',
      component: 'r2-cleanup',
      title: 'R2 cleanup: deletions failed',
      message: `${failed.size} expired object(s) could not be deleted and will be retried`,
      metadata: JSON.stringify({ count: failed.size }),
    }).catch(error => logger.error(`Failed to insert alert: ${error.message}`));
  }
  return { deleted: gone.size, failed: failed.size };
}

export function startCleanupJob(config, intervalMs) {
  const run = () =>
    deleteExpiredR2Files(config).catch(error =>
      logger.error(`R2 cleanup failed: ${error.message}`, error)
    );
  run();
  return setInterval(run, intervalMs);
}

export function stopCleanupJob(intervalId) {
  if (intervalId) clearInterval(intervalId);
}
