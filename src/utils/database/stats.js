import { ensurePostgresInitialized } from './init.js';
import { getPostgresConnection } from './connection.js';

export async function get24HourStats() {
  const now = Date.now();
  const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;

  await ensurePostgresInitialized();
  const sql = getPostgresConnection();

  const [row] = await sql`
    SELECT COUNT(DISTINCT user_id)::int AS unique_users, COUNT(*)::int AS total_files,
      COALESCE(SUM(file_size), 0)::bigint AS total_data_bytes
    FROM processed_urls WHERE processed_at >= ${twentyFourHoursAgo}
  `;

  return {
    unique_users: row.unique_users,
    total_files: row.total_files,
    total_data_bytes: Number(row.total_data_bytes),
    timestamp: now,
  };
}

const HOUR_MS = 60 * 60 * 1000;

// Get an hourly request-count time series from processed_urls, zero-filled for hours with no activity
export async function getHourlyRequestCounts(hours = 24) {
  await ensurePostgresInitialized();
  const sql = getPostgresConnection();

  const now = Date.now();
  const currentBucket = Math.floor(now / HOUR_MS);
  const startBucket = currentBucket - (hours - 1);
  const since = startBucket * HOUR_MS;

  // processed_at is a plain epoch-ms BIGINT, so bucket by whole UTC hours with
  // integer division rather than to_timestamp/to_char (avoids server-timezone
  // ambiguity for a column that isn't a real timestamp type).
  const rows = await sql`
    SELECT FLOOR(processed_at / ${HOUR_MS}) AS hour_bucket, COUNT(*) AS count
    FROM processed_urls
    WHERE processed_at >= ${since}
    GROUP BY hour_bucket
  `;

  const countsByBucket = new Map(
    rows.map(row => [parseInt(row.hour_bucket, 10), parseInt(row.count, 10)])
  );

  const series = [];
  for (let bucket = startBucket; bucket <= currentBucket; bucket++) {
    series.push({
      hour: new Date(bucket * HOUR_MS).toISOString(),
      count: countsByBucket.get(bucket) || 0,
    });
  }

  return series;
}
