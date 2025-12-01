#!/usr/bin/env node

/**
 * Reset PostgreSQL SERIAL sequences to match existing data
 * This fixes duplicate key errors after data migration
 *
 * Usage:
 *   node scripts/reset-postgres-sequences.js
 */

import postgres from 'postgres';
import dotenv from 'dotenv';

dotenv.config();

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

/**
 * Reset SERIAL sequences to match the maximum ID in each table
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

  console.log('Resetting SERIAL sequences...\n');

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
      console.log(`  ✓ ${table}: Reset sequence ${sequence} to ${nextVal} (max ID was ${maxId})`);
    } catch (error) {
      // If sequence doesn't exist yet, that's okay - it will be created on first insert
      console.warn(`  ✗ ${table}: Could not reset sequence ${sequence}: ${error.message}`);
    }
  }

  console.log('\nSequence reset completed!');
}

async function main() {
  try {
    const config = getPostgresConfig();
    console.log(
      `Connecting to PostgreSQL at ${config.host || 'DATABASE_URL'}:${config.port || 'N/A'}/${config.database || 'N/A'}...`
    );

    const pgSql = postgres(config);

    // Test connection
    await pgSql`SELECT 1`;
    console.log('Connected successfully.\n');

    // Reset sequences
    await resetSerialSequences(pgSql);

    await pgSql.end();
    console.log('\nDone!');
  } catch (error) {
    console.error('\nError:', error.message);
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
