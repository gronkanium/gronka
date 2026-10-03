#!/usr/bin/env bun

// Runs a test command against its own fresh database, dropped afterwards, so a run never sees
// another branch's schema or another worktree's rows: bun scripts/with-test-db.js <command...>

import dotenv from 'dotenv';
import postgres from 'postgres';
import fs from 'fs';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';

dotenv.config({ quiet: true });

const isInDocker = fs.existsSync('/.dockerenv');
const host =
  process.env.TEST_POSTGRES_HOST ||
  (isInDocker ? process.env.POSTGRES_HOST || 'postgres' : 'localhost');
const port = parseInt(process.env.TEST_POSTGRES_PORT || process.env.POSTGRES_PORT || '5432', 10);
const username = process.env.TEST_POSTGRES_USER || process.env.POSTGRES_USER || 'gronka';
const password = process.env.TEST_POSTGRES_PASSWORD || process.env.POSTGRES_PASSWORD || 'gronka';
const PREFIX = 'gronka_test_run_';
const database = `${PREFIX}${process.pid}_${randomBytes(3).toString('hex')}`;

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
    // 28000 = role does not exist (trust auth), 28P01 = password auth failed ,
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
      // Role is there, the probe failure was a genuine auth problem, not a
      // missing role. Surface the original error.
      throw probeError;
    }
    console.log(`[test-db] Role "${username}" missing, creating it as "${adminUser}"`);
    const quotedRole = `"${username.replace(/"/g, '""')}"`;
    const quotedPassword = `'${password.replace(/'/g, "''")}'`;
    // SUPERUSER to match the role docker-compose provisions (POSTGRES_USER of the
    // container); the reset/create-database steps below rely on those privileges.
    await admin.unsafe(`CREATE ROLE ${quotedRole} LOGIN SUPERUSER PASSWORD ${quotedPassword}`);
  } finally {
    await admin.end();
  }
}

async function admin(fn) {
  const sql = postgres({ ...connectionOptions, database: 'postgres' });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

const alive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

// Databases of runs that were killed before they could drop their own.
async function dropAbandoned(sql) {
  const rows = await sql`SELECT datname FROM pg_database WHERE starts_with(datname, ${PREFIX})`;
  for (const { datname } of rows) {
    const pid = Number(datname.slice(PREFIX.length).split('_')[0]);
    if (!alive(pid)) await sql.unsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
  }
}

// CREATE TABLE IF NOT EXISTS races at the catalog level when many test processes hit an empty
// schema at once, so the schema is built once, serially, before they start.
async function precreateTables() {
  const { initPostgresDatabase, closePostgresDatabase } =
    await import('../src/utils/database/init.js');
  await initPostgresDatabase();
  await closePostgresDatabase();
}

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error('usage: bun scripts/with-test-db.js <command...>');
  process.exit(2);
}

process.env.NODE_ENV = 'test';
process.env.TEST_POSTGRES_DB = database;
try {
  await ensureRoleExists();
  await admin(async sql => {
    await dropAbandoned(sql);
    await sql.unsafe(`CREATE DATABASE "${database}"`);
  });
  await precreateTables();
} catch (error) {
  console.error(`[test-db] Could not create a test database: ${error.message}`);
  console.error(
    '[test-db] Is PostgreSQL running? (docker compose up -d postgres, or check TEST_POSTGRES_* env vars)'
  );
  process.exit(1);
}

// Ctrl-C reaches the child too; wait for it so the database is still dropped.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {});
const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: process.env });
const code = await new Promise(resolve =>
  child.on('exit', (status, signal) => resolve(status ?? (signal ? 1 : 0)))
);
await admin(sql => sql.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)).catch(error =>
  console.error(`[test-db] Could not drop ${database}: ${error.message}`)
);
process.exit(code);
