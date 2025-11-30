import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import axios from 'axios';
import { get24HourStats } from '../src/utils/database/stats.js';
import { formatFileSize } from '../src/utils/storage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Load environment variables
dotenv.config({ path: path.join(projectRoot, '.env') });

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
 * @returns {Promise<void>}
 */
async function writeStatsToKV(stats) {
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
    console.log('Stats written to KV successfully');
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
      console.log('Cloudflare Pages rebuild triggered successfully');
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
    console.log('Syncing stats to Cloudflare KV...');

    // Validate configuration
    validateConfig();

    // Fetch current stats from database
    console.log('Fetching stats from database...');
    const currentStats = await get24HourStats();

    if (!currentStats) {
      throw new Error('Failed to fetch stats from database');
    }

    console.log(
      `Current stats: ${currentStats.unique_users} users, ${currentStats.total_files} files, ${formatFileSize(currentStats.total_data_bytes)}`
    );

    // Read existing stats from KV
    console.log('Reading stats from KV...');
    const kvStats = await readStatsFromKV();

    if (kvStats && kvStats.data) {
      const existingStats = {
        unique_users: kvStats.data.unique_users || 0,
        total_files: kvStats.data.total_files || 0,
        total_data_bytes: kvStats.data.total_data_bytes || 0,
      };

      console.log(
        `KV stats: ${existingStats.unique_users} users, ${existingStats.total_files} files, ${formatFileSize(existingStats.total_data_bytes)}`
      );

      // Check if stats have changed
      if (!statsChanged(currentStats, existingStats)) {
        console.log('Stats unchanged, skipping KV write and rebuild');
        process.exit(0);
      }

      console.log('Stats have changed, updating KV and triggering rebuild...');
    } else {
      console.log('No existing stats in KV, writing initial stats...');
    }

    // Write stats to KV
    await writeStatsToKV(currentStats);

    // Trigger rebuild
    await triggerPagesRebuild();

    console.log('Stats sync completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Error syncing stats to KV:', error.message);
    process.exit(1);
  }
}

// Run the script
main();
