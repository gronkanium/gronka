#!/usr/bin/env node

import { execSync } from 'child_process';
import { readFileSync, existsSync, unlinkSync, rmSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { r2Config } from '../src/utils/config.js';
import { listObjectsInR2, deleteFromR2 } from '../src/utils/r2-storage.js';
import { createInterface } from 'readline';
import postgres from 'postgres';
import { getPostgresConfig } from '../src/utils/database/connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');
const pidFile = join(projectRoot, '.local-dev-pids.json');

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || args.includes('-n');
const skipConfirm = args.includes('--yes') || args.includes('-y');
const stopDocker = args.includes('--stop-docker') || args.includes('-d');

// Directories to delete
const dataDirs = ['data-prod', 'data-test', 'temp', 'logs'];

/**
 * Check if Docker containers are running
 */
function checkDockerContainers() {
  try {
    // Try JSON format first (newer docker compose)
    let output;
    try {
      output = execSync('docker compose ps --format json', {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      // Fallback to default format (older docker compose)
      output = execSync('docker compose ps', {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    }

    if (!output || output.trim() === '') {
      return { running: false, containers: [] };
    }

    const lines = output
      .trim()
      .split('\n')
      .filter(line => line.trim());
    const containers = [];

    // Try parsing as JSON (newer format)
    if (lines[0] && lines[0].startsWith('{')) {
      for (const line of lines) {
        try {
          const container = JSON.parse(line);
          if (container.State === 'running' || container.State === 'restarting') {
            containers.push({
              name: container.Name,
              state: container.State,
            });
          }
        } catch {
          // Skip invalid JSON lines
        }
      }
    } else {
      // Parse default format (older format)
      // Skip header line and empty lines
      for (const line of lines.slice(1)) {
        if (!line.trim() || line.includes('NAME') || line.includes('---')) {
          continue;
        }
        // Look for "running" or "restarting" status
        if (line.toLowerCase().includes('running') || line.toLowerCase().includes('restarting')) {
          const parts = line.split(/\s+/);
          const name = parts[0];
          if (name && name !== 'NAME') {
            containers.push({
              name,
              state: line.toLowerCase().includes('running') ? 'running' : 'restarting',
            });
          }
        }
      }
    }

    return {
      running: containers.length > 0,
      containers,
    };
  } catch (error) {
    // Docker might not be available or docker compose might fail
    // Return false to indicate we can't determine status
    return { running: false, containers: [], error: error.message };
  }
}

/**
 * Stop Docker containers
 */
function stopDockerContainers() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('stopping docker containers...\n');

  if (dryRun) {
    console.log('  [DRY RUN] would run: docker compose down');
    return;
  }

  try {
    console.log('  running: docker compose down');
    execSync('docker compose down', {
      cwd: projectRoot,
      stdio: 'inherit',
    });
    console.log('  docker containers stopped');
  } catch (error) {
    console.warn(`  warning: failed to stop docker containers: ${error.message}`);
    console.warn('  you may need to manually run: docker compose down');
  }
}

/**
 * Stop running bot/server processes
 */
async function stopProcesses() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('stopping running processes...\n');

  if (!existsSync(pidFile)) {
    console.log('  no running services found (no PID file)');
    return;
  }

  if (dryRun) {
    console.log('  [DRY RUN] would stop processes from', pidFile);
    return;
  }

  let pids;
  try {
    pids = JSON.parse(readFileSync(pidFile, 'utf8'));
  } catch (error) {
    console.warn(`  warning: could not read PID file: ${error.message}`);
    try {
      unlinkSync(pidFile);
    } catch {
      // Ignore
    }
    return;
  }

  // Stop all processes
  let stopped = 0;
  for (const [name, pid] of Object.entries(pids)) {
    try {
      console.log(`  stopping ${name} (PID: ${pid})...`);
      if (process.platform === 'win32') {
        execSync(`taskkill /PID ${pid} /F /T 2>nul`, { stdio: 'ignore' });
      } else {
        try {
          process.kill(pid, 'SIGTERM');
          // Wait a bit, then force kill if still running
          setTimeout(() => {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              // Process already dead
            }
          }, 2000);
        } catch {
          // Process may already be dead
        }
      }
      console.log(`    ${name} stopped`);
      stopped++;
    } catch (error) {
      console.warn(`    warning: could not stop ${name}: ${error.message}`);
    }
  }

  // Remove PID file
  try {
    unlinkSync(pidFile);
  } catch {
    // Ignore if file doesn't exist
  }

  console.log(`\n  stopped ${stopped} service(s)`);
}

/**
 * Delete a directory recursively
 */
function deleteDirectory(dirPath) {
  if (!existsSync(dirPath)) {
    return { deleted: false, reason: 'does not exist' };
  }

  try {
    const stats = statSync(dirPath);
    if (!stats.isDirectory()) {
      return { deleted: false, reason: 'exists but is not a directory' };
    }

    if (dryRun) {
      return { deleted: true, reason: 'dry run' };
    }

    rmSync(dirPath, { recursive: true, force: true });
    return { deleted: true };
  } catch (error) {
    return { deleted: false, reason: error.message };
  }
}

/**
 * Delete local data directories
 */
function deleteLocalData() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('deleting local data directories...\n');

  const results = [];

  for (const dir of dataDirs) {
    const dirPath = join(projectRoot, dir);
    const exists = existsSync(dirPath);
    const result = deleteDirectory(dirPath);

    if (dryRun) {
      if (exists) {
        console.log(`  [DRY RUN] would delete: ${dir}/`);
        results.push({ dir, deleted: true, reason: 'dry run' });
      } else {
        console.log(`  [DRY RUN] would skip (does not exist): ${dir}/`);
        results.push({ dir, deleted: false, reason: 'does not exist' });
      }
    } else {
      if (result.deleted) {
        console.log(`  deleted: ${dir}/`);
        results.push({ dir, deleted: true });
      } else {
        console.log(`  skipped: ${dir}/ (${result.reason})`);
        results.push({ dir, deleted: false, reason: result.reason });
      }
    }
  }

  const deletedCount = results.filter(r => r.deleted).length;
  console.log(
    `\n  ${deletedCount} of ${dataDirs.length} directory(ies) ${dryRun ? 'would be ' : ''}deleted`
  );

  return results;
}

/**
 * Check if PostgreSQL is configured
 */
function isPostgresConfigured() {
  // Check if DATABASE_TYPE is explicitly set to postgres
  if (process.env.DATABASE_TYPE === 'postgres') {
    return true;
  }

  // Check for DATABASE_URL
  if (process.env.DATABASE_URL) {
    return true;
  }

  // Check for individual PostgreSQL connection parameters
  // At minimum, we need host and database to be configured
  const hasHost = process.env.POSTGRES_HOST;
  const hasDb = process.env.POSTGRES_DB;

  // Also check for TEST_ and PROD_ prefixed vars
  const hasTestHost = process.env.TEST_POSTGRES_HOST;
  const hasTestDb = process.env.TEST_POSTGRES_DB;
  const hasProdHost = process.env.PROD_POSTGRES_HOST;
  const hasProdDb = process.env.PROD_POSTGRES_DB;

  return !!(hasHost && hasDb) || !!(hasTestHost && hasTestDb) || !!(hasProdHost && hasProdDb);
}

/**
 * Check if R2 is configured
 */
function isR2Configured() {
  return !!(
    r2Config.accountId &&
    r2Config.accessKeyId &&
    r2Config.secretAccessKey &&
    r2Config.bucketName
  );
}

/**
 * Get all R2 objects (across all prefixes)
 */
async function getAllR2Objects() {
  const prefixes = ['gifs/', 'videos/', 'images/'];
  const allObjects = [];

  for (const prefix of prefixes) {
    try {
      const objects = await listObjectsInR2(prefix, r2Config);
      allObjects.push(...objects);
    } catch (error) {
      console.warn(`  warning: failed to list objects with prefix "${prefix}": ${error.message}`);
    }
  }

  // Also check for objects at root level (no prefix)
  try {
    const rootObjects = await listObjectsInR2('', r2Config);
    // Filter out directory markers (objects ending with /)
    const files = rootObjects.filter(obj => !obj.key.endsWith('/'));
    allObjects.push(...files);
  } catch (error) {
    console.warn(`  warning: failed to list root objects: ${error.message}`);
  }

  return allObjects;
}

/**
 * Wipe PostgreSQL database by dropping all tables
 */
async function wipePostgresDatabase() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('wiping postgresql database...\n');

  if (!isPostgresConfigured()) {
    console.log(
      '  postgresql is not configured (DATABASE_TYPE not set to postgres or missing connection vars)'
    );
    console.log('  skipping postgresql cleanup');
    return { wiped: false, reason: 'not configured', tablesDropped: 0 };
  }

  let sql = null;
  try {
    // Get PostgreSQL configuration
    const config = getPostgresConfig();
    const dbName =
      typeof config === 'string'
        ? config.match(/\/\/(?:[^:]+:)?[^@]+@[^/]+\/([^?]+)/)?.[1] || 'unknown'
        : config.database || 'unknown';

    console.log(`  database: ${dbName}`);

    if (dryRun) {
      console.log('  [DRY RUN] would connect and drop all tables');
      return { wiped: true, reason: 'dry run', tablesDropped: 8, dryRun: true };
    }

    // Connect to PostgreSQL
    console.log('  connecting to postgresql...');
    sql = postgres(config);

    // Test connection
    await sql`SELECT 1`;
    console.log('  connected successfully\n');

    // List of tables to drop (in order to respect foreign key constraints)
    // Using CASCADE to automatically drop dependent objects
    const tables = [
      'temporary_uploads',
      'alerts',
      'system_metrics',
      'operation_logs',
      'user_metrics',
      'processed_urls',
      'logs',
      'users',
    ];

    let dropped = 0;
    let failed = 0;

    for (const table of tables) {
      try {
        // Check if table exists before dropping
        const tableExists = await sql`
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name = ${table}
          )
        `;

        if (tableExists[0]?.exists) {
          await sql.unsafe(`DROP TABLE IF EXISTS ${table} CASCADE`);
          console.log(`  dropped table: ${table}`);
          dropped++;
        } else {
          console.log(`  skipped table: ${table} (does not exist)`);
        }
      } catch (error) {
        console.warn(`  warning: failed to drop table ${table}: ${error.message}`);
        failed++;
      }
    }

    console.log(`\n  postgresql cleanup complete: ${dropped} table(s) dropped`);

    if (failed > 0) {
      console.warn(`  warning: ${failed} table(s) failed to drop`);
    }

    return { wiped: true, tablesDropped: dropped, tablesFailed: failed };
  } catch (error) {
    console.warn(`  warning: failed to connect to postgresql: ${error.message}`);
    console.warn('  skipping postgresql cleanup');
    return { wiped: false, reason: error.message, tablesDropped: 0 };
  } finally {
    // Close connection if it was opened
    if (sql) {
      try {
        await sql.end({ timeout: 5 });
      } catch {
        // Ignore errors when closing
      }
    }
  }
}

/**
 * Delete all R2 objects
 */
async function deleteR2Objects() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('clearing r2 bucket...\n');

  if (!isR2Configured()) {
    console.log('  r2 is not configured (missing credentials or bucket name)');
    console.log('  skipping r2 cleanup');
    return { deleted: 0, failed: 0, total: 0 };
  }

  console.log(`  bucket: ${r2Config.bucketName}`);
  console.log(`  account: ${r2Config.accountId}\n`);

  // List all objects
  console.log('  listing all objects in r2 bucket...');
  const objects = await getAllR2Objects();
  const total = objects.length;

  if (total === 0) {
    console.log('  no objects found in r2 bucket');
    return { deleted: 0, failed: 0, total: 0 };
  }

  console.log(`  found ${total} object(s) to delete\n`);

  if (dryRun) {
    console.log('  [DRY RUN] would delete the following objects:');
    objects.slice(0, 10).forEach(obj => {
      console.log(`    - ${obj.key} (${(obj.size / 1024).toFixed(2)} KB)`);
    });
    if (objects.length > 10) {
      console.log(`    ... and ${objects.length - 10} more`);
    }
    return { deleted: total, failed: 0, total, dryRun: true };
  }

  // Delete in batches to avoid rate limits
  const batchSize = 50;
  let deleted = 0;
  let failed = 0;
  const failedKeys = [];

  for (let i = 0; i < objects.length; i += batchSize) {
    const batch = objects.slice(i, i + batchSize);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(objects.length / batchSize);

    console.log(`  deleting batch ${batchNum}/${totalBatches} (${batch.length} objects)...`);

    for (const obj of batch) {
      try {
        const success = await deleteFromR2(obj.key, r2Config);
        if (success) {
          deleted++;
        } else {
          failed++;
          failedKeys.push(obj.key);
        }
      } catch (error) {
        console.warn(`    warning: failed to delete ${obj.key}: ${error.message}`);
        failed++;
        failedKeys.push(obj.key);
      }
    }

    // Show progress
    const progress = (((i + batch.length) / objects.length) * 100).toFixed(1);
    console.log(`    progress: ${deleted} deleted, ${failed} failed (${progress}%)`);
  }

  console.log(`\n  r2 cleanup complete: ${deleted} deleted, ${failed} failed`);

  if (failedKeys.length > 0 && failedKeys.length <= 10) {
    console.log('\n  failed to delete:');
    failedKeys.forEach(key => console.log(`    - ${key}`));
  } else if (failedKeys.length > 10) {
    console.log(`\n  ${failedKeys.length} objects failed to delete (first 10 shown):`);
    failedKeys.slice(0, 10).forEach(key => console.log(`    - ${key}`));
  }

  return { deleted, failed, total, failedKeys };
}

/**
 * Prompt user for confirmation
 */
function askConfirmation(question) {
  return new Promise(resolve => {
    if (skipConfirm) {
      resolve(true);
      return;
    }

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(question, answer => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

/**
 * Main reset function
 */
async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('gronka clean slate reset');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (dryRun) {
    console.log('\n⚠️  DRY RUN MODE - no changes will be made\n');
  }

  console.log('\nthis will delete:');
  console.log('  - all local data directories (data-prod/, data-test/, temp/, logs/)');
  console.log('  - sqlite database files (included in data directories)');
  console.log('  - postgresql database tables (if configured)');
  console.log('  - all files in r2 bucket (if configured)');
  console.log('  - stop any running bot/server processes');
  console.log('\nthis will preserve:');
  console.log('  - .env file (configuration and credentials)');
  console.log('  - codebase and dependencies');
  console.log('  - r2 bucket itself (only contents deleted)');
  console.log('  - postgresql database itself (only tables deleted)');

  // Get summary of what will be deleted
  const localDirsSummary = dataDirs
    .map(dir => {
      const dirPath = join(projectRoot, dir);
      return existsSync(dirPath) ? dir : null;
    })
    .filter(Boolean);

  // Check Docker containers
  const dockerStatus = checkDockerContainers();

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('summary:');
  console.log(
    `  local directories to delete: ${localDirsSummary.length} (${localDirsSummary.join(', ')})`
  );

  if (isPostgresConfigured()) {
    console.log('  postgresql database: will drop all tables');
  } else {
    console.log('  postgresql database: not configured (skipped)');
  }

  if (isR2Configured()) {
    console.log(`  r2 bucket: ${r2Config.bucketName} (will list objects to get count)`);
  } else {
    console.log('  r2 bucket: not configured (skipped)');
  }

  if (existsSync(pidFile)) {
    console.log('  running processes: will be stopped');
  } else {
    console.log('  running processes: none found');
  }

  if (dockerStatus.running) {
    console.log(
      `  docker containers: ${dockerStatus.containers.length} running (${dockerStatus.containers.map(c => c.name).join(', ')})`
    );
    if (!stopDocker) {
      console.log(
        '\n  ⚠️  warning: docker containers are running and may have data directories mounted'
      );
      console.log('  this could prevent deletion of data directories');
      console.log('  use --stop-docker flag to automatically stop containers, or run:');
      console.log('    docker compose down');
    }
  } else {
    console.log('  docker containers: none running');
  }

  // Confirmation
  if (!dryRun) {
    const confirmed = await askConfirmation('\n⚠️  are you sure you want to proceed? (yes/no): ');
    if (!confirmed) {
      console.log('\nreset cancelled');
      process.exit(0);
    }
  }

  // Stop Docker containers if requested or if they're running
  if (dockerStatus.running) {
    if (stopDocker) {
      stopDockerContainers();
    } else {
      console.log('\n⚠️  warning: docker containers are still running');
      console.log('  data directories may be locked and deletion may fail');
      console.log('  consider stopping them first: docker compose down');
      const proceed = await askConfirmation('  proceed anyway? (yes/no): ');
      if (!proceed) {
        console.log('\nreset cancelled');
        console.log('  run with --stop-docker to automatically stop containers');
        process.exit(0);
      }
    }
  }

  // Stop processes
  await stopProcesses();

  // Wipe PostgreSQL database
  const postgresResults = await wipePostgresDatabase();

  // Delete local data (includes SQLite database files)
  const localResults = deleteLocalData();

  // Delete R2 objects
  const r2Results = await deleteR2Objects();

  // Final summary
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('reset complete');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (dryRun) {
    console.log('\n[DRY RUN] no changes were made');
  } else {
    const localDeleted = localResults.filter(r => r.deleted).length;
    console.log(
      `\nlocal data (sqlite): ${localDeleted} of ${dataDirs.length} directory(ies) deleted`
    );

    if (postgresResults.wiped) {
      if (postgresResults.dryRun) {
        console.log('postgresql database: [DRY RUN] would drop all tables');
      } else {
        console.log(`postgresql database: ${postgresResults.tablesDropped} table(s) dropped`);
        if (postgresResults.tablesFailed && postgresResults.tablesFailed > 0) {
          console.log(`  (${postgresResults.tablesFailed} failed - check logs above)`);
        }
      }
    } else {
      console.log(`postgresql database: skipped (${postgresResults.reason})`);
    }

    if (r2Results.total > 0) {
      console.log(`r2 storage: ${r2Results.deleted} of ${r2Results.total} object(s) deleted`);
      if (r2Results.failed > 0) {
        console.log(`  (${r2Results.failed} failed - check logs above)`);
      }
    } else {
      console.log('r2 storage: skipped (not configured or empty)');
    }
  }

  console.log('\nclean slate reset complete!');

  if (dockerStatus.running && stopDocker) {
    console.log('\nnote: docker containers were stopped during reset');
    console.log('  to restart them, run: docker compose up -d');
    console.log('  or: npm run docker:reload');
  }
}

// Run main function
main().catch(error => {
  console.error('\n❌ error during reset:', error);
  process.exit(1);
});
