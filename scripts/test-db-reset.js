#!/usr/bin/env bun

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
import fs from 'fs';

dotenv.config();

// Match the docker-vs-local host detection in src/utils/database/connection.js:
// inside the app container postgres is the "postgres" compose service, not localhost
const isInDocker = fs.existsSync('/.dockerenv');
const host =
  process.env.TEST_POSTGRES_HOST ||
  (isInDocker ? process.env.POSTGRES_HOST || 'postgres' : 'localhost');
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

async function ensureRoleExists() {
  // Probe with the configured role first; the common case is that docker-compose
  // already provisioned it and this is a single cheap SELECT.
  const probe = postgres({ ...connectionOptions, database: 'postgres' });
  let probeError;
  try {
    await probe`SELECT 1`;
    return;
  } catch (error) {
    // 28000 = role does not exist (trust auth), 28P01 = password auth failed —
    // scram/md5 servers report a missing role as a password failure on purpose,
    // so both need the pg_roles check below to tell "missing" from "wrong password".
    if (error.code !== '28000' && error.code !== '28P01') {
      throw error;
    }
    probeError = error;
  } finally {
    await probe.end();
  }

  // Fresh machine without the compose-provisioned role: create it via the admin
  // role (default "postgres", which works on trust-auth local installs).
  const adminUser = process.env.TEST_POSTGRES_ADMIN_USER || 'postgres';
  const adminPassword = process.env.TEST_POSTGRES_ADMIN_PASSWORD || '';
  const admin = postgres({
    ...connectionOptions,
    username: adminUser,
    password: adminPassword,
    database: 'postgres',
  });
  try {
    const exists = await admin`SELECT 1 FROM pg_roles WHERE rolname = ${username}`;
    if (exists.length > 0) {
      // Role is there — the probe failure was a genuine auth problem, not a
      // missing role. Surface the original error.
      throw probeError;
    }
    console.log(`[test-db-reset] Role "${username}" missing, creating it as "${adminUser}"`);
    const quotedRole = `"${username.replace(/"/g, '""')}"`;
    const quotedPassword = `'${password.replace(/'/g, "''")}'`;
    // SUPERUSER to match the role docker-compose provisions (POSTGRES_USER of the
    // container); the reset/create-database steps below rely on those privileges.
    await admin.unsafe(`CREATE ROLE ${quotedRole} LOGIN SUPERUSER PASSWORD ${quotedPassword}`);
  } finally {
    await admin.end();
  }
}

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
  await ensureRoleExists();
  await ensureDatabaseExists();
  await resetSchema();
  await precreateTables();
} catch (error) {
  console.error(`[test-db-reset] Failed to reset test database "${database}": ${error.message}`);
  console.error(
    '[test-db-reset] Is PostgreSQL running? (docker compose up -d postgres, or check TEST_POSTGRES_* env vars)'
  );
  console.error(
    `[test-db-reset] If the "${username}" role is missing and auto-creation failed, set TEST_POSTGRES_ADMIN_USER/TEST_POSTGRES_ADMIN_PASSWORD to a role that can CREATE ROLE`
  );
  process.exit(1);
}
