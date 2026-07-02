#!/usr/bin/env node

/**
 * Reset the test database schema before a test run.
 * Mirrors what CI does (DROP SCHEMA public CASCADE) so local runs start from
 * a clean slate instead of accumulating state across runs.
 *
 * Runs automatically via the npm "pretest" hook. Safe by construction: it
 * refuses to touch any database that doesn't contain "test" in its name.
 */

import dotenv from 'dotenv';
import postgres from 'postgres';

dotenv.config();

const host = process.env.TEST_POSTGRES_HOST || 'localhost';
const port = parseInt(process.env.TEST_POSTGRES_PORT || process.env.POSTGRES_PORT || '5432', 10);
const username = process.env.TEST_POSTGRES_USER || process.env.POSTGRES_USER || 'gronka';
const password = process.env.TEST_POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD || 'gronka';
const database = process.env.TEST_POSTGRES_DB || 'gronka_test';

if (!database.includes('test')) {
  console.error(
    `[test-db-reset] SAFETY: refusing to reset database "${database}" - test databases must contain "test" in their name`
  );
  process.exit(1);
}

const connectionOptions = {
  host,
  port,
  username,
  password,
  max: 1,
  idle_timeout: 1,
  connect_timeout: 5,
  onnotice: () => {},
};

async function ensureDatabaseExists() {
  // Connect to the maintenance database to create the test database if missing
  const admin = postgres({ ...connectionOptions, database: 'postgres' });
  try {
    const exists = await admin`SELECT 1 FROM pg_database WHERE datname = ${database}`;
    if (exists.length === 0) {
      console.log(`[test-db-reset] Creating missing test database "${database}"`);
      await admin.unsafe(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end();
  }
}

async function resetSchema() {
  const sql = postgres({ ...connectionOptions, database });
  try {
    await sql.unsafe('DROP SCHEMA IF EXISTS public CASCADE');
    await sql.unsafe('CREATE SCHEMA public');
    console.log(`[test-db-reset] Reset schema in "${database}" on ${host}:${port}`);
  } finally {
    await sql.end();
  }
}

async function precreateTables() {
  // Create all tables/indexes serially before the parallel test processes start.
  // CREATE TABLE IF NOT EXISTS races at the catalog level when ~30 processes hit
  // an empty schema simultaneously; pre-creating makes their CREATEs no-ops.
  process.env.TEST_POSTGRES_DB = database;
  const { initPostgresDatabase, closePostgresDatabase } =
    await import('../src/utils/database/init.js');
  await initPostgresDatabase();
  await closePostgresDatabase();
  console.log('[test-db-reset] Pre-created tables and indexes');
}

try {
  await ensureDatabaseExists();
  await resetSchema();
  await precreateTables();
} catch (error) {
  console.error(`[test-db-reset] Failed to reset test database "${database}": ${error.message}`);
  console.error(
    '[test-db-reset] Is PostgreSQL running? (docker compose up -d postgres, or check TEST_POSTGRES_* env vars)'
  );
  process.exit(1);
}
