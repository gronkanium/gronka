import { ensurePostgresInitialized } from './init.js';
import { getPostgresConnection } from './connection.js';

/**
 * Get 24-hour statistics from processed_urls table
 * @returns {Promise<Object>} Stats object with unique_users, total_files, total_data_bytes
 */
export async function get24HourStats() {
  try {
    const now = Date.now();
    const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;

    // PostgreSQL implementation
    await ensurePostgresInitialized();
    const sql = getPostgresConnection();

    if (!sql) {
      console.error('PostgreSQL initialization failed.');
      return {
        unique_users: 0,
        total_files: 0,
        total_data_bytes: 0,
        timestamp: now,
      };
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
    return {
      unique_users: 0,
      total_files: 0,
      total_data_bytes: 0,
      timestamp: Date.now(),
    };
  }
}
