import { createLogger } from './logger.js';
import { listMediaInR2, deleteExpired, setR2Usage } from './r2-storage.js';
import { insertAlert } from './database.js';
import { readSetting } from './settings.js';
import { ttlHoursForSize } from './upload-tiers.js';

const logger = createLogger('r2-cleanup');

// An object's own size and upload time decide when it goes; nothing about it is recorded.
export function expiredKeys(objects, tiers, now = Date.now()) {
  return objects
    .filter(o => o.lastModified.getTime() + ttlHoursForSize(o.size, tiers) * 3600_000 <= now)
    .map(o => o.key);
}

export async function deleteExpiredR2Files(config) {
  const tiers = await readSetting('upload_ttl_tiers');
  const objects = await listMediaInR2(config);
  const { deleted, failed, bytes } = await deleteExpired(
    objects,
    expiredKeys(objects, tiers),
    config
  );
  setR2Usage(bytes);
  if (failed) {
    logger.error(`R2 cleanup could not delete ${failed} object(s)`);
    // `error` is what groups this into an issue on the webui Issues page.
    await insertAlert({
      severity: 'warning',
      component: 'r2-cleanup',
      title: 'R2 cleanup: deletions failed',
      message: `${failed} expired object(s) could not be deleted and will be retried`,
      metadata: {
        error: 'R2 cleanup could not delete expired files, it retries them on the next run',
        count: failed,
      },
    }).catch(error => logger.error(`Failed to insert alert: ${error.message}`));
  }
  return { deleted, failed };
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
