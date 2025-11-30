import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Load environment variables
dotenv.config({ path: path.join(projectRoot, '.env') });

// Configuration
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_KV_NAMESPACE_ID = process.env.CLOUDFLARE_KV_NAMESPACE_ID;

const KV_KEY = 'stats:24h';
const DATA_DIR = path.join(projectRoot, '_data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * Format file size for display
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size
 */
function formatFileSize(bytes) {
  if (bytes === 0) return '0.00 MB';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Get Cloudflare API headers
 */
function getApiHeaders() {
  if (!CLOUDFLARE_API_TOKEN) {
    throw new Error('CLOUDFLARE_API_TOKEN is required');
  }
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
  if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_KV_NAMESPACE_ID) {
    console.warn('Cloudflare KV configuration missing, using default stats');
    return null;
  }

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
      console.warn('Stats not found in KV, using default stats');
      return null;
    }
    console.warn(`Failed to read from KV: ${error.message}, using default stats`);
    return null;
  }
}

/**
 * Get default stats
 * @returns {Object} Default stats object
 */
function getDefaultStats() {
  return {
    unique_users: 0,
    total_files: 0,
    total_data_bytes: 0,
    total_data_formatted: '0.00 MB',
    period: '24 hours',
    last_updated: Date.now(),
  };
}

/**
 * Convert KV stats format to Jekyll format
 * @param {Object} kvStats - Stats from KV
 * @returns {Object} Stats in Jekyll format
 */
function convertToJekyllFormat(kvStats) {
  if (!kvStats || !kvStats.data) {
    return getDefaultStats();
  }

  const data = kvStats.data;
  return {
    unique_users: data.unique_users || 0,
    total_files: data.total_files || 0,
    total_data_bytes: data.total_data_bytes || 0,
    total_data_formatted: data.total_data_formatted || formatFileSize(data.total_data_bytes || 0),
    period: data.period || '24 hours',
    last_updated: kvStats.updated_at || Date.now(),
  };
}

/**
 * Write stats to JSON file
 * @param {Object} stats - Stats object to write
 * @returns {Promise<void>}
 */
async function writeStatsFile(stats) {
  try {
    // Ensure _data directory exists
    await fs.mkdir(DATA_DIR, { recursive: true });

    // Write stats to file
    const jsonContent = JSON.stringify(stats, null, 2);
    await fs.writeFile(STATS_FILE, jsonContent, 'utf8');
    console.log(`Stats written to ${STATS_FILE}`);
  } catch (error) {
    throw new Error(`Failed to write stats file: ${error.message}`);
  }
}

/**
 * Main function
 */
async function main() {
  try {
    console.log('Fetching stats from Cloudflare KV...');

    // Read stats from KV
    const kvStats = await readStatsFromKV();

    // Convert to Jekyll format
    const jekyllStats = convertToJekyllFormat(kvStats);

    // Write to file
    await writeStatsFile(jekyllStats);

    console.log('Stats fetched successfully!');
    console.log(`  - Unique users: ${jekyllStats.unique_users}`);
    console.log(`  - Total files: ${jekyllStats.total_files}`);
    console.log(`  - Total data: ${jekyllStats.total_data_formatted}`);

    process.exit(0);
  } catch (error) {
    console.error('Error fetching stats from KV:', error.message);
    // Write default stats on error so build doesn't fail
    try {
      await writeStatsFile(getDefaultStats());
      console.log('Wrote default stats due to error');
    } catch (writeError) {
      console.error('Failed to write default stats:', writeError.message);
    }
    process.exit(1);
  }
}

// Run the script
main();
