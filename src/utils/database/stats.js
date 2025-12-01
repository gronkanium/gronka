import { getDb, isPostgres } from './connection.js';
import { ensureDbInitialized } from './init.js';
import { ensurePostgresInitialized } from './init-pg.js';
import { getPostgresConnection } from './connection-pg.js';

/**
 * Get 24-hour statistics from processed_urls table
 * @returns {Promise<Object>} Stats object with unique_users, total_files, total_data_bytes
 */
export async function get24HourStats() {
  await ensureDbInitialized();

  try {
    const now = Date.now();
    const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;

    if (isPostgres()) {
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
      const uniqueUsersResult =
        await sql`SELECT COUNT(DISTINCT user_id) AS count FROM processed_urls WHERE processed_at >= ${twentyFourHoursAgo} AND user_id IS NOT NULL`;
      const totalFilesResult =
        await sql`SELECT COUNT(*) AS count FROM processed_urls WHERE processed_at >= ${twentyFourHoursAgo}`;
      const totalDataResult =
        await sql`SELECT SUM(file_size) AS total FROM processed_urls WHERE processed_at >= ${twentyFourHoursAgo} AND file_size IS NOT NULL`;

      const unique_users = parseInt(uniqueUsersResult[0]?.count || 0, 10);
      const total_files = parseInt(totalFilesResult[0]?.count || 0, 10);
      const total_data_bytes = parseInt(totalDataResult[0]?.total || 0, 10);

      return {
        unique_users,
        total_files,
        total_data_bytes,
        timestamp: now,
      };
    }

    // SQLite implementation (existing behavior)
    const db = getDb();
    if (!db) {
      console.error('Database initialization failed.');
      return {
        unique_users: 0,
        total_files: 0,
        total_data_bytes: 0,
        timestamp: now,
      };
    }

    // Count unique users in last 24 hours
    const uniqueUsersStmt = db.prepare(
      'SELECT COUNT(DISTINCT user_id) as count FROM processed_urls WHERE processed_at >= ? AND user_id IS NOT NULL'
    );
    const uniqueUsersResult = uniqueUsersStmt.get(twentyFourHoursAgo);
    const unique_users = uniqueUsersResult?.count || 0;

    // Count total files in last 24 hours
    const totalFilesStmt = db.prepare(
      'SELECT COUNT(*) as count FROM processed_urls WHERE processed_at >= ?'
    );
    const totalFilesResult = totalFilesStmt.get(twentyFourHoursAgo);
    const total_files = totalFilesResult?.count || 0;

    // Sum file sizes in last 24 hours
    const totalDataStmt = db.prepare(
      'SELECT SUM(file_size) as total FROM processed_urls WHERE processed_at >= ? AND file_size IS NOT NULL'
    );
    const totalDataResult = totalDataStmt.get(twentyFourHoursAgo);
    const total_data_bytes = totalDataResult?.total || 0;

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
