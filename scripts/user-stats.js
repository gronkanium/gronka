#!/usr/bin/env node

/**
 * Generate a report of all users and their command success/failure statistics
 *
 * Usage: node scripts/user-stats.js
 */

import Database from 'better-sqlite3';
import { getDbPath, ensureDataDir } from '../src/utils/database/connection.js';
import { initDatabase } from '../src/utils/database/init.js';

/**
 * Extract user ID from log message
 * @param {string} message - Log message
 * @returns {string|null} User ID or null
 */
function extractUserId(message) {
  // Pattern: 'User 123456789 (username) ...'
  const userMatch = message.match(/User (\d+)/);
  if (userMatch) return userMatch[1];

  // Pattern: '... for user 123456789'
  const forUserMatch = message.match(/for user (\d+)/);
  if (forUserMatch) return forUserMatch[1];

  return null;
}

/**
 * Generate user statistics report
 */
async function generateReport() {
  let db;
  try {
    // Ensure database directory exists
    ensureDataDir();

    // Initialize database if needed (creates tables if they don't exist)
    await initDatabase();

    // Get database path using the same logic as the main application
    const dbPath = getDbPath();
    db = new Database(dbPath);

    // Get all users
    const users = db.prepare('SELECT * FROM users ORDER BY last_used DESC').all();

    // Get logs from all components that might have user info
    const logs = db
      .prepare(
        `
      SELECT message, level, timestamp, component
      FROM logs 
      WHERE (message LIKE 'User %' OR message LIKE '%for user %' OR message LIKE '%user %')
      ORDER BY timestamp DESC
    `
      )
      .all();

    // Count commands per user
    const userStats = {};
    users.forEach(u => {
      userStats[u.user_id] = {
        username: u.username,
        first_used: new Date(u.first_used).toISOString(),
        last_used: new Date(u.last_used).toISOString(),
        successful: 0,
        failed: 0,
      };
    });

    logs.forEach(log => {
      const userId = extractUserId(log.message);
      if (!userId || !userStats[userId]) return;

      // WARN counts as failed
      if (log.level === 'WARN') {
        userStats[userId].failed++;
      } else if (log.level === 'ERROR') {
        userStats[userId].failed++;
      } else if (
        log.level === 'INFO' &&
        (log.message.includes('initiated conversion') ||
          log.message.includes('initiated download') ||
          log.message.includes('Successfully saved') ||
          log.message.includes('converted successfully') ||
          log.message.includes('download completed'))
      ) {
        userStats[userId].successful++;
      }
    });

    // Print results
    console.log('='.repeat(140));
    console.log(
      'User ID'.padEnd(20),
      'Username'.padEnd(25),
      'First Used'.padEnd(20),
      'Last Used'.padEnd(20),
      'Success'.padEnd(8),
      'Failed'.padEnd(8),
      'Status'
    );
    console.log('='.repeat(140));

    Object.entries(userStats).forEach(([userId, stats]) => {
      const total = stats.successful + stats.failed;
      let status = 'no commands';
      if (total > 0) {
        if (stats.failed === 0) status = 'all succeeded';
        else if (stats.successful === 0) status = 'all failed';
        else status = 'mixed';
      }

      console.log(
        userId.padEnd(20),
        stats.username.padEnd(25),
        stats.first_used.substring(0, 19).padEnd(20),
        stats.last_used.substring(0, 19).padEnd(20),
        String(stats.successful).padEnd(8),
        String(stats.failed).padEnd(8),
        status
      );
    });

    // Summary
    const totalUsers = Object.keys(userStats).length;
    const allSucceeded = Object.values(userStats).filter(
      s => s.successful > 0 && s.failed === 0
    ).length;
    const allFailed = Object.values(userStats).filter(
      s => s.successful === 0 && s.failed > 0
    ).length;
    const mixed = Object.values(userStats).filter(s => s.successful > 0 && s.failed > 0).length;
    const noCommands = Object.values(userStats).filter(
      s => s.successful === 0 && s.failed === 0
    ).length;

    console.log('='.repeat(140));
    console.log(`\nSummary:`);
    console.log(`  Total users: ${totalUsers}`);
    console.log(`  All commands succeeded: ${allSucceeded}`);
    console.log(`  All commands failed: ${allFailed}`);
    console.log(`  Mixed results: ${mixed}`);
    console.log(`  No commands: ${noCommands}`);
  } catch (error) {
    console.error('Error generating report:', error);
    process.exit(1);
  } finally {
    if (db) {
      db.close();
    }
  }
}

// Run the report
generateReport().catch(error => {
  console.error('Error generating report:', error);
  process.exit(1);
});
