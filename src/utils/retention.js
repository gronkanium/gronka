import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from './logger.js';
import { getPostgresConnection } from './database/connection.js';
import { ensurePostgresInitialized } from './database/init.js';

const logger = createLogger('retention');

// Nothing is kept indefinitely. These tables are append-only histories that accumulate forever
// otherwise — before this job existed the logs table alone held 127k rows going back to install,
// and the local media cache 26 GB with nothing older than the first day ever removed.
//
// The per-user rows in `users` / `user_metrics` are deliberately NOT pruned: they are one row per
// id with counters, not a history, and they are what answers "how many people use the bot".
// Dropping them would lose the only number gronka actually reports about its users.
const TIME_SERIES_TABLES = [
  { table: 'logs', column: 'timestamp' },
  { table: 'operation_logs', column: 'timestamp' },
  { table: 'alerts', column: 'timestamp' },
];

// Content-addressed caches. Nothing in processed_urls points at these (every row is a Discord or
// R2 URL), so a pruned file only costs a re-convert the next time the same input shows up.
const MEDIA_DIRECTORIES = ['gifs', 'videos', 'images'];

const DELETE_BATCH = 5000;

function cutoffMs(days) {
  return Date.now() - days * 24 * 60 * 60 * 1000;
}

/**
 * Delete rows older than `days` from the append-only tables.
 * Batched so a first run against a large backlog cannot hold one long transaction.
 * @returns {Promise<Record<string, number>>} rows deleted per table
 */
export async function pruneTimeSeriesRows(days) {
  await ensurePostgresInitialized();
  const sql = getPostgresConnection();
  if (!sql) {
    logger.warn('No database connection; skipping row retention');
    return {};
  }

  const cutoff = cutoffMs(days);
  const deleted = {};

  for (const { table, column } of TIME_SERIES_TABLES) {
    let removedFromTable = 0;
    for (;;) {
      const result = await sql.unsafe(
        `DELETE FROM ${table} WHERE ctid = ANY(ARRAY(
           SELECT ctid FROM ${table} WHERE ${column} < $1 LIMIT ${DELETE_BATCH}
         ))`,
        [cutoff]
      );
      const removed = result.count ?? 0;
      removedFromTable += removed;
      if (removed < DELETE_BATCH) {
        break;
      }
    }
    deleted[table] = removedFromTable;
  }

  return deleted;
}

/**
 * Delete cache rows older than `days`, but never one whose R2 upload is still live — that would
 * orphan the object in R2 with no tracking row left to expire it, which costs money forever.
 * @returns {Promise<number>} rows deleted
 */
export async function pruneUrlCache(days) {
  await ensurePostgresInitialized();
  const sql = getPostgresConnection();
  if (!sql) {
    return 0;
  }

  const result = await sql`
    DELETE FROM processed_urls
    WHERE processed_at < ${cutoffMs(days)}
      AND NOT EXISTS (
        SELECT 1 FROM temporary_uploads t
        WHERE t.url_hash = processed_urls.url_hash AND t.deleted_at IS NULL
      )
  `;
  return result.count ?? 0;
}

/**
 * Delete cached media files last modified more than `days` ago.
 * @returns {Promise<{files: number, bytes: number}>}
 */
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
  const rows = await pruneTimeSeriesRows(days);
  const cacheRows = await pruneUrlCache(urlCacheDays ?? days);
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
