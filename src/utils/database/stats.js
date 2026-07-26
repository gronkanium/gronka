import { ensurePostgresInitialized } from './init.js';
import { getPostgresConnection } from './connection.js';

export async function get24HourStats() {
  try {
    const now = Date.now();
    const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;

    // PostgreSQL implementation
    await ensurePostgresInitialized();
    const sql = getPostgresConnection();

    if (!sql) {
      const errorMsg = 'PostgreSQL initialization failed - cannot fetch stats';
      console.error(errorMsg);
      throw new Error(errorMsg);
    }

    // Count unique users in last 24 hours
    const uniqueUsersQuery =
      'SELECT COUNT(DISTINCT user_id) AS count FROM processed_urls WHERE processed_at >= $1 AND user_id IS NOT NULL';
    const uniqueUsersResult = await sql.unsafe(uniqueUsersQuery, [twentyFourHoursAgo]);

    // Count total files in last 24 hours
    const totalFilesQuery = 'SELECT COUNT(*) AS count FROM processed_urls WHERE processed_at >= $1';
    const totalFilesResult = await sql.unsafe(totalFilesQuery, [twentyFourHoursAgo]);

    // Sum file sizes in last 24 hours (SUM returns NULL when no rows match)
    const totalDataQuery =
      'SELECT SUM(file_size) AS total FROM processed_urls WHERE processed_at >= $1 AND file_size IS NOT NULL';
    const totalDataResult = await sql.unsafe(totalDataQuery, [twentyFourHoursAgo]);

    // Parse results - postgres.js returns BIGINT as strings, and SUM can return null
    const unique_users = parseInt(uniqueUsersResult[0]?.count || 0, 10);
    const total_files = parseInt(totalFilesResult[0]?.count || 0, 10);
    // Handle null from SUM() when no rows match - use nullish coalescing
    const total_data_bytes =
      totalDataResult[0]?.total != null ? parseInt(totalDataResult[0].total, 10) : 0;

    // Debug logging to help diagnose issues
    if (process.env.DEBUG_STATS) {
      console.log('get24HourStats debug:', {
        twentyFourHoursAgo,
        now,
        uniqueUsersResult: uniqueUsersResult[0],
        totalFilesResult: totalFilesResult[0],
        totalDataResult: totalDataResult[0],
        parsed: { unique_users, total_files, total_data_bytes },
      });
    }

    return {
      unique_users,
      total_files,
      total_data_bytes,
      timestamp: now,
    };
  } catch (error) {
    console.error('Failed to get 24-hour stats:', error);
    // Re-throw the error instead of silently returning zeros
    // This ensures scripts fail loudly when database connection fails
    throw error;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Get a daily request-count time series from processed_urls, zero-filled for
 * days with no activity.
 * @param {number} [days] - How many trailing days to include (default 14)
 * @returns {Promise<Array<{date: string, count: number}>>} Oldest first
 */
export async function getDailyRequestCounts(days = 14) {
  await ensurePostgresInitialized();
  const sql = getPostgresConnection();

  if (!sql) {
    const errorMsg = 'PostgreSQL initialization failed - cannot fetch daily request counts';
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  const now = Date.now();
  const todayBucket = Math.floor(now / DAY_MS);
  const startBucket = todayBucket - (days - 1);
  const since = startBucket * DAY_MS;

  // processed_at is a plain epoch-ms BIGINT, so bucket by whole UTC days with
  // integer division rather than to_timestamp/to_char (avoids server-timezone
  // ambiguity for a column that isn't a real timestamp type).
  const rows = await sql`
    SELECT FLOOR(processed_at / ${DAY_MS}) AS day_bucket, COUNT(*) AS count
    FROM processed_urls
    WHERE processed_at >= ${since}
    GROUP BY day_bucket
  `;

  const countsByBucket = new Map(
    rows.map(row => [parseInt(row.day_bucket, 10), parseInt(row.count, 10)])
  );

  const series = [];
  for (let bucket = startBucket; bucket <= todayBucket; bucket++) {
    series.push({
      date: new Date(bucket * DAY_MS).toISOString().slice(0, 10),
      count: countsByBucket.get(bucket) || 0,
    });
  }

  return series;
}
