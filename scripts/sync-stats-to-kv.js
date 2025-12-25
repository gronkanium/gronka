import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Load environment variables from .env file if it exists
// Inside Docker, .env may not be mounted, so we rely on environment variables
// that docker-compose.yml sets (which reads from host .env)
const envPath = path.join(projectRoot, '.env');
try {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
} catch (_error) {
  // .env file doesn't exist or can't be read, that's okay
  // Environment variables may be set by docker-compose.yml or system
}

// FORCE PRODUCTION MODE - this script must ALWAYS use production database
// This ensures public website stats show real production data, never test data
process.env.FORCE_PRODUCTION_MODE = 'true';

// Map PROD_ prefixed environment variables to standard names
// Inside Docker, variables may already be set as standard names (from docker-compose.yml)
// So we only map PROD_* if standard name is not already set
const envPrefix = 'PROD_';
const prefixMappings = [
  'POSTGRES_HOST',
  'POSTGRES_PORT',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
  'DATABASE_URL',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_KV_NAMESPACE_ID',
  'CLOUDFLARE_PAGES_PROJECT_NAME',
];

for (const key of prefixMappings) {
  const prefixedKey = `${envPrefix}${key}`;
  // Only map PROD_* to standard name if standard name is not already set
  // This allows docker-compose.yml to set standard names directly
  if (process.env[prefixedKey] !== undefined && process.env[key] === undefined) {
    process.env[key] = process.env[prefixedKey];
  }
}

console.log('[kv:sync-stats] Using PROD_ environment variables (FORCE_PRODUCTION_MODE=true)');
console.log(
  `[kv:sync-stats] Database: ${process.env.POSTGRES_DB || 'default'} @ ${process.env.POSTGRES_HOST || 'localhost'}`
);

// Configuration
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_KV_NAMESPACE_ID = process.env.CLOUDFLARE_KV_NAMESPACE_ID;
const CLOUDFLARE_PAGES_PROJECT_NAME = process.env.CLOUDFLARE_PAGES_PROJECT_NAME;

const KV_KEY = 'stats:24h';
const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * Validate required environment variables
 */
function validateConfig() {
  const missing = [];
  if (!CLOUDFLARE_API_TOKEN) missing.push('CLOUDFLARE_API_TOKEN');
  if (!CLOUDFLARE_ACCOUNT_ID) missing.push('CLOUDFLARE_ACCOUNT_ID');
  if (!CLOUDFLARE_KV_NAMESPACE_ID) missing.push('CLOUDFLARE_KV_NAMESPACE_ID');
  if (!CLOUDFLARE_PAGES_PROJECT_NAME) missing.push('CLOUDFLARE_PAGES_PROJECT_NAME');

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

/**
 * Get Cloudflare API headers
 */
function getApiHeaders() {
  return {
    Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Read stats from KV
 * @returns {Promise<Object|null>} Stats object or null if not found
 */
async function readStatsFromKV() {
  try {
    const url = `${CLOUDFLARE_API_BASE}/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${KV_KEY}`;
    const response = await axios.get(url, {
      headers: getApiHeaders(),
      timeout: 10000,
    });

    if (response.status === 200 && response.data) {
      return typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
    }
    return null;
  } catch (error) {
    if (error.response?.status === 404) {
      // Key doesn't exist yet, that's okay
      return null;
    }
    throw new Error(`Failed to read from KV: ${error.message}`);
  }
}

/**
 * Write stats to KV
 * @param {Object} stats - Stats object to write
 * @param {Function} formatFileSize - Function to format file sizes
 * @returns {Promise<void>}
 */
async function writeStatsToKV(stats, formatFileSize) {
  const url = `${CLOUDFLARE_API_BASE}/accounts/${CLOUDFLARE_ACCOUNT_ID}/storage/kv/namespaces/${CLOUDFLARE_KV_NAMESPACE_ID}/values/${KV_KEY}`;

  const statsData = {
    success: true,
    data: {
      unique_users: stats.unique_users,
      total_files: stats.total_files,
      total_data_bytes: stats.total_data_bytes,
      total_data_formatted: formatFileSize(stats.total_data_bytes),
      period: '24 hours',
    },
    updated_at: stats.timestamp,
  };

  try {
    await axios.put(url, JSON.stringify(statsData), {
      headers: getApiHeaders(),
      timeout: 10000,
    });
    console.log('      ✓ Stats written successfully');
  } catch (error) {
    throw new Error(`Failed to write to KV: ${error.message}`);
  }
}

/**
 * Compare two stats objects to see if they differ
 * @param {Object} stats1 - First stats object
 * @param {Object} stats2 - Second stats object
 * @returns {boolean} True if stats differ
 */
function statsChanged(stats1, stats2) {
  if (!stats1 || !stats2) return true;

  // Compare key fields
  return (
    stats1.unique_users !== stats2.unique_users ||
    stats1.total_files !== stats2.total_files ||
    stats1.total_data_bytes !== stats2.total_data_bytes
  );
}

/**
 * Trigger Cloudflare Pages rebuild
 * @returns {Promise<void>}
 */
async function triggerPagesRebuild() {
  try {
    // First, get the project to find its ID
    const projectsUrl = `${CLOUDFLARE_API_BASE}/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${CLOUDFLARE_PAGES_PROJECT_NAME}`;
    const projectResponse = await axios.get(projectsUrl, {
      headers: getApiHeaders(),
      timeout: 10000,
    });

    if (projectResponse.status !== 200) {
      throw new Error(`Failed to get project: ${projectResponse.status}`);
    }

    // Trigger a new deployment
    const deployUrl = `${CLOUDFLARE_API_BASE}/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${CLOUDFLARE_PAGES_PROJECT_NAME}/deployments`;
    const deployResponse = await axios.post(
      deployUrl,
      {
        branch: 'main',
      },
      {
        headers: getApiHeaders(),
        timeout: 30000,
      }
    );

    if (deployResponse.status === 200 || deployResponse.status === 201) {
      console.log('      ✓ Rebuild triggered successfully');
      return;
    }

    throw new Error(`Unexpected response status: ${deployResponse.status}`);
  } catch (error) {
    if (error.response?.status === 404) {
      throw new Error(
        `Project "${CLOUDFLARE_PAGES_PROJECT_NAME}" not found. Check CLOUDFLARE_PAGES_PROJECT_NAME.`
      );
    }
    throw new Error(`Failed to trigger rebuild: ${error.message}`);
  }
}

/**
 * Main function
 */
async function main() {
  try {
    console.log('='.repeat(60));
    console.log('Syncing stats to Cloudflare KV (PRODUCTION DATA ONLY)');
    console.log('='.repeat(60));

    // Check for force rebuild flag
    const forceRebuild = process.env.FORCE_REBUILD === 'true' || process.env.FORCE_REBUILD === '1';
    if (forceRebuild) {
      console.log('\n[FORCE_REBUILD] enabled - will trigger rebuild even if stats unchanged');
    }

    // Validate configuration
    validateConfig();

    // Dynamically import database modules AFTER FORCE_PRODUCTION_MODE is set
    // This ensures the connection is made in production mode
    const { get24HourStats } = await import('../src/utils/database/stats.js');
    const { formatFileSize } = await import('../src/utils/storage.js');

    // Fetch current stats from database
    console.log('\n[1/4] Fetching stats from production database...');
    console.log(`      Database: ${process.env.POSTGRES_DB || 'default'}`);
    console.log(
      `      Host: ${process.env.POSTGRES_HOST || 'localhost'}:${process.env.POSTGRES_PORT || '5432'}`
    );
    const currentStats = await get24HourStats();

    if (!currentStats) {
      throw new Error('Failed to fetch stats from database');
    }

    console.log(`      ✓ Fetched successfully`);
    console.log(
      `      Stats: ${currentStats.unique_users} users, ${currentStats.total_files} files, ${formatFileSize(currentStats.total_data_bytes)}`
    );

    // Read existing stats from KV
    console.log('\n[2/4] Reading existing stats from Cloudflare KV...');
    const kvStats = await readStatsFromKV();

    if (kvStats && kvStats.data) {
      const existingStats = {
        unique_users: kvStats.data.unique_users || 0,
        total_files: kvStats.data.total_files || 0,
        total_data_bytes: kvStats.data.total_data_bytes || 0,
      };

      console.log(`      ✓ Found existing KV stats`);
      console.log(
        `      KV stats: ${existingStats.unique_users} users, ${existingStats.total_files} files, ${formatFileSize(existingStats.total_data_bytes)}`
      );

      // Check if stats have changed
      if (!statsChanged(currentStats, existingStats)) {
        if (!forceRebuild) {
          console.log('\n      → Stats unchanged, skipping KV write and rebuild');
          console.log('='.repeat(60));
          process.exit(0);
        } else {
          console.log(
            '\n      → Stats unchanged, but FORCE_REBUILD is enabled - will update KV and trigger rebuild'
          );
        }
      } else {
        console.log('      → Stats have changed, will update KV and trigger rebuild');
      }
    } else {
      console.log('      ✓ No existing stats in KV, will write initial stats');
    }

    // Write stats to KV
    console.log('\n[3/4] Writing updated stats to Cloudflare KV...');
    await writeStatsToKV(currentStats, formatFileSize);

    // Trigger rebuild
    console.log('\n[4/4] Triggering Cloudflare Pages rebuild...');
    await triggerPagesRebuild();

    console.log('\n' + '='.repeat(60));
    console.log('Stats sync completed successfully!');
    console.log('='.repeat(60));
    process.exit(0);
  } catch (error) {
    console.error('\n' + '='.repeat(60));
    console.error('ERROR syncing stats to KV:');
    console.error(error.message);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    console.error('='.repeat(60));
    process.exit(1);
  }
}

// Run the script
main();
