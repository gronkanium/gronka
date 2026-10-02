import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from './logger.js';
import { pruneTimeSeriesRows, pruneUrlCache } from './database/retention-pg.js';

const logger = createLogger('retention');

// Nothing is kept indefinitely. These tables are append-only histories that would otherwise
// accumulate forever. Before this job existed the logs table alone held 127k rows going back to
// install day, and the local media cache 26 GB with nothing ever removed.
//
// `user_metrics` is not pruned: one row per id (request and failure counts, first and last use),
// not a history, and the only number gronka reports about its users.

// Content-addressed caches. Nothing in processed_urls points at these (every row is a Discord or
// R2 URL), so a pruned file only costs a re-convert the next time the same input shows up.
const MEDIA_DIRECTORIES = ['gifs', 'videos', 'images'];

function cutoffMs(days) {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

export async function pruneLocalMedia(storagePath, days) {
  const cutoff = cutoffMs(days);
  let files = 0;
  let bytes = 0;

  for (const directory of MEDIA_DIRECTORIES) {
    const full = path.join(storagePath, directory);
    let entries;
    try {
      entries = await fs.readdir(full);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.warn(`Could not read ${full}: ${error.message}`);
      }
      continue;
    }

    for (const entry of entries) {
      const target = path.join(full, entry);
      try {
        const stats = await fs.stat(target);
        if (!stats.isFile() || stats.mtimeMs >= cutoff) {
          continue;
        }
        await fs.unlink(target);
        files += 1;
        bytes += stats.size;
      } catch (error) {
        // A file deleted by another path between stat and unlink is not an error worth raising.
        if (error.code !== 'ENOENT') {
          logger.warn(`Could not remove ${target}: ${error.message}`);
        }
      }
    }
  }

  return { files, bytes };
}

const mb = bytes => (bytes / (1024 * 1024)).toFixed(1);

export async function runRetention({ days, mediaDays, urlCacheDays, storagePath }) {
  const started = Date.now();
  const rows = await pruneTimeSeriesRows(cutoffMs(days));
  const cacheRows = await pruneUrlCache(cutoffMs(urlCacheDays ?? days));
  const media = await pruneLocalMedia(storagePath, mediaDays);

  const rowSummary = Object.entries(rows)
    .map(([table, count]) => `${table} ${count}`)
    .join(', ');
  logger.info(
    `Retention: removed ${rowSummary}, processed_urls ${cacheRows}, ` +
      `${media.files} media file(s) (${mb(media.bytes)}MB) in ${Date.now() - started}ms`
  );

  return { rows, cacheRows, media };
}

export function startRetentionJob({ days, mediaDays, urlCacheDays, storagePath, intervalMs }) {
  logger.info(
    `Starting retention job (rows ${days}d, media ${mediaDays}d, url cache ${urlCacheDays}d, ` +
      `interval ${intervalMs}ms)`
  );

  const run = () =>
    runRetention({ days, mediaDays, urlCacheDays, storagePath }).catch(error => {
      logger.error(`Retention job failed: ${error.message}`, error);
    });

  run();
  return setInterval(run, intervalMs);
}

export function stopRetentionJob(intervalId) {
  if (intervalId) {
    clearInterval(intervalId);
    logger.info('Stopped retention job');
  }
}
