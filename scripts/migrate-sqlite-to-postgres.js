#!/usr/bin/env node

/**
 * Migration script to migrate data from SQLite to PostgreSQL
 *
 * Usage:
 *   node scripts/migrate-sqlite-to-postgres.js [options]
 *
 * Options:
 *   --sqlite-path <path>    Path to SQLite database file (default: from GRONKA_DB_PATH or data-prod/gronka.db)
 *   --dry-run               Perform a dry run without actually migrating data
 *   --skip-backup           Skip creating SQLite backup
 */

import Database from 'better-sqlite3';
import postgres from 'postgres';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../');

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipBackup = args.includes('--skip-backup');

const sqlitePathIndex = args.indexOf('--sqlite-path');
const sqlitePath =
  sqlitePathIndex >= 0 && args[sqlitePathIndex + 1]
    ? args[sqlitePathIndex + 1]
    : process.env.GRONKA_DB_PATH || path.join(projectRoot, 'data-prod', 'gronka.db');

// Get PostgreSQL connection config
function getPostgresConfig() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  return {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'gronka',
    username: process.env.POSTGRES_USER || 'gronka',
    password: process.env.POSTGRES_PASSWORD || 'gronka',
  };
}

async function createBackup(sqlitePath) {
  if (skipBackup) {
    console.log('Skipping backup creation (--skip-backup flag set)');
    return;
  }

  const backupPath = `${sqlitePath}.backup.${Date.now()}`;
  console.log(`Creating backup: ${backupPath}`);
  await fs.copyFile(sqlitePath, backupPath);
  console.log(`Backup created: ${backupPath}`);
}

async function migrateTable(sqliteDb, pgSql, tableName, transformRow = null) {
  console.log(`Migrating table: ${tableName}`);

  // Get all rows from SQLite
  const rows = sqliteDb.prepare(`SELECT * FROM ${tableName}`).all();
  console.log(`  Found ${rows.length} rows`);

  if (rows.length === 0) {
    console.log(`  No data to migrate`);
    return { count: 0, errors: [] };
  }

  let inserted = 0;
  const errors = [];

  // Get column names from first row
  const columns = Object.keys(rows[0]);

  for (const row of rows) {
    try {
      // Transform row if transform function provided
      const transformedRow = transformRow ? transformRow(row) : row;

      // Build INSERT query
      const columnNames = columns.join(', ');
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      const values = columns.map(col => transformedRow[col]);

      if (!dryRun) {
        await pgSql.unsafe(
          `INSERT INTO ${tableName} (${columnNames}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
          values
        );
      }
      inserted++;
    } catch (error) {
      errors.push({ row, error: error.message });
      console.error(`  Error inserting row: ${error.message}`);
    }
  }

  console.log(
    `  Migrated ${inserted} rows${errors.length > 0 ? ` (${errors.length} errors)` : ''}`
  );
  return { count: inserted, errors };
}

async function main() {
  console.log('SQLite to PostgreSQL Migration Script');
  console.log('=====================================\n');

  if (dryRun) {
    console.log('DRY RUN MODE - No data will be migrated\n');
  }

  // Check SQLite database exists
  try {
    await fs.access(sqlitePath);
  } catch (_error) {
    console.error(`Error: SQLite database not found at ${sqlitePath}`);
    process.exit(1);
  }

  console.log(`SQLite database: ${sqlitePath}`);
  console.log(`PostgreSQL config: ${JSON.stringify(getPostgresConfig(), null, 2)}\n`);

  // Create backup
  if (!dryRun) {
    await createBackup(sqlitePath);
  }

  // Open SQLite database
  const sqliteDb = new Database(sqlitePath);

  // Connect to PostgreSQL
  const pgConfig = getPostgresConfig();
  const pgSql = postgres(pgConfig);

  try {
    // Test PostgreSQL connection
    await pgSql`SELECT 1`;
    console.log('PostgreSQL connection successful\n');

    // Initialize PostgreSQL schema if needed
    console.log('Ensuring PostgreSQL schema is initialized...');
    const { initPostgresDatabase } = await import('../src/utils/database/init-pg.js');
    await initPostgresDatabase();
    console.log('PostgreSQL schema ready\n');

    // Migrate tables in order (respecting foreign key constraints)
    const results = {};

    // 1. users (no dependencies)
    results.users = await migrateTable(sqliteDb, pgSql, 'users');

    // 2. processed_urls (no dependencies)
    results.processed_urls = await migrateTable(sqliteDb, pgSql, 'processed_urls');

    // 3. logs (no dependencies)
    results.logs = await migrateTable(sqliteDb, pgSql, 'logs');

    // 4. operation_logs (no dependencies)
    results.operation_logs = await migrateTable(sqliteDb, pgSql, 'operation_logs');

    // 5. user_metrics (no dependencies)
    results.user_metrics = await migrateTable(sqliteDb, pgSql, 'user_metrics');

    // 6. system_metrics (no dependencies)
    results.system_metrics = await migrateTable(sqliteDb, pgSql, 'system_metrics');

    // 7. alerts (no dependencies)
    results.alerts = await migrateTable(sqliteDb, pgSql, 'alerts');

    // 8. temporary_uploads (depends on processed_urls)
    results.temporary_uploads = await migrateTable(sqliteDb, pgSql, 'temporary_uploads');

    // Summary
    console.log('\n=====================================');
    console.log('Migration Summary');
    console.log('=====================================');
    let totalRows = 0;
    let totalErrors = 0;
    for (const [table, result] of Object.entries(results)) {
      console.log(
        `${table}: ${result.count} rows migrated${result.errors.length > 0 ? `, ${result.errors.length} errors` : ''}`
      );
      totalRows += result.count;
      totalErrors += result.errors.length;
    }
    console.log(`\nTotal: ${totalRows} rows migrated, ${totalErrors} errors`);

    // Verify data integrity
    console.log('\nVerifying data integrity...');
    for (const [table, _result] of Object.entries(results)) {
      const sqliteCount = sqliteDb.prepare(`SELECT COUNT(*) as count FROM ${table}`).get().count;
      const pgCountResult = await pgSql.unsafe(`SELECT COUNT(*) as count FROM ${table}`);
      const pgCount = parseInt(pgCountResult[0]?.count || 0, 10);
      const match = sqliteCount === pgCount;
      console.log(`  ${table}: SQLite=${sqliteCount}, PostgreSQL=${pgCount} ${match ? '✓' : '✗'}`);
      if (!match) {
        console.warn(`    WARNING: Row count mismatch for ${table}`);
      }
    }

    // Reset SERIAL sequences to match migrated data (fixes duplicate key errors)
    if (!dryRun) {
      console.log('\nResetting SERIAL sequences...');
      await resetSerialSequences(pgSql);
    }

    if (dryRun) {
      console.log('\nDry run completed. No data was actually migrated.');
    } else {
      console.log('\nMigration completed successfully!');
    }
  } catch (error) {
    console.error('\nMigration failed:', error);
    process.exit(1);
  } finally {
    sqliteDb.close();
    await pgSql.end();
  }
}

/**
 * Reset SERIAL sequences to match the maximum ID in each table
 * This fixes duplicate key errors after data migration
 * @param {Object} pgSql - The postgres.js client instance
 * @returns {Promise<void>}
 */
async function resetSerialSequences(pgSql) {
  const tablesWithSerial = [
    { table: 'logs', sequence: 'logs_id_seq', column: 'id' },
    { table: 'operation_logs', sequence: 'operation_logs_id_seq', column: 'id' },
    { table: 'system_metrics', sequence: 'system_metrics_id_seq', column: 'id' },
    { table: 'alerts', sequence: 'alerts_id_seq', column: 'id' },
    { table: 'temporary_uploads', sequence: 'temporary_uploads_id_seq', column: 'id' },
  ];

  for (const { table, sequence, column } of tablesWithSerial) {
    try {
      // Get the maximum ID from the table
      const maxQuery = `SELECT COALESCE(MAX(${column}), 0) as max_id FROM ${table}`;
      const maxResult = await pgSql.unsafe(maxQuery);
      const maxId = parseInt(maxResult[0]?.max_id || 0, 10);

      // Reset the sequence to max_id + 1 (or 1 if table is empty)
      // Use setval with false to set the current value without incrementing
      const nextVal = maxId > 0 ? maxId + 1 : 1;
      await pgSql.unsafe(`SELECT setval('${sequence}', ${nextVal}, false)`);
      console.log(`  ${table}: Reset sequence ${sequence} to ${nextVal}`);
    } catch (error) {
      // If sequence doesn't exist yet, that's okay - it will be created on first insert
      console.warn(`  ${table}: Could not reset sequence ${sequence}: ${error.message}`);
    }
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
