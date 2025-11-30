import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { createLogger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

const logger = createLogger('kv-stats-sync');

// Debouncing: only sync if last sync was more than 5 minutes ago
const SYNC_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes
let lastSyncTime = 0;
let syncInProgress = false;

/**
 * Trigger stats sync to KV (with debouncing)
 * This function can be called frequently, but will only actually sync
 * if the last sync was more than SYNC_DEBOUNCE_MS ago
 * @returns {Promise<void>}
 */
export async function triggerStatsSync() {
  const now = Date.now();
  const timeSinceLastSync = now - lastSyncTime;

  // If sync is already in progress, skip
  if (syncInProgress) {
    logger.debug('Stats sync already in progress, skipping');
    return;
  }

  // If last sync was recent, skip (debouncing)
  if (timeSinceLastSync < SYNC_DEBOUNCE_MS) {
    logger.debug(`Stats sync debounced (last sync ${Math.round(timeSinceLastSync / 1000)}s ago)`);
    return;
  }

  // Trigger sync
  syncInProgress = true;
  lastSyncTime = now;

  try {
    logger.debug('Triggering stats sync to KV...');

    const syncScript = path.join(projectRoot, 'scripts', 'sync-stats-to-kv.js');

    // Run sync script in background (non-blocking)
    const child = spawn('node', [syncScript], {
      cwd: projectRoot,
      stdio: 'ignore', // Don't log output to avoid spam
      detached: true,
    });

    // Don't wait for completion, let it run in background
    child.unref();

    logger.debug('Stats sync triggered (running in background)');
  } catch (error) {
    logger.error('Failed to trigger stats sync:', error.message);
    // Reset sync flag on error so we can try again
    syncInProgress = false;
  } finally {
    // Reset sync flag after a delay to allow the process to start
    setTimeout(() => {
      syncInProgress = false;
    }, 1000);
  }
}
